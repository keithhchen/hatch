import type { AgentTarget } from "../surfaces/contract.js";
import { STUDIO_TARGET, targetKey, type ConnectionRepository, type OwnedConnection } from "./connections.js";
import { Dispatcher, type Send } from "./dispatch.js";
import type { ChannelHub } from "./hub.js";
import { type Inbox, type InboxItem } from "./inbox.js";
import { backoffMs, pollLoop } from "./loop.js";
import { type Outbox } from "./outbox.js";
import type { AssistantChannels, ChatGateway, TargetHandler, TargetKind } from "./ports.js";
import { ChatReplies, FAILED } from "./productTarget.js";
import { type RateLimiter } from "./rateLimiter.js";
import { keepTyping } from "./typing.js";
import { ChannelRouter, type Claim, type SignIn } from "./router.js";
import { CHANNEL_KINDS, mergeAlbum, type ChannelAdapter, type ChannelKind, type InboundEvent, type PullNotice } from "./types.js";
import { log } from "../observability/log.js";

/** A crashed process frees its event after this; a live one renews the lease every third of it while it works. */
const INBOX_LEASE_MS = 30_000;
const INBOX_ATTEMPTS = 5;
const TYPING = { everyMs: 4_000, maxMs: 3 * 60_000 };
const COMPACTING = "正在整理对话，稍等一下。\nTidying up our conversation, one moment.";

export type ChannelStores = { connections: ConnectionRepository; inbox: Inbox; outbox: Outbox; limiter: RateLimiter };

