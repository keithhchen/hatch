import { randomUUID } from "node:crypto";
import { HatchError } from "./errors.js";
import { need, object } from "./command.js";
import { ConversationApi, chatRoutes, formatMessages, formatSent, observe, send, sendOptions } from "./conversation.js";
import { resumable } from "./run.js";

// Consumer Chat: a conversation between the signed-in account and a published Product.
const conversationApi = async (ctx, id) => new ConversationApi(await ctx.client(), chatRoutes(id));
const conversationIdSchema = { conversation_id: { type: "string", description: "Conversation id" } };

// The create call carries a key derived from the send's key, so a retried send continues the same conversation.
async function startConversation(ctx, product, key) {
  const r = await (await ctx.client()).post("/v1/conversations", { product_id: product }, { "idempotency-key": `${key}:conversation` });
  return r.conversation_id ?? r.id;
}

const conversations = {
  name: "conversations",
  describe: "List your Chat conversations",
  usage: "conversations",
  options: {},
  async run(ctx) { const r = await (await ctx.client()).get("/v1/conversations"); return Array.isArray(r) ? r : r.conversations ?? []; },
  format: (r) => r.length ? r.map((c) => `${c.id}  ${c.product_id ?? ""}  ${c.updated_at ?? ""}`).join("\n") : "No conversations.",
  mcp: { name: "conversations_list", description: "List the account's Hatch Chat conversations with published products.", inputSchema: object({}), toArgs: () => ({ _: [], flags: {} }) }
};

const ask = {
  name: "ask",
  describe: "Chat with a published product: start with --product, continue with --conversation",
  usage: "ask <message...> (--product <id> | --conversation <id>) [--wait[=N]] [--stream] [--key <client_message_id>]",
  options: { product: { type: "string", describe: "Start a new conversation with this product" }, conversation: { type: "string", describe: "Continue this conversation" }, ...sendOptions },
  async run(ctx, args) {
    const content = need(this, args, 1).join(" ");
    const { product, conversation } = args.flags;
    if (Boolean(product) === Boolean(conversation)) throw new HatchError(`Usage: hatch ${this.usage}`, { code: "usage" });
    const key = args.flags.key ?? randomUUID();
    const id = conversation ?? await startConversation(ctx, product, key);
    return send(ctx, await conversationApi(ctx, id), { content, flags: { ...args.flags, key }, where: `hatch conversation show ${id}`, extra: { conversation_id: id } });
  },
  format: formatSent,
  mcp: {
    name: "chat_send",
    description: "Send a message to a published Hatch product in Chat. Give product_id to start a conversation or conversation_id to continue one. wait is seconds to hold for the reply (max 120); without it the message is only accepted and the run id returned. Reuse client_message_id to retry a send without sending it twice.",
    inputSchema: object({
      product_id: { type: "string", description: "Start a new conversation with this product" }, ...conversationIdSchema,
      content: { type: "string", description: "The message" }, wait: { type: "number", description: "Seconds to wait for the reply, 0 to 120" },
      client_message_id: { type: "string", description: "Returned by the first call; pass it to retry" }
    }, ["content"]),
    toArgs: (i) => ({ _: [i.content], flags: { product: i.product_id, conversation: i.conversation_id, wait: i.wait, key: i.client_message_id } })
  }
};

const show = {
  name: "conversation show",
  describe: "Read a conversation: history, state, partial output and the cursor to resume from",
  usage: "conversation show <conversation-id>",
  options: {},
  async run(ctx, args) { const [id] = need(this, args, 1); return (await conversationApi(ctx, id)).snapshot(); },
  format: (r) => `${r.status ?? ""}${r.run_id ? `  run ${r.run_id}` : ""}${r.cursor ? `  cursor ${r.cursor}` : ""}\n${formatMessages(r)}`.trim(),
  mcp: { name: "conversation_show", description: "Read a Hatch Chat conversation: status, messages, the running run_id and the cursor.", inputSchema: object(conversationIdSchema, ["conversation_id"]), toArgs: (i) => ({ _: [i.conversation_id], flags: {} }) }
};

const watch = {
  name: "conversation watch",
  describe: "Stream a conversation's events, resuming after a cursor; closing it does not stop the Run",
  usage: "conversation watch <conversation-id> [--after <cursor>]",
  options: { after: { type: "string", describe: "Resume after this cursor" } },
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    const api = await conversationApi(ctx, id);
    return observe(ctx, resumable((after) => api.events(after), { sleep: ctx.sleep })(args.flags.after));
  },
  format: (r) => r.streamed ? "" : r.reply.text
};

const stop = {
  name: "conversation stop",
  describe: "Stop a running Run (the only way to cancel one)",
  usage: "conversation stop <conversation-id> <run-id>",
  options: {},
  async run(ctx, args) { const [id, run] = need(this, args, 2); return (await conversationApi(ctx, id)).cancel(run); },
  format: () => "Stop requested.",
  mcp: { name: "chat_stop", description: "Stop a running Hatch Chat run.", inputSchema: object({ ...conversationIdSchema, run_id: { type: "string" } }, ["conversation_id", "run_id"]), toArgs: (i) => ({ _: [i.conversation_id, i.run_id], flags: {} }) }
};

export const CHAT_COMMANDS = [conversations, ask, show, watch, stop];
