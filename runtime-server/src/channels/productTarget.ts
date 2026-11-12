import type { ContentPart } from "../surfaces/contract.js";
import type { Dispatcher } from "./dispatch.js";
import type { Inbox, InboxItem } from "./inbox.js";
import type { ChatTarget } from "./chatTarget.js";
import type { ChatGateway, Inbound, ReplyPolicy } from "./ports.js";
import type { Rate, RateLimiter } from "./rateLimiter.js";
import { log } from "../observability/log.js";

/** A contact may write this much: a burst of 10, then one message every 20 seconds. */
const CONTACT_RATE: Rate = { capacity: 10, perSecond: 1 / 20 };
export const FAILED = "出了点问题，请再发一次。\nSomething went wrong, please send that again.";
const BUSY = "消息有点多，请稍后再发。\nToo many messages, please try again in a moment.";

/** Chat answers the Connection: an Expert Product talking to its owner, an organization, or the public. */
export class ProductTarget implements ChatTarget {
  constructor(private deps: { gateway: ChatGateway; limiter: RateLimiter; contactRate?: Rate }) {}

  async linked(): Promise<string> { return "连上了。可以开始聊了。\nConnected. You can start talking."; }

  wording = { tooLarge: () => "这个文件太大了。\nThat file is too large.", unreadable: "这种消息我还读不了，可以发文字、图片或文档。\nI can't read that kind of message yet.", capReached: "这个助手本月的使用额度已用完。\nThis assistant has reached its monthly limit." };

  async admit({ connection, principal }: Inbound): Promise<string | undefined> {
    if (connection.target.kind !== "product") throw new Error("Not a Product Connection");
    // Limits are checked before a Run is started, not after.
    return principal.kind === "contact" && connection.audience === "public" && await this.deps.limiter.take(`contact:${connection.id}:${principal.contactId}`, this.deps.contactRate ?? CONTACT_RATE) ? BUSY : undefined;
  }

  upload({ connection, principal, address }: Inbound, file: { name: string; bytes: Buffer }) { return this.deps.gateway.upload(principal, thread(connection, address), file); }

  send({ connection, principal, address }: Inbound, { key, parts }: { key: string; parts: ContentPart[] }) {
    return this.deps.gateway.send(principal, thread(connection, address), { client: connection.client }, key, parts);
  }
}

const thread = (connection: Inbound["connection"], address: Inbound["address"]) => ({ kind: "thread" as const, connectionId: connection.id, threadId: address.threadId });

/** Sends a Run's final reply when it ends. The reply is its delivery's source key, so however many times this runs, it is sent once. */
export class ChatReplies {
  constructor(private deps: { gateway: ChatGateway; inbox: Inbox; dispatcher: Dispatcher; compacting(runId: string, compactionId: string): Promise<void>; /** How the Agent that answered wants this reply sent. */ policy?(connectionId: string, runId: string): Promise<ReplyPolicy> }) {}

  /** Asks Chat how the Run stands. Everything it needs is durable on both sides, so this works after any restart. */
  async settle(runId: string): Promise<void> {
    const progress = await this.deps.gateway.progress(runId);
    if (!progress) return;
    if (!progress.ended) { if (progress.compactionId) await this.deps.compacting(runId, progress.compactionId); return; }
    const { status, text, reason } = progress.reply;
    // A failed Run says why: Chat's public failure message, which carries the reference for an upstream failure.
    const outcome = { text: status === "failed" && reason ? reason : text };
    // Every thread the Run was steered from is answered in its own thread, to its own latest message, and only those events are marked.
    const threads = new Map<string, InboxItem[]>();
    for (const item of await this.deps.inbox.byRun(runId)) {
      const key = `${item.channel}:${item.scope}:${item.event.address.threadId}`;
      if (item.connectionId) threads.set(key, [...threads.get(key) ?? [], item]);
    }
    const failures: unknown[] = [];
    for (const [thread, items] of threads) {
      const last = items.at(-1)!;
      try {
        const policy = await this.deps.policy?.(last.connectionId!, runId) ?? {};
        if (outcome.text.trim() || status !== "completed" || !policy.quietWhenEmpty) await this.deps.dispatcher.send({
          connectionId: last.connectionId!, channel: last.channel, scope: last.scope, address: last.event.address, kind: "reply",
          message: { text: outcome.text.trim() ? outcome.text : FAILED, ...(policy.buttons?.length ? { buttons: policy.buttons } : {}), ...(last.event.messageRef ? { replyTo: last.event.messageRef } : {}) },
          sourceKey: `run:${runId}:${thread}`,
        });
        await this.deps.inbox.markReplied(items.map(item => item.id));
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }

  /** Runs that have not been answered: every one is asked about, so an end or a compaction is never missed. */
  async sweep(): Promise<void> {
    for (const runId of await this.deps.inbox.openRuns(20)) await this.settle(runId).catch(error => log.error("channel_reply_failed", { error: (error as Error).message }));
  }
}