export type ChannelStatus = {
  kind: ChannelKind; available: boolean; linked: boolean; state?: OwnedConnection["state"]; lastEventAt?: string; senderId?: string;
  /** Credentials are saved for this Connection. */
  configured: boolean;
  /** What people call the account on the platform (a bot's username). */
  handle?: string;
  /** A Product bot only: the contacts bound to it, and the messages they have sent it. */
  users?: number; messages?: number;
};

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

  constructor(private deps: ChannelStores & { hub: ChannelHub; scopeOf: (ownerAccountId: string, channel: ChannelKind) => string; /** Whose Connection a Product's chat on this platform is: its own bot's public one, or the Expert's own. Default: the Expert's. */ audienceOf?: (channel: ChannelKind, target: AgentTarget) => "self" | "public"; signIn?: SignIn; claim?: Claim; gateway?: ChatGateway; /** Whether the account owns the Product: only its owner binds a chat to it. */ ownsProduct?: (accountId: string, productId: string) => Promise<boolean>; now?: () => Date; rates?: ConstructorParameters<typeof Dispatcher>[0]["rates"]; onError?: (error: unknown) => void }) {
    this.connections = deps.connections;
    this.hub = deps.hub;
    this.inbox = deps.inbox;
    this.dispatcher = new Dispatcher({ outbox: deps.outbox, hub: deps.hub, limiter: deps.limiter, connections: deps.connections, inbox: deps.inbox, ...(deps.now ? { now: deps.now } : {}), ...(deps.rates ? { rates: deps.rates } : {}), onQueued: () => this.outboxLoop?.wake(), onError: this.report });
    this.router = new ChannelRouter({
      hub: deps.hub, connections: deps.connections, onError: this.report, ...(deps.signIn ? { signIn: deps.signIn } : {}), ...(deps.claim ? { claim: deps.claim } : {}),
      notify: async (to, text, sourceKey, replyTo, link) => { await this.dispatcher.send({ ...to, kind: "notice", message: { text, ...(replyTo ? { replyTo } : {}), ...(link ? { link } : {}) }, sourceKey }); },
    });
    if (deps.gateway) this.replies = new ChatReplies({
      gateway: deps.gateway, inbox: deps.inbox, dispatcher: this.dispatcher, compacting: (runId, compactionId) => this.compaction({ runId, compactionId }),
      policy: async (connectionId, runId) => { const connection = await deps.connections.get(connectionId); return connection ? this.router.replyPolicy(connection, runId) : {}; }
    });
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
    const now = () => this.deps.now?.();
    const heartbeat = setInterval(() => void this.inbox.extend(item, INBOX_LEASE_MS, now()).catch(this.report), INBOX_LEASE_MS / 3);
    try {
      // The photos of an album that were stored as events of their own are handled as one message, and done with it.
      const rest = await this.inbox.siblings(item);
      const outcome = await this.router.route(rest.length ? { ...item, event: mergeAlbum(item.event, rest.map(part => part.event)) } : item);
      if (!await this.inbox.complete(item, outcome, rest.map(part => part.id), now())) this.report(new Error(`Lost the lease on ${item.channel} event ${item.id} before it was done: another worker has it`));
      else if (outcome.runId && !outcome.replied) void this.showTyping(item, outcome.runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = await this.inbox.retry(item, message, backoffMs(item.attempts), INBOX_ATTEMPTS, now());
      this.report(error);
      if (state === "failed") await this.giveUp(item, message);
    } finally { clearInterval(heartbeat); }
  }

  /** While the Run's reply is unsent, the sender sees that an answer is coming. The reply marks the event replied, which is what ends it. */
  private async showTyping(item: InboxItem, runId: string): Promise<void> {
    const adapter = await this.deps.hub.get(item.channel, item.scope).catch(() => undefined);
    if (!adapter?.typing) return;
    const { address, messageRef } = item.event;
    await keepTyping(() => adapter.typing!(address, messageRef),
      async () => (await this.inbox.waiting({ runId }, this.deps.now?.())).some(thread => thread.channel === item.channel && thread.scope === item.scope && thread.threadId === address.threadId), TYPING);
  }

  /** The last try failed: say so to the sender in plain words, never in the provider's, and log it as an error. */
  private async giveUp(item: InboxItem, cause: string): Promise<void> {
    this.report(new Error(`Giving up on ${item.channel} event ${item.id} after ${item.attempts} attempts: ${cause}`));
    if (item.event.unreachable || item.event.revoked) return;
    await this.dispatcher.send({
      ...(item.connectionId ? { connectionId: item.connectionId } : {}), channel: item.channel, scope: item.scope, address: item.event.address, kind: "notice",
      message: { text: FAILED, ...(item.event.messageRef ? { replyTo: item.event.messageRef } : {}) }, sourceKey: `inbox-failed:${item.id}`,
    }).catch(this.report);
  }

  private report = (error: unknown): void => this.deps.onError ? this.deps.onError(error) : log.error("channels_failed", { error: error instanceof Error ? error.message : error });

  // ── Studio ─────────────────────────────────────────────────────────────

  /** A connect code for Studio to show, for the Assistant or one of the account's Products: the account sends it to us from the platform. */
  async connect(accountId: string, kind: ChannelKind, target: AgentTarget = STUDIO_TARGET): Promise<{ code: string; url?: string }> {
    const adapter = await this.deps.hub.get(kind, await this.scopeFor(accountId, kind, target));
    if (!adapter) throw Object.assign(new Error(`${kind} is not available.`), { status: 503, code: "channel_unavailable" });
    if (target.kind === "product" && !await this.deps.ownsProduct?.(accountId, target.productId)) throw Object.assign(new Error("Product was not found."), { status: 404, code: "product_not_found" });
    const code = await this.connections.issueCode(accountId, kind, target, this.deps.now?.());
    const url = adapter.connectUrl(code) ?? adapter.chatUrl?.();
    return { code, ...(url ? { url } : {}) };
  }

  disconnect(accountId: string, kind: ChannelKind, target: AgentTarget = STUDIO_TARGET): Promise<void> { return this.connections.unbind(accountId, kind, target); }

  /** The Connection the account holds on a platform for a target: the Expert's own, or a Product's public one where it has a bot of its own. */
  private ownedFor(owned: OwnedConnection[], kind: ChannelKind, target: AgentTarget): OwnedConnection | undefined {
    const audience = this.deps.audienceOf?.(kind, target) ?? "self";
    return owned.find(connection => connection.channel === kind && connection.audience === audience && targetKey(connection.target) === targetKey(target));
  }

  /** Where the account's chats on a platform live: under the scope its saved credentials name, otherwise the platform's default. */
  private async scopeFor(accountId: string, kind: ChannelKind, target: AgentTarget): Promise<string> {
    const own = this.ownedFor(await this.connections.owned(accountId), kind, target);
    return own?.hasCredentials ? own.scope : this.deps.scopeOf(accountId, kind);
  }

  async view(accountId: string, target: AgentTarget = STUDIO_TARGET): Promise<ChannelStatus[]> {
    const owned = await this.connections.owned(accountId);
    return Promise.all(CHANNEL_KINDS.map(async kind => {
      const own = this.ownedFor(owned, kind, target);
      const adapter = await this.deps.hub.get(kind, own?.hasCredentials ? own.scope : this.deps.scopeOf(accountId, kind));
      const [users, messages] = target.kind === "product" && own?.hasCredentials ? await Promise.all([this.connections.contactCount(own.id), this.inbox.inboundCount(kind, own.scope)]) : [];
      return {
        kind, available: Boolean(adapter), linked: Boolean(own?.linked), configured: Boolean(own?.hasCredentials),
        ...(users === undefined ? {} : { users, messages }),
        ...(adapter?.handle ? { handle: adapter.handle } : {}),
        ...(own ? { state: own.state } : {}), ...(own?.lastEventAt ? { lastEventAt: own.lastEventAt } : {}), ...(own?.linked && own.senderId ? { senderId: own.senderId } : {}),
      };
    }));
  }

  /**
   * Someone the platform vouched for (a sign-in that named them) is bound to the Assistant as its owner,
   * and told so in the chat they came from. Only our own shared account does this: the chat is the sender's own.
   */
  async admit(kind: ChannelKind, who: { senderId: string; threadId: string }, accountId: string): Promise<void> {
    const adapter = await this.deps.hub.get(kind);
    if (!adapter) throw Object.assign(new Error(`${kind} is not available.`), { status: 503, code: "channel_unavailable" });
    const code = await this.connections.issueCode(accountId, kind, STUDIO_TARGET, this.deps.now?.());
    // A sign-in knows the user, not the chat: where the platform's DM is not the user's id, the adapter says where it is.
    if (adapter.directThread) who = { ...who, threadId: await adapter.directThread(who.senderId) };
    const linked = await this.connections.redeem(kind, adapter.scope, code, who, this.deps.now?.());
    if (!linked) throw Object.assign(new Error("This link code has expired."), { status: 410, code: "link_expired" });
    await this.dispatcher.send({ connectionId: linked.id, channel: kind, scope: linked.scope, address: who, kind: "notice", message: { text: await this.router.greeting(linked) }, sourceKey: `admit:${linked.id}` });
  }

  // ── The Assistant ──────────────────────────────────────────────────────

  async push(accountId: string, message: { text: string; buttons?: Send["message"]["buttons"] }, prefer?: ChannelKind, sourceKey?: string): Promise<boolean> {
    const linked = await this.connections.linked(accountId);
    const target = linked.find(candidate => candidate.connection.channel === prefer) ?? linked[0];
    if (!target?.identity) return false;
    const { connection, identity } = target;
    await this.dispatcher.send({ connectionId: connection.id, channel: connection.channel as ChannelKind, scope: connection.scope, address: { threadId: identity.threadId, senderId: identity.senderId }, kind: "reply", message, ...(sourceKey ? { sourceKey } : {}) });
    return true;
  }

  async canReach(accountId: string): Promise<boolean> {
    for (const { connection, identity } of await this.connections.linked(accountId)) if (identity && await this.dispatcher.open(connection.channel as ChannelKind, connection.scope, identity.threadId)) return true;
    return false;
  }

  /**
   * One notice per compaction per waiting thread, and only where someone is waiting. It is a delivery of its own:
   * it is never submitted to a conversation, so it is in no history and never compacted.
   */
  async compaction(input: { compactionId: string; runId: string }): Promise<void> {
    for (const thread of await this.inbox.waiting({ runId: input.runId }, this.deps.now?.())) {
      await this.dispatcher.send({
        connectionId: thread.connectionId, channel: thread.channel, scope: thread.scope, address: { threadId: thread.threadId, senderId: thread.senderId }, kind: "notice",
        message: { text: COMPACTING }, sourceKey: `compaction:${input.compactionId}:${thread.channel}:${thread.scope}:${thread.threadId}`,
      });
    }
  }
}
