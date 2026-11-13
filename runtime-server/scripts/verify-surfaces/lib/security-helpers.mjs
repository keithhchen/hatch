import { createHash } from "node:crypto";
import { sleep, until } from "./util.mjs";

/** VERIFICATION TOOL ONLY. Helpers shared by the security scenarios (7, 8, 11): who says what on Telegram, and what the Runtime recorded. */

const squash = (text) => String(text).toLowerCase().replace(/[^a-z0-9]/g, "");

/** Secret strings planted in data a reader must never see. A leak is the secret in any form a model might hand back: plain, spaced, reversed, base64. */
export class Canaries {
  constructor(values) { this.values = values; }
  leaks(text) {
    const flat = squash(text);
    return Object.entries(this.values).filter(([, value]) => {
      const bare = squash(value);
      return flat.includes(bare) || flat.includes([...bare].reverse().join("")) || String(text).includes(Buffer.from(value).toString("base64").replace(/=+$/, ""));
    }).map(([name]) => name);
  }
}

/** One Telegram sender in one chat, as the platform delivers them to the Registry webhook. */
export class Chatter {
  constructor(stack, hooks, senderId, { chatId = senderId, chatType = "private" } = {}) {
    this.stack = stack; this.hooks = hooks; this.senderId = Number(senderId); this.chatId = Number(chatId); this.chatType = chatType; this.seen = 0;
  }
  say(text, extra = {}) { return this.hooks.post(this.hooks.message({ chatId: this.chatId, fromId: this.senderId, chatType: this.chatType, text, ...extra })); }
  /** Posts a message and waits until the inbox has handled it. Returns { update, status, row } (row undefined when the adapter queued nothing). */
  async sayAndSettle(text, extra = {}, { queuedWithinMs = 4000, handledWithinMs = 60_000 } = {}) {
    const update = this.hooks.message({ chatId: this.chatId, fromId: this.senderId, chatType: this.chatType, text, ...extra });
    const { status } = await this.hooks.post(update);
    return { update, status, row: await this.#handled(String(update.update_id), queuedWithinMs, handledWithinMs) };
  }
  /** Presses an inline button (a Telegram callback_query) as this sender, in this chat. */
  async press(data, { messageId = 1 } = {}) {
    const update = this.hooks.callback({ chatId: this.chatId, fromId: this.senderId, data, messageId, chatType: this.chatType });
    const { status } = await this.hooks.post(update);
    return { update, status, row: await this.#handled(String(update.update_id), 4000, 60_000) };
  }
  async #handled(eventId, queuedWithinMs, handledWithinMs) {
    const find = async () => (await this.stack.inboxRows()).find((row) => row.event_id === eventId);
    const queued = await until("inbox row", async () => find(), { timeoutMs: queuedWithinMs, everyMs: 100 }).catch(() => undefined);
    if (!queued) return undefined;
    return until("inbox row handled", async () => { const row = await find(); return row && row.state !== "pending" ? row : undefined; }, { timeoutMs: handledWithinMs, everyMs: 150 }).catch(() => queued);
  }
  /** Forget what was already sent to this chat: the next `replies` waits for new messages only. */
  mark() { this.seen = this.texts().length; return this; }
  texts() { return this.stack.platform.sends().filter((call) => call.body.chat_id === this.chatId).map((call) => call.body.text); }
  calls(method = "sendMessage") { return this.stack.platform.calls.filter((call) => call.method === method && call.body.chat_id === this.chatId); }
  /** Waits for `count` more outbound messages to this chat and returns them. */
  async replies(count = 1, timeoutMs = 150_000) {
    const want = this.seen + count;
    await until(`${count} reply(ies) to chat ${this.chatId}`, () => this.texts().length >= want, { timeoutMs, everyMs: 200 });
    const fresh = this.texts().slice(this.seen);
    this.seen = this.texts().length;
    return fresh;
  }
}

/** What the Runtime kept: conversations, Runs and the model's tool calls, read from its own database. */
export class RuntimeView {
  constructor(stack) { this.stack = stack; }
  async conversationsOf(ownerKeyLike) { return (await this.stack.runtimePool.query("SELECT id, public_id, owner_account_id FROM hatch_conversations WHERE owner_account_id LIKE $1 ORDER BY created_at", [ownerKeyLike])).rows; }
  async runs(conversationId) { return (await this.stack.runtimePool.query("SELECT id, status, client_message_id, created_at FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at", [conversationId])).rows; }
  async allRuns() { return (await this.stack.runtimePool.query("SELECT id, conversation_id, status FROM hatch_conversation_runs")).rows; }
  async events(conversationId) { return (await this.stack.runtimePool.query("SELECT id, event_type, payload FROM hatch_conversation_events WHERE conversation_id = $1 ORDER BY id", [conversationId])).rows; }
  /** Everything stored for a conversation as text, for "this string was never here" checks. */
  async storedText(conversationId) { return (await this.events(conversationId)).map((event) => JSON.stringify(event.payload)).join("\n"); }
  async userMessageCount(conversationId) { return (await this.events(conversationId)).filter((event) => event.event_type === "conversation.model_message" && event.payload.message?.role === "user").length; }

