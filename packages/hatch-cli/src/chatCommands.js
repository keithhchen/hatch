import { randomUUID } from "node:crypto";
import { HatchError } from "./errors.js";
import { need, object } from "./command.js";
import { ACTIVE, ConversationApi, chatRoutes, formatMessages, formatSent, keyed, observe, send, sendOptions, watchEvents } from "./conversation.js";

// Consumer Chat: a conversation between the signed-in account and a published Product.
// The Runtime binds every call to a Product through `?product_id=`, so every command needs --product.
const productOf = (command, args) => {
  if (!args.flags.product) throw new HatchError(`Usage: hatch ${command.usage}`, { code: "usage" });
  return args.flags.product;
};
const conversationApi = async (ctx, id, product) => new ConversationApi(await ctx.client(), chatRoutes(id, product));
const conversationIdSchema = { conversation_id: { type: "string", description: "Conversation id" } };
const productIdSchema = { product_id: { type: "string", description: "The published product the conversation belongs to" } };
const productOption = { product: { type: "string", describe: "The published product the conversation belongs to" } };

// client_request_id is derived from the send's key, so a retried send continues the same conversation (200, created: false).
// --brief field=value answers the product's Brief; the Runtime's 422 names the fields it requires.
const briefAnswers = (flags) => [].concat(flags.brief ?? []).map((pair) => {
  const at = pair.indexOf("=");
  if (at < 1) throw new HatchError("--brief takes field=value.", { code: "usage" });
  return { field_id: pair.slice(0, at), value: pair.slice(at + 1) };
});
async function startConversation(ctx, product, key, flags) {
  const answers = briefAnswers(flags);
  const r = await (await ctx.client()).post(`/v1/conversations?product_id=${encodeURIComponent(product)}`, { client_request_id: `${key}:conversation`, ...(answers.length ? { brief_answers: answers } : {}) });
  return r.conversation.id;
}

const conversations = {
  name: "conversations",
  describe: "List your Chat conversations with a product",
  usage: "conversations --product <id> [--cursor <next_cursor>]",
  options: { ...productOption, cursor: { type: "string", describe: "next_cursor of the previous page" } },
  async run(ctx, args) {
    const product = productOf(this, args);
    const cursor = args.flags.cursor ? `&cursor=${encodeURIComponent(args.flags.cursor)}` : "";
    return (await ctx.client()).get(`/v1/conversations?product_id=${encodeURIComponent(product)}${cursor}`);
  },
  format: (r) => r.conversations.length
    ? r.conversations.map((c) => `${c.id}  ${c.title ?? ""}  ${c.updated_at ?? ""}`).join("\n") + (r.next_cursor ? `\nMore: --cursor ${r.next_cursor}` : "")
    : "No conversations.",
  mcp: {
    name: "conversations_list", description: "List the account's Hatch Chat conversations with a published product. Returns conversations and next_cursor.",
    inputSchema: object({ ...productIdSchema, cursor: { type: "string", description: "next_cursor of the previous page" } }, ["product_id"]),
    toArgs: (i) => ({ _: [], flags: { product: i.product_id, cursor: i.cursor } })
  }
};

