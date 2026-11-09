import type { Pool } from "pg";
import { PostgresConnections, type ConnectionRepository, type OwnedConnection } from "./connections.js";
import { Dispatcher, type Send } from "./dispatch.js";
import type { ChannelHub } from "./hub.js";
import { PostgresInbox, type Inbox, type InboxItem } from "./inbox.js";
import { backoffMs, pollLoop } from "./loop.js";
import { PostgresOutbox, type Outbox } from "./outbox.js";
import type { AssistantChannels, ChatGateway, TargetHandler, TargetKind } from "./ports.js";
import { ChatReplies } from "./productTarget.js";
import { PostgresRateLimiter, type RateLimiter } from "./rateLimiter.js";
import { ChannelRouter } from "./router.js";
import { CHANNEL_KINDS, type ChannelAdapter, type ChannelKind, type InboundEvent, type PullNotice } from "./types.js";

/** Long enough for a file download to finish; a crashed process frees the event after this. */
const INBOX_LEASE_MS = 3 * 60_000;
const INBOX_ATTEMPTS = 5;
const COMPACTING = "正在整理对话，稍等一下。\nTidying up our conversation, one moment.";

export type ChannelStores = { connections: ConnectionRepository; inbox: Inbox; outbox: Outbox; limiter: RateLimiter };

export async function openChannelStores(pool: Pool, scopeOf: (ownerAccountId: string, channel: ChannelKind) => string): Promise<ChannelStores> {
  const connections = await PostgresConnections.open(pool, scopeOf);
  // Each table references hatch_connections, so it exists first.
  return { connections, inbox: await PostgresInbox.open(pool), outbox: await PostgresOutbox.open(pool), limiter: await PostgresRateLimiter.open(pool) };
}

export type ChannelStatus = { kind: ChannelKind; available: boolean; linked: boolean; state?: OwnedConnection["state"]; lastEventAt?: string };

/**
 * The channel layer: inbound events are stored, then routed to the Agent behind their Connection; replies are queued
 * and sent. It holds no platform knowledge (adapters do) and no Agent knowledge (target handlers do).
 */
export class ChannelService implements AssistantChannels {
  readonly connections: ConnectionRepository;
  readonly hub: ChannelHub;
  private inbox: Inbox;
  private router: ChannelRouter;
  private dispatcher: Dispatcher;
  private replies?: ChatReplies;
  private loops: Array<ReturnType<typeof pollLoop>> = [];
  private inboxLoop?: ReturnType<typeof pollLoop>;
  private outboxLoop?: ReturnType<typeof pollLoop>;

  constructor(private deps: ChannelStores & { hub: ChannelHub; scopeOf: (ownerAccountId: string, channel: ChannelKind) => string; gateway?: ChatGateway; now?: () => Date; rates?: ConstructorParameters<typeof Dispatcher>[0]["rates"]; onError?: (error: unknown) => void }) {
    this.connections = deps.connections;
    this.hub = deps.hub;
    this.inbox = deps.inbox;
    this.dispatcher = new Dispatcher({ outbox: deps.outbox, hub: deps.hub, limiter: deps.limiter, connections: deps.connections, inbox: deps.inbox, ...(deps.now ? { now: deps.now } : {}), ...(deps.rates ? { rates: deps.rates } : {}), onQueued: () => this.outboxLoop?.wake() });
    this.router = new ChannelRouter({
      hub: deps.hub, connections: deps.connections,
      notify: async (to, text, replyTo) => { await this.dispatcher.send({ ...to, kind: "notice", message: { text, ...(replyTo ? { replyTo } : {}) } }); },
    });
    if (deps.gateway) this.replies = new ChatReplies({ gateway: deps.gateway, inbox: deps.inbox, dispatcher: this.dispatcher, compacting: (runId, compactionId) => this.compaction({ runId, compactionId }) });
  }

  register(kind: TargetKind, handler: TargetHandler): this { this.router.register(kind, handler); return this; }

  /** Delivers one pass of each queue. The loops run this; tests call it directly. */
  async drain(): Promise<void> {
    while (await this.processInbox() > 0 || await this.dispatcher.step() > 0) { /* until both queues are idle */ }
    await this.replies?.sweep();
    while (await this.dispatcher.step() > 0) { /* replies the sweep queued */ }
  }

  start(): void {
    const onError = this.report;
    this.inboxLoop = pollLoop(() => this.processInbox(), { idleMs: 1000, onError });
    this.outboxLoop = pollLoop(() => this.dispatcher.step(), { idleMs: 1000, onError });
    this.loops = [this.inboxLoop, this.outboxLoop];
    if (this.replies) {
      const replies = this.replies;
      // Chat may be another process: a Run's end and its compactions are read from its durable state, not heard.
      this.loops.push(pollLoop(async () => { await replies.sweep(); return 0; }, { idleMs: 2_000, onError }));
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.loops.map(loop => loop.stop()));
  }

  /** Inbound, verified: stored before anything else, so the platform can be answered at once. */
  async accept(adapter: ChannelAdapter, events: InboundEvent[]): Promise<void> {
    if ((await this.inbox.store(adapter.kind, adapter.scope, events, this.deps.now?.())).length) this.inboxLoop?.wake();
  }

