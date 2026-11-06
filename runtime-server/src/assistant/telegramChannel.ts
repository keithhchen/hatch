import { timingSafeEqual } from "node:crypto";
import type { ChannelAdapter, InboundEvent, InboundFile, OutboundMessage } from "./channels.js";

type TelegramUpdate = {
  update_id: number;
  message?: { message_id: number; chat: { id: number; type: string }; text?: string; caption?: string; document?: { file_id: string; file_name?: string; file_size?: number }; photo?: Array<{ file_id: string; file_size?: number }> };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number; type?: string } } };
};

/** Telegram Bot API. One official bot; each Expert links their private chat. */
export class TelegramChannel implements ChannelAdapter {
  readonly kind = "telegram" as const;
  readonly scope = "";
  /** The Bot API lets a bot download files up to 20 MB. */
  readonly maxFileBytes = 20 * 1024 * 1024;
  constructor(private config: { token?: string; username?: string; webhookSecret?: string; studioUrl: string }, private fetchImpl: typeof fetch = fetch) {}
  available(): boolean { return Boolean(this.config.token && this.config.username && this.config.webhookSecret); }
  connectUrl(code: string): string { return `https://t.me/${this.config.username}?start=${code}`; }
  verify(_raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const supplied = headers["x-telegram-bot-api-secret-token"]?.toString();
    const expected = this.config.webhookSecret;
    if (!expected || !supplied) return false;
    const a = Buffer.from(supplied); const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  parse(raw: Buffer): { events: InboundEvent[] } {
    const update = JSON.parse(raw.toString("utf8")) as TelegramUpdate;
    const eventId = String(update.update_id);
    const query = update.callback_query;
    if (query) {
      const match = query.data?.match(/^t:([0-9a-f-]{36}):(approve|decline)$/);
      const chat = query.message?.chat.id;
      if (chat === undefined) return { events: [] };
      if (!match) return { events: [{ eventId, peerId: String(chat), button: { taskId: "", action: "decline", ref: `${query.id}|${chat}|${query.message!.message_id}` } }] };
      return { events: [{ eventId, peerId: String(chat), button: { taskId: match[1]!, action: match[2] as "approve" | "decline", ref: `${query.id}|${chat}|${query.message!.message_id}` } }] };
    }
    const message = update.message;
    if (!message || message.chat.type !== "private") return { events: [] };
    // A photo comes in several sizes, smallest first. The largest is already compressed.
    const photo = message.photo?.at(-1);
    const document = message.document;
    const file = photo ? { ref: photo.file_id, name: "photo.jpg", ...(photo.file_size ? { size: photo.file_size } : {}) }
      : document ? { ref: document.file_id, name: document.file_name ?? "file", ...(document.file_size ? { size: document.file_size } : {}) } : undefined;
    const text = message.text?.replace(/^\/start\s+/, "").trim() || message.caption?.trim();
    return { events: [{ eventId, peerId: String(message.chat.id), messageRef: String(message.message_id), ...(text ? { text } : {}), ...(file ? { file } : {}) }] };
  }
  async send(peerId: string, message: OutboundMessage): Promise<void> {
    const text = message.text.length > 3800 ? `${message.text.slice(0, 3700).trimEnd()}…\n\n${this.config.studioUrl}` : message.text;
    await this.call("sendMessage", {
      chat_id: Number(peerId),
      text,
      link_preview_options: { is_disabled: true },
      ...(message.replyTo ? { reply_parameters: { message_id: Number(message.replyTo), allow_sending_without_reply: true } } : {}),
      ...(message.buttons?.length ? { reply_markup: { inline_keyboard: [message.buttons.map(button => ({ text: button.label, callback_data: `t:${button.taskId}:${button.action}` }))] } } : {}),
    });
  }
  async download(file: InboundFile): Promise<Buffer> {
    const found = await this.call("getFile", { file_id: file.ref }) as { file_path?: string };
    if (!found.file_path) throw new Error("Telegram did not return a file path");
    const response = await this.fetchImpl(`https://api.telegram.org/file/bot${this.config.token}/${found.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  async acknowledge(event: InboundEvent, text?: string): Promise<void> {
    const [queryId, chat, messageId] = event.button?.ref?.split("|") ?? [];
    if (!queryId) return;
    await this.call("answerCallbackQuery", { callback_query_id: queryId, ...(text ? { text: text.slice(0, 180) } : {}) });
    await this.call("editMessageReplyMarkup", { chat_id: Number(chat), message_id: Number(messageId), reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  }
  private async call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string };
    if (!response.ok || !payload.ok) throw new Error(`Telegram ${method} failed: ${payload.description ?? response.status}`);
    return payload.result;
  }
}
