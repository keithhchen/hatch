import { timingSafeEqual } from "node:crypto";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";

type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number; chat: { id: number; type: string }; from?: { id: number }; text?: string; caption?: string;
    entities?: Array<{ type: string; offset: number; length: number }>; caption_entities?: Array<{ type: string; offset: number; length: number }>;
    reply_to_message?: { from?: { username?: string; is_bot?: boolean } };
    document?: { file_id: string; file_name?: string; file_size?: number }; photo?: Array<{ file_id: string; file_size?: number }>;
  };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number; type?: string } } };
};

/** Telegram Bot API. One official bot; each Expert links their private chat. */
export class TelegramChannel implements ChannelAdapter {
  readonly kind = "telegram" as const;
  readonly scope = "";
  /** The Bot API lets a bot download files up to 20 MB. */
  readonly maxFileBytes = 20 * 1024 * 1024;
  constructor(private config: { token?: string; username?: string; webhookSecret?: string; }, private fetchImpl: typeof fetch = fetch) {}
  capabilities(): ChannelCapabilities { return { stream: false, edit: true, typing: true, buttons: true, maxLength: 4096, canInitiate: true, idempotentSend: false }; }
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
      const address = { threadId: String(chat), senderId: String(query.from.id) };
      const ref = `${query.id}|${chat}|${query.message!.message_id}`;
      return { events: [{ eventId, address, button: match ? { taskId: match[1]!, action: match[2] as "approve" | "decline", ref } : { taskId: "", action: "decline", ref } }] };
    }
    const message = update.message;
    if (!message) return { events: [] };
    const group = message.chat.type === "group" || message.chat.type === "supergroup";
    if (!group && message.chat.type !== "private") return { events: [] };
    const addressed = group ? this.addressed(message) : false;
    if (group && !addressed) return { events: [] };
    // A photo comes in several sizes, smallest first. The largest is already compressed.
    const photo = message.photo?.at(-1);
    const document = message.document;
    const file = photo ? { ref: photo.file_id, name: "photo.jpg", ...(photo.file_size ? { size: photo.file_size } : {}) }
      : document ? { ref: document.file_id, name: document.file_name ?? "file", ...(document.file_size ? { size: document.file_size } : {}) } : undefined;
    const body = (message.text?.replace(/^\/start\s+/, "") ?? message.caption ?? "");
    const text = (group ? body.replace(this.mention, "") : body).trim();
    const address = { threadId: String(message.chat.id), senderId: String(message.from?.id ?? message.chat.id) };
    return { events: [{ eventId, address, ...(group ? { group: true as const } : {}), messageRef: String(message.message_id), ...(text ? { text } : {}), ...(file ? { file } : {}) }] };
  }
  /** In a group the bot answers only when named or replied to. */
  private addressed(message: NonNullable<TelegramUpdate["message"]>): boolean {
    const text = message.text ?? message.caption ?? "";
    const entities = message.text !== undefined ? message.entities : message.caption_entities;
    const username = this.config.username?.toLowerCase();
    if (!username) return false;
    const mentioned = this.mention.test(text) || (entities ?? []).some(entity => entity.type === "mention" && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${username}`);
    const from = message.reply_to_message?.from;
    return mentioned || from?.username?.toLowerCase() === username;
  }
  private get mention(): RegExp { return new RegExp(`@${(this.config.username ?? "").replace(/[^\w]/g, "")}\\b`, "gi"); }
  async send(to: PlatformAddress, message: OutboundMessage, _key: string): Promise<void> {
    await this.call("sendMessage", {
      chat_id: Number(to.threadId),
      text: message.text,
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
    return guardSend(`Telegram ${method}`, async () => {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${this.config.token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; result?: unknown; description?: string };
      if (!response.ok) throw new ChannelSendError(`Telegram ${method} failed: ${payload.description ?? response.status}`, failureForStatus(response.status), { access: lostAccess(response.status) });
      if (!payload.ok) throw new ChannelSendError(`Telegram ${method} failed: ${payload.description ?? "not ok"}`, "permanent");
      return payload.result;
    });
  }
}