  /** After the platform is answered: fetch what a notification announced, and store it with the cursor in one step. A failed pull stores nothing, so the next notice pulls the same range; repeats are refused by event id. */
  async pull(adapter: ChannelAdapter, notice: PullNotice): Promise<void> {
    if (!adapter.pull) return;
    const { events, cursor } = await adapter.pull(notice, await this.inbox.cursor(adapter.kind, adapter.scope, notice.key));
    if ((await this.inbox.store(adapter.kind, adapter.scope, events, this.deps.now?.(), cursor ? { key: notice.key, cursor } : undefined)).length) this.inboxLoop?.wake();
  }

  private async processInbox(): Promise<number> {
    const items = await this.inbox.claim(10, INBOX_LEASE_MS, this.deps.now?.());
    await Promise.all(items.map(item => this.process(item)));
    return items.length;
  }

  private async process(item: InboxItem): Promise<void> {
    try { await this.inbox.complete(item.id, await this.router.route(item)); } catch (error) {
      await this.inbox.retry(item.id, error instanceof Error ? error.message : String(error), backoffMs(item.attempts), INBOX_ATTEMPTS, this.deps.now?.());
      this.report(error);
    }
  }

  private report = (error: unknown): void => this.deps.onError ? this.deps.onError(error) : console.error("[channels]", error instanceof Error ? error.message : error);

  // ── Studio ─────────────────────────────────────────────────────────────

  /** A connect code for Studio to show: the Expert sends it to us from the platform. */
  async connect(accountId: string, kind: ChannelKind): Promise<{ code: string; url?: string }> {
    const adapter = await this.deps.hub.get(kind, this.deps.scopeOf(accountId, kind));
    if (!adapter) throw Object.assign(new Error(`${kind} is not available.`), { status: 503, code: "channel_unavailable" });
    const code = await this.connections.issueCode(accountId, kind, this.deps.now?.());
    const url = adapter.connectUrl(code) ?? adapter.chatUrl?.();
    return { code, ...(url ? { url } : {}) };
  }

  disconnect(accountId: string, kind: ChannelKind): Promise<void> { return this.connections.revoke(accountId, kind); }

  async view(accountId: string): Promise<ChannelStatus[]> {
    const owned = await this.connections.owned(accountId);
    return Promise.all(CHANNEL_KINDS.map(async kind => {
      const own = owned.find(connection => connection.channel === kind && connection.audience === "self");
      return {
        kind, available: Boolean(await this.deps.hub.get(kind, this.deps.scopeOf(accountId, kind))), linked: Boolean(own?.linked && own.state !== "revoked"),
        ...(own ? { state: own.state } : {}), ...(own?.lastEventAt ? { lastEventAt: own.lastEventAt } : {}),
      };
    }));
  }

  // ── The Assistant ──────────────────────────────────────────────────────

  async reply(inboundId: string, message: { text: string; buttons?: Send["message"]["buttons"] }): Promise<boolean> {
    const item = await this.inbox.get(inboundId);
    if (!item) return false;
    const connectionId = item.connectionId ?? (await this.connections.resolveConnection({ channel: item.channel, scope: item.scope, senderId: item.event.address.senderId }))?.connection.id;
    if (!connectionId) return false;
    await this.dispatcher.send({ connectionId, channel: item.channel, scope: item.scope, address: item.event.address, kind: "reply", message: { ...message, ...(item.event.messageRef ? { replyTo: item.event.messageRef } : {}) } });
    await this.inbox.markReplied(item.id);
    return true;
  }

  async push(accountId: string, message: { text: string; buttons?: Send["message"]["buttons"] }, prefer?: ChannelKind): Promise<boolean> {
    const linked = await this.connections.linked(accountId);
    const target = linked.find(candidate => candidate.connection.channel === prefer) ?? linked[0];
    if (!target?.identity) return false;
    const { connection, identity } = target;
    await this.dispatcher.send({ connectionId: connection.id, channel: connection.channel as ChannelKind, scope: connection.scope, address: { threadId: identity.threadId, senderId: identity.senderId }, kind: "reply", message });
    return true;
  }

  async canReach(accountId: string): Promise<boolean> {
    for (const { connection, identity } of await this.connections.linked(accountId)) if (identity && await this.dispatcher.open(connection.channel as ChannelKind, connection.scope, identity.threadId)) return true;
    return false;
  }

  compacting(accountId: string, compactionId: string): Promise<void> { return this.compaction({ compactionId, accountId }); }

  /**
   * One notice per compaction per waiting thread, and only where someone is waiting. It is a delivery of its own:
   * it is never submitted to a conversation, so it is in no history and never compacted.
   */
  async compaction(input: { compactionId: string } & ({ runId: string } | { accountId: string })): Promise<void> {
    for (const thread of await this.inbox.waiting("runId" in input ? { runId: input.runId } : { ownerAccountId: input.accountId }, this.deps.now?.())) {
      await this.dispatcher.send({
        connectionId: thread.connectionId, channel: thread.channel, scope: thread.scope, address: { threadId: thread.threadId, senderId: thread.senderId }, kind: "notice",
        message: { text: COMPACTING }, sourceKey: `compaction:${input.compactionId}:${thread.channel}:${thread.scope}:${thread.threadId}`,
      });
    }
  }
}