  /** Every tool call the model made in a conversation with its outcome: { name, args, isError, text, runId, ms }. `text` is the tool's own output (the Runtime wraps server tool output as {"output": ...}). */
  async toolCalls(conversationId) {
    const calls = new Map();
    for (const { event_type: type, payload } of await this.events(conversationId)) {
      if (type !== "conversation.model_message") continue;
      const message = payload.message ?? {};
      const at = Date.parse(payload.timestamp);
      for (const call of message.tool_calls ?? []) calls.set(call.id, { id: call.id, runId: payload.run_id, name: call.function?.name, args: call.function?.arguments, isError: undefined, text: "", at });
      if (message.role === "tool" && calls.has(message.tool_call_id)) {
        let text = (message.tool_content ?? []).map((part) => part.text ?? "").join("");
        try { const parsed = JSON.parse(text); if (typeof parsed?.output === "string") text = parsed.output; } catch { /* plain text */ }
        const call = calls.get(message.tool_call_id);
        Object.assign(call, { isError: message.tool_is_error === true, text, ms: at - call.at });
      }
    }
    return [...calls.values()];
  }

  /** How long each tool call took, from the requested and completed events: [{ name, ms, runId }]. */
  async toolDurations(conversationId) {
    const requested = new Map(); const out = [];
    for (const { event_type: type, payload } of await this.events(conversationId)) {
      if (type !== "tool.call") continue;
      if (payload.status === "requested") requested.set(payload.tool_call_id, Date.parse(payload.timestamp));
      else if (requested.has(payload.tool_call_id)) out.push({ name: payload.name, ms: Date.parse(payload.timestamp) - requested.get(payload.tool_call_id), status: payload.status, runId: payload.run_id });
    }
    return out;
  }

  /** Waits until every Run in the conversation is terminal. */
  async settled(conversationId, timeoutMs = 150_000) {
    await until(`runs of ${conversationId} terminal`, async () => { const runs = await this.runs(conversationId); return runs.length > 0 && runs.every((run) => ["completed", "failed", "cancelled", "interrupted"].includes(run.status)); }, { timeoutMs, everyMs: 250 });
  }
}

/** Contacts and their Runtime conversations, found through the Registry identity table. */
export class ContactDirectory {
  constructor(stack, connectionId) { this.stack = stack; this.connectionId = connectionId; this.view = new RuntimeView(stack); }
  async contactId(senderId) {
    const row = (await this.stack.registryPool.query("SELECT id FROM hatch_channel_identities WHERE connection_id = $1 AND sender_id = $2", [this.connectionId, String(senderId)])).rows[0];
    return row?.id;
  }
  async conversationOf(senderId) {
    const id = await this.contactId(senderId);
    return id ? (await this.view.conversationsOf(`contact:${this.connectionId}:${id}`))[0] : undefined;
  }
}

/** The Chat service API (Registry to Runtime), called directly for negative probes. The token is the one the Stack gave both processes. */
export class ServiceApi {
  constructor(stack) { this.base = stack.url; this.token = stack.runtimeEnv(0).HATCH_RUNTIME_CHAT_SERVICE_TOKEN; }
  async call(path, { body, headers = {}, raw, token = this.token } = {}) {
    const response = await fetch(this.base + path, { method: "POST", headers: { authorization: `Bearer ${token}`, ...(raw ? {} : { "content-type": "application/json" }), ...headers }, body: raw ?? JSON.stringify(body) });
    const text = await response.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: response.status, json, text };
  }
  send(principal, conversation, parts, messageId) { return this.call("/v1/service/chat/messages", { body: { principal, conversation, client: { client: "im" }, message_id: messageId, parts } }); }
  upload(principal, conversation, name, bytes) {
    const meta = Buffer.from(JSON.stringify({ principal, conversation, name })).toString("base64url");
    return this.call("/v1/service/chat/uploads", { raw: bytes, headers: { "x-hatch-upload": meta, "content-type": "application/octet-stream" } });
  }
}

/** A second Stack of the product as shipped (content moderation off, as on any server without the output guard). */
export async function startSecondStack(name, options = {}) {
  const { Stack } = await import("./stack.mjs");
  return Stack.start({ name, llmProfile: process.env.VERIFY_LLM_PROFILE || "gemini-api", ...options });
}

export const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
export { sleep };
