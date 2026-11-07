import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ChannelAdapter, InboundEvent, InboundFile, OutboundMessage } from "./channels.js";

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
const MAX_TEXT = 5000;
const MAX_MESSAGES = 5;
const MAX_LABEL = 20;

/** Cut at UTF-16 unit `at`, or one earlier rather than through a surrogate pair. */
function cut(text: string, at: number): string {
  const code = text.charCodeAt(at - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? at - 1 : at);
}

/** Each chunk can lose a unit to a surrogate pair, so five always hold (MAX_TEXT - 1) * 5. */
function chunks(text: string, studioUrl: string): string[] {
  const capacity = (MAX_TEXT - 1) * MAX_MESSAGES;
  const suffix = `…\n\n${studioUrl}`;
  let rest = text.length > capacity ? `${cut(text, capacity - suffix.length).trimEnd()}${suffix}` : text;
  const parts: string[] = [];
  while (rest.length > MAX_TEXT) {
    const part = cut(rest, MAX_TEXT);
    parts.push(part);
    rest = rest.slice(part.length);
  }
  return [...parts, rest];
}

/** LINE Messaging API. One official account; each Expert links their 1:1 chat. */
export class LineChannel implements ChannelAdapter {
  readonly kind = "line" as const;
  readonly scope = "";
  readonly maxFileBytes = 20 * 1024 * 1024;
  constructor(private config: { channelSecret?: string; accessToken?: string; basicId?: string; studioUrl: string }, private fetchImpl: typeof fetch = fetch) {}
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
  async send(peerId: string, message: OutboundMessage): Promise<void> {
    const parts = chunks(message.text, this.config.studioUrl);
    // LINE shows the quick reply of the last message only.
    const quickReply = message.buttons?.length ? { items: message.buttons.map(button => ({ type: "action", action: { type: "postback", label: cut(button.label, MAX_LABEL), data: `t:${button.taskId}:${button.action}`, displayText: button.label } })) } : undefined;
    const messages = parts.map((text, index) => ({ type: "text", text, ...(quickReply && index === parts.length - 1 ? { quickReply } : {}) }));
    const [replyToken, at] = message.replyTo?.split("|") ?? [];
    if (replyToken && Date.now() - Number(at) < REPLY_WINDOW_MS) {
      // A failed reply sends nothing, and a token works only once.
      try { return await this.call("reply", { replyToken, messages }); } catch { /* push below reports any real failure */ }
    }
    await this.call("push", { to: peerId, messages }, { "x-line-retry-key": randomUUID() });
  }
  async download(file: InboundFile): Promise<Buffer> {
    const response = await this.fetchImpl(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(file.ref)}/content`, { headers: { authorization: `Bearer ${this.config.accessToken}` }, signal: AbortSignal.timeout(60_000) });
    // 202 means the content is still being prepared: ok, but with no bytes.
    if (response.status !== 200) throw new Error(`LINE file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  private event(event: LineEvent): InboundEvent[] {
    const peerId = event.source?.userId;
    if (event.source?.type !== "user" || !peerId) return [];
    const base = { eventId: event.webhookEventId, peerId, ...(event.replyToken ? { messageRef: `${event.replyToken}|${event.timestamp}` } : {}) };
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
    const response = await this.fetchImpl(`https://api.line.me/v2/bot/message/${method}`, { method: "POST", headers: { authorization: `Bearer ${this.config.accessToken}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (response.ok) return;
    const payload = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(`LINE ${method} failed: ${payload.message ?? response.status}`);
  }
}
