import { randomUUID } from "node:crypto";
import { HatchError } from "./errors.js";
import { RunObserver, parseSse, resumable } from "./run.js";

const enc = encodeURIComponent;

// Adapters: where a conversation lives. The same ConversationApi runs over any of them.
// `scope` is added to every query; `afterParam` names the snapshot's cursor parameter (events always resume with `after_cursor`); `sent` shapes a send answer.
export const chatRoutes = (id, product) => {
  const base = `/v1/conversations/${enc(id)}`;
  return {
    messages: `${base}/messages`, events: `${base}/events`, snapshot: `${base}/snapshot`, cancel: (run) => `${base}/runs/${enc(run)}/cancel`,
    scope: { product_id: product }, afterParam: "after_cursor",
    // Runtime answers 200 {run, outcome, reply} or 202 {run_id, outcome, status}.
    sent: (r) => r.run ? { run_id: r.run.id, outcome: r.outcome, status: r.run.status, reply: { text: r.reply } } : r
  };
};
export const workerRoutes = (productId, worker) => {
  const base = `/v1/creator/products/${enc(productId)}/workers/${enc(worker)}`;
  return { messages: `${base}/messages`, events: `${base}/events`, snapshot: `${base}/messages`, cancel: () => `${base}/stop`, afterParam: "after" };
};
export const assistantRoutes = () => {
  const base = "/v1/creator/assistant/conversation";
  return { messages: `${base}/messages`, events: `${base}/events`, snapshot: `${base}/messages`, cancel: () => `${base}/stop`, afterParam: "after" };
};

const withQuery = (path, params) => {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join("&");
  return q ? `${path}?${q}` : path;
};
const sseOf = (bodyPromise) => (async function* () { yield* parseSse(await bodyPromise); })();

// Port to one conversation. `key` is the client_message_id: one per logical send, reused by every retry.
export class ConversationApi {
  constructor(client, routes) { this.client = client; this.routes = routes; }

  url(path, params = {}) { return withQuery(path, { ...this.routes.scope, ...params }); }
  async send({ content, key, wait }) {
    const r = await this.client.post(this.url(this.routes.messages, { wait }), { content, client_message_id: key }, { "idempotency-key": key });
    return this.routes.sent ? this.routes.sent(r) : r;
  }
  stream({ content, key }) {
    return sseOf(this.client.stream("POST", this.url(this.routes.messages), { content, client_message_id: key }, { "idempotency-key": key }));
  }
  events(after) { return sseOf(this.client.stream("GET", this.url(this.routes.events, { after_cursor: after }))); }
  snapshot(after) { return this.client.get(this.url(this.routes.snapshot, { [this.routes.afterParam]: after })); }
  cancel(runId) { return this.client.post(this.url(this.routes.cancel(runId)), {}); }
}

// --wait alone waits 60 s; MCP passes the seconds.
export const waitSeconds = (flag) => flag === true ? 60 : Number(flag) > 0 ? Number(flag) : 0;

const FAILED = new Set(["failed", "interrupted"]);
export const ACTIVE = new Set(["queued", "running", "waiting_for_tool", "compacting"]);

// A Chat text delta says where it sits in the Run's text, so text the reader already holds is skipped, never repeated.
class ChatRunObserver extends RunObserver {
  apply(event) {
    const delta = event.event === "assistant.delta" ? event.data.delta : undefined;
    if (delta?.kind !== "text" || typeof delta.offset !== "number") return super.apply(event);
    const skip = Math.max(0, this.text.length - delta.offset);
    return super.apply({ ...event, data: { ...event.data, delta: { ...delta, content: delta.content.slice(skip) } } });
  }
}

// A failed Run exits non-zero and says why on stderr, so a script and a person both see it.
const failed = (ctx, error) => {
  ctx.exitCode = 1;
  if (error?.message) ctx.log(`hatch: the Run failed (${error.code ?? "run_failed"}): ${error.message}`);
};

// Play a Run's events to the reader. Reading never cancels the Run; only `stop` does.
export async function observe(ctx, events) {
  const observer = new ChatRunObserver();
  const write = ctx.json ? () => {} : (text) => ctx.stdout.write(text);
  for await (const event of events) write(observer.apply(event));
  if (FAILED.has(observer.status)) failed(ctx, observer.error);
  return { ...(observer.error ? { error: observer.error } : {}), run_id: observer.runId, cursor: observer.cursor, status: observer.status, reply: { text: observer.text }, streamed: !ctx.json };
}

// Open a conversation at any moment: the answer so far, then everything after the snapshot's cursor.
// `after` resumes from a cursor instead.
export async function* watchEvents(api, after, { sleep }) {
  const follow = resumable((cursor) => api.events(cursor), { sleep });
  if (after) return yield* follow(after);
  const snapshot = await api.snapshot();
  const run = snapshot.runs?.find((r) => ACTIVE.has(r.status));
  if (run?.partial_output) yield { event: "assistant.delta", data: { run_id: run.id, delta: { kind: "text", content: run.partial_output, offset: 0 } } };
  yield* follow(String(snapshot.cursor));
}

// A send that failed without an answer may have been received. The error names its key: sending again with it is the same message, never a second one.
export async function keyed(key, run) {
  try { return await run(); } catch (error) {
    if (error instanceof HatchError && (error.code === "network" || error.status >= 500) && !error.clientMessageId) {
      error.message += `. The message may have been received: send it again with --key ${key} and it arrives once.`;
      error.clientMessageId = key;
    }
    throw error;
  }
}

// Send one logical message and return its outcome. `where` tells the reader how to look again.
export const send = (ctx, api, options) => {
  const key = options.flags.key ?? randomUUID();
  return keyed(key, () => sendKeyed(ctx, api, { ...options, flags: { ...options.flags, key } }));
};

async function sendKeyed(ctx, api, { content, flags, where, extra = {} }) {
  const key = flags.key;
  if (flags.stream) {
    const events = resumable((after) => after ? api.events(after) : api.stream({ content, key }), { sleep: ctx.sleep });
    return { ...extra, client_message_id: key, ...await observe(ctx, events()) };
  }
  const wait = waitSeconds(flags.wait);
  const r = { ...extra, client_message_id: key, ...await api.send({ content, key, wait }) };
  if (FAILED.has(r.status)) failed(ctx, r.error);
  if (wait && ACTIVE.has(r.status)) ctx.log(`Still running. Read the reply later with \`${where}\`.`);
  return r;
}

export const formatSent = (r) => r.streamed ? "" : r.reply ? r.reply.text : r.message?.id ?? r.run_id ?? r.client_message_id;

export const sendOptions = {
  wait: { type: "boolean", describe: "Hold up to 60 s for the reply (--wait=N for N seconds)" },
  stream: { type: "boolean", describe: "Print the reply as it arrives; resumes if the connection drops" },
  key: { type: "string", describe: "client_message_id: reuse it to retry a send safely (default: new)" }
};

export const formatMessages = (r) => [
  r.messages?.length
    ? r.messages.map((m) => `[${m.id ?? m.run_id}] ${m.role === "user" ? "you" : "assistant"} (${m.created_at ?? m.timestamp})\n${m.text ?? m.content}`).join("\n\n")
    : "No messages.",
  ...(r.status === "failed" && r.error?.message ? [`The last Run failed (${r.error.code}): ${r.error.message}`] : [])
].join("\n\n");
