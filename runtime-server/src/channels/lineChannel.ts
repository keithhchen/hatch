import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress, idempotencyId } from "./types.js";

type LineEvent = {
  type: string;
  webhookEventId: string;
  timestamp: number;
  replyToken?: string;
  source?: { type: string; userId?: string };
  message?: { id: string; type: string; text?: string; fileName?: string; fileSize?: number };
  postback?: { data?: string };
};

/** LINE accepts a token for one minute after the webhook. Leave room for the request itself. */
const REPLY_WINDOW_MS = 50_000;
const MAX_LABEL = 20;

/** Cut at UTF-16 unit `at`, or one earlier rather than through a surrogate pair. */
function cut(text: string, at: number): string {
  const code = text.charCodeAt(at - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? at - 1 : at);
}

/** A UUID that is the same for the same key: LINE and Lark take one to make a repeated send a no-op. */

/** LINE Messaging API. One official account; each Expert links their 1:1 chat. */
export class LineChannel implements ChannelAdapter {
  readonly kind = "line" as const;
  readonly scope = "";
  readonly maxFileBytes = 20 * 1024 * 1024;
  constructor(private config: { channelSecret?: string; accessToken?: string; basicId?: string }, private fetchImpl: typeof fetch = fetch) {}
  capabilities(): ChannelCapabilities { return { stream: false, edit: false, typing: false, buttons: true, maxLength: 5000, canInitiate: true, idempotentSend: true }; }
  available(): boolean { return Boolean(this.config.channelSecret && this.config.accessToken && this.config.basicId); }
  /** Opens the chat with the code in the input field. Needs the @ of the Basic ID; LINE's URL scheme doesn't work on LINE for PC. */
  connectUrl(code: string): string | undefined {
    return this.config.basicId ? `https://line.me/R/oaMessage/${encodeURIComponent(this.config.basicId)}/?${encodeURIComponent(code)}` : undefined;
  }
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const supplied = headers["x-line-signature"]?.toString();
    if (!this.config.channelSecret || !supplied) return false;
    const a = Buffer.from(supplied); const b = Buffer.from(createHmac("sha256", this.config.channelSecret).update(raw).digest("base64"));
    return a.length === b.length && timingSafeEqual(a, b);
  }
  parse(raw: Buffer): { events: InboundEvent[] } {
    const { events = [] } = JSON.parse(raw.toString("utf8")) as { events?: LineEvent[] };
    return { events: events.flatMap(event => this.event(event)) };
  }
  async send(to: PlatformAddress, message: OutboundMessage, key: string): Promise<void> {
    const quickReply = message.buttons?.length ? { items: message.buttons.map(button => ({ type: "action", action: { type: "postback", label: cut(button.label, MAX_LABEL), data: `t:${button.taskId}:${button.action}`, displayText: button.label } })) } : undefined;
    const messages = [{ type: "text", text: message.text, ...(quickReply ? { quickReply } : {}) }];
    const [replyToken, at] = message.replyTo?.split("|") ?? [];
    if (replyToken && Date.now() - Number(at) < REPLY_WINDOW_MS) {
      // A failed reply sends nothing, and a token works only once.
      try { return await this.call("reply", { replyToken, messages }); } catch { /* push below reports any real failure */ }
    }
    await this.call("push", { to: to.threadId, messages }, { "x-line-retry-key": idempotencyId(key) });
  }
  async download(file: InboundFile): Promise<Buffer> {
    const response = await this.fetchImpl(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(file.ref)}/content`, { headers: { authorization: `Bearer ${this.config.accessToken}` }, signal: AbortSignal.timeout(60_000) });
    // 202 means the content is still being prepared: ok, but with no bytes.
    if (response.status !== 200) throw new Error(`LINE file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  private event(event: LineEvent): InboundEvent[] {
    const id = event.source?.userId;
    if (event.source?.type !== "user" || !id) return [];
    const base = { eventId: event.webhookEventId, address: { threadId: id, senderId: id }, ...(event.replyToken ? { messageRef: `${event.replyToken}|${event.timestamp}` } : {}) };
    if (event.type === "postback") {
      const match = event.postback?.data?.match(/^t:([0-9a-f-]{36}):(approve|decline)$/);
      return match ? [{ ...base, button: { taskId: match[1]!, action: match[2] as "approve" | "decline" } }] : [];
    }
    const message = event.message;
    if (event.type !== "message" || !message) return [];
    if (message.type === "text") return [{ ...base, ...(message.text ? { text: message.text } : {}) }];
    if (message.type === "image") return [{ ...base, file: { ref: message.id, name: "photo.jpg" } }];
    if (message.type === "file") return [{ ...base, file: { ref: message.id, name: message.fileName ?? "file", ...(message.fileSize ? { size: message.fileSize } : {}) } }];
    return [base];
  }
  private async call(method: "reply" | "push", body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<void> {
    await guardSend(`LINE ${method}`, async () => {
      const response = await this.fetchImpl(`https://api.line.me/v2/bot/message/${method}`, { method: "POST", headers: { authorization: `Bearer ${this.config.accessToken}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      if (response.ok) return;
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new ChannelSendError(`LINE ${method} failed: ${payload.message ?? response.status}`, failureForStatus(response.status), { access: lostAccess(response.status) });
    });
  }
}