const ask = {
  name: "ask",
  describe: "Chat with a published product; --conversation continues one, otherwise a new one starts",
  usage: "ask <message...> --product <id> [--conversation <id>] [--brief field=value]... [--wait[=N]] [--stream] [--key <client_message_id>]",
  options: { ...productOption, conversation: { type: "string", describe: "Continue this conversation (default: start a new one)" }, brief: { type: "string", describe: "Answer a Brief field when starting a conversation; repeatable" }, ...sendOptions },
  async run(ctx, args) {
    const content = need(this, args, 1).join(" ");
    const product = productOf(this, args);
    const key = args.flags.key ?? randomUUID();
    return keyed(key, async () => {
      const id = args.flags.conversation ?? await startConversation(ctx, product, key, args.flags);
      return send(ctx, await conversationApi(ctx, id, product), { content, flags: { ...args.flags, key }, where: `hatch conversation show ${id} --product ${product}`, extra: { conversation_id: id } });
    });
  },
  format: formatSent,
  mcp: {
    name: "chat_send",
    description: "Send a message to a published Hatch product in Chat. product_id is required; give conversation_id to continue a conversation, otherwise one starts. wait is seconds to hold for the reply (max 60); without it the message is only accepted and the run id returned. Reuse client_message_id to retry a send without sending it twice.",
    inputSchema: object({
      ...productIdSchema, conversation_id: { type: "string", description: "Continue this conversation (default: start a new one)" },
      brief_answers: { type: "object", additionalProperties: { type: "string" }, description: "When starting a conversation: answers to the product's Brief as {field_id: value}. A refusal names the required fields." },
      content: { type: "string", description: "The message" }, wait: { type: "number", description: "Seconds to wait for the reply, 0 to 60" },
      client_message_id: { type: "string", description: "Returned by the first call; pass it to retry" }
    }, ["product_id", "content"]),
    toArgs: (i) => ({ _: [i.content], flags: { product: i.product_id, conversation: i.conversation_id, wait: i.wait, key: i.client_message_id, brief: Object.entries(i.brief_answers ?? {}).map(([field, value]) => `${field}=${value}`) } })
  }
};

const show = {
  name: "conversation show",
  describe: "Read a conversation: runs, messages and the cursor to resume from",
  usage: "conversation show <conversation-id> --product <id>",
  options: productOption,
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    const r = await (await conversationApi(ctx, id, productOf(this, args))).snapshot();
    // The Run that has not ended, else the last one.
    const run = r.runs.find((x) => ACTIVE.has(x.status)) ?? r.runs.at(-1);
    return { ...r, run_id: run?.id, status: run?.status };
  },
  format: (r) => `${r.status ?? ""}${r.run_id ? `  run ${r.run_id}` : ""}${r.cursor !== undefined ? `  cursor ${r.cursor}` : ""}\n${formatMessages(r)}`.trim(),
  mcp: { name: "conversation_show", description: "Read a Hatch Chat conversation: status and run_id of its latest Run, messages and the cursor.", inputSchema: object({ ...productIdSchema, ...conversationIdSchema }, ["product_id", "conversation_id"]), toArgs: (i) => ({ _: [i.conversation_id], flags: { product: i.product_id } }) }
};

const watch = {
  name: "conversation watch",
  describe: "Stream a conversation's events until a Run ends; closing it does not stop the Run",
  usage: "conversation watch <conversation-id> --product <id> [--after <cursor>]",
  options: { ...productOption, after: { type: "string", describe: "Resume after this cursor (default: the answer so far, then live)" } },
  async run(ctx, args) {
    const [id] = need(this, args, 1);
    const api = await conversationApi(ctx, id, productOf(this, args));
    return observe(ctx, watchEvents(api, args.flags.after, ctx));
  },
  format: (r) => r.streamed ? "" : r.reply.text
};

const stop = {
  name: "conversation stop",
  describe: "Stop a running Run (the only way to cancel one)",
  usage: "conversation stop <conversation-id> <run-id> --product <id>",
  options: productOption,
  async run(ctx, args) { const [id, run] = need(this, args, 2); return (await conversationApi(ctx, id, productOf(this, args))).cancel(run); },
  format: (r) => `${r.run.id} ${r.run.status}`,
  mcp: { name: "chat_stop", description: "Stop a running Hatch Chat run.", inputSchema: object({ ...productIdSchema, ...conversationIdSchema, run_id: { type: "string" } }, ["product_id", "conversation_id", "run_id"]), toArgs: (i) => ({ _: [i.conversation_id, i.run_id], flags: { product: i.product_id } }) }
};

export const CHAT_COMMANDS = [conversations, ask, show, watch, stop];
