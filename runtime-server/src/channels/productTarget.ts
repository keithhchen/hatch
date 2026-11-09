import type { ContentPart } from "../surfaces/contract.js";
import { ChatError } from "../chat/principal.js";
import { imageMime } from "../factoryAgents/imageRefs.js";
import type { Dispatcher } from "./dispatch.js";
import type { Inbox } from "./inbox.js";
import type { ChatGateway, Handled, Inbound, TargetHandler } from "./ports.js";
import type { Rate, RateLimiter } from "./rateLimiter.js";

/** A contact may write this much: a burst of 10, then one message every 20 seconds. */
const CONTACT_RATE: Rate = { capacity: 10, perSecond: 1 / 20 };
const FAILED = "出了点问题，请再发一次。\nSomething went wrong, please send that again.";
const BUSY = "消息有点多，请稍后再发。\nToo many messages, please try again in a moment.";

/** Chat answers the Connection: an Expert Product talking to its owner, an organization, or the public. */
export class ProductTarget implements TargetHandler {
  constructor(private deps: { gateway: ChatGateway; limiter: RateLimiter; contactRate?: Rate }) {}

  async linked(): Promise<string> { return "连上了。可以开始聊了。\nConnected. You can start talking."; }

  async handle(inbound: Inbound): Promise<Handled> {
    const { connection, principal, event, address, adapter } = inbound;
    if (connection.target.kind !== "product") throw new Error("Not a Product Connection");
    if (event.button) { await adapter.acknowledge?.(event); return { replied: true }; }
    // Limits are checked before a Run is started, not after.
    if (principal.kind === "contact" && connection.audience === "public" && await this.deps.limiter.take(`contact:${connection.id}:${principal.contactId}`, this.deps.contactRate ?? CONTACT_RATE)) {
      await inbound.notify(BUSY);
      return { replied: true };
    }
    const parts: ContentPart[] = [];
    if (event.text?.trim()) parts.push({ type: "text", text: event.text.trim() });
    const thread = { kind: "thread" as const, connectionId: connection.id, threadId: address.threadId };
    try {
      if (event.file) {
        if ((event.file.size ?? 0) > adapter.maxFileBytes) { await inbound.notify("这个文件太大了。\nThat file is too large."); return { replied: true }; }
        const { assetId } = await this.deps.gateway.upload(principal, thread, { name: event.file.name, bytes: await adapter.download(event.file) });
        parts.push({ type: imageMime(event.file.name) ? "image" : "file", assetId });
      }
      if (!parts.length) { await inbound.notify("这种消息我还读不了，可以发文字、图片或文档。\nI can't read that kind of message yet."); return { replied: true }; }
      const { runId } = await this.deps.gateway.send(principal, thread, { client: connection.client }, event.eventId, parts);
      return { replied: false, runId };
    } catch (error) {
      // A refusal that no retry changes goes back to the sender; anything else returns the event to the queue.
      if (!(error instanceof ChatError && (error.status < 500 || error.status === 501 || error.code === "unavailable"))) throw error;
      await inbound.notify(error.message);
      return { replied: true };
    }
  }
}

/** Sends a Run's final reply when it ends. The reply is its delivery's source key, so however many times this runs, it is sent once. */
export class ChatReplies {
  constructor(private deps: { gateway: ChatGateway; inbox: Inbox; dispatcher: Dispatcher; compacting(runId: string, compactionId: string): Promise<void> }) {}

  /** Asks Chat how the Run stands. Everything it needs is durable on both sides, so this works after any restart. */
  async settle(runId: string): Promise<void> {
    const progress = await this.deps.gateway.progress(runId);
    if (!progress) return;
    if (!progress.ended) { if (progress.compactionId) await this.deps.compacting(runId, progress.compactionId); return; }
    const outcome = { ok: progress.reply.status === "completed", text: progress.reply.text };
    const items = await this.deps.inbox.byRun(runId);
    const last = items.at(-1);
    if (!last?.connectionId) return;
    await this.deps.dispatcher.send({
      connectionId: last.connectionId, channel: last.channel, scope: last.scope, address: last.event.address, kind: "reply",
      message: { text: outcome.ok && outcome.text.trim() ? outcome.text : FAILED, ...(last.event.messageRef ? { replyTo: last.event.messageRef } : {}) },
      sourceKey: `run:${runId}`,
    });
    await this.deps.inbox.markReplied(last.id);
  }

  /** Runs that have not been answered: every one is asked about, so an end or a compaction is never missed. */
  async sweep(): Promise<void> {
    for (const runId of await this.deps.inbox.openRuns(20)) await this.settle(runId).catch(error => console.error("[channel reply]", (error as Error).message));
  }
}
