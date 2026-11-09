import { TELEGRAM } from "./stack.mjs";

/**
 * VERIFICATION TOOL ONLY. Platform webhooks in the platforms' documented formats, signed the way each adapter verifies them,
 * posted to the real Registry endpoint. Telegram is signed with the secret-token header; Feishu and WeCom live in their own
 * classes below as the adapters document them.
 */
export class TelegramWebhooks {
  constructor(registryUrl, { secret = TELEGRAM.secret, username = TELEGRAM.username } = {}) { this.url = `${registryUrl}/v1/channels/telegram/webhook`; this.secret = secret; this.username = username; this.nextUpdate = 100_000 + Math.floor(Math.random() * 100_000); this.nextMessage = 1; }

  message({ updateId = this.nextUpdate++, chatId, fromId = chatId, text, chatType = "private", mention = false, replyToBot = false, document, photo, messageId = this.nextMessage++ }) {
    const body = mention ? `@${this.username} ${text ?? ""}` : text;
    const entities = mention ? [{ type: "mention", offset: 0, length: this.username.length + 1 }] : undefined;
    return { update_id: updateId, message: {
      message_id: messageId, chat: { id: chatId, type: chatType }, from: { id: fromId },
      ...(body !== undefined ? { text: body } : {}), ...(entities ? { entities } : {}),
      ...(replyToBot ? { reply_to_message: { from: { username: this.username, is_bot: true } } } : {}),
      ...(document ? { document } : {}), ...(photo ? { photo } : {})
    } };
  }
  callback({ updateId = this.nextUpdate++, chatId, fromId, data, queryId = `cb-${updateId}`, messageId = 1, chatType = "private" }) {
    return { update_id: updateId, callback_query: { id: queryId, from: { id: fromId }, data, message: { message_id: messageId, chat: { id: chatId, type: chatType } } } };
  }
  /** Posts an update. `signed: false` omits the secret; `secret` overrides it. Returns the HTTP status and the time it took. */
  async post(update, { signed = true, secret = this.secret } = {}) {
    const started = Date.now();
    const response = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json", ...(signed ? { "x-telegram-bot-api-secret-token": secret } : {}) }, body: JSON.stringify(update) });
    await response.text();
    return { status: response.status, ms: Date.now() - started };
  }
}
