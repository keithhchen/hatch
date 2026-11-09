import { randomUUID } from "node:crypto";
import { RunObserver, parseSse, resumable } from "./run.js";

const enc = encodeURIComponent;

// Adapters: where a conversation lives. The same ConversationApi runs over any of them.
export const chatRoutes = (id) => {
  const base = `/v1/conversations/${enc(id)}`;
  return { messages: `${base}/messages`, events: `${base}/events`, snapshot: `${base}/snapshot`, cancel: (run) => `${base}/runs/${enc(run)}/cancel` };
};
export const workerRoutes = (productId, worker) => {
  const base = `/v1/creator/products/${enc(productId)}/workers/${enc(worker)}`;
  return { messages: `${base}/messages`, events: `${base}/events`, snapshot: `${base}/messages`, cancel: () => `${base}/stop` };
};
export const assistantRoutes = () => {
  const base = "/v1/creator/assistant/conversation";
  return { messages: `${base}/messages`, events: `${base}/events`, snapshot: `${base}/messages`, cancel: () => `${base}/stop` };
};

const withQuery = (path, params) => {
  const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${enc(v)}`).join("&");
  return q ? `${path}?${q}` : path;
};
const sseOf = (bodyPromise) => (async function* () { yield* parseSse(await bodyPromise); })();

// Port to one conversation. `key` is the client_message_id: one per logical send, reused by every retry.
export class ConversationApi {
  constructor(client, routes) { this.client = client; this.routes = routes; }

  send({ content, key, wait }) {
    return this.client.post(withQuery(this.routes.messages, { wait }), { content, client_message_id: key }, { "idempotency-key": key });
  }
  stream({ content, key }) {
    return sseOf(this.client.stream("POST", this.routes.messages, { content, client_message_id: key }, { "idempotency-key": key }));
  }
  events(after) { return sseOf(this.client.stream("GET", withQuery(this.routes.events, { after }))); }
  snapshot(after) { return this.client.get(withQuery(this.routes.snapshot, { after })); }
  cancel(runId) { return this.client.post(this.routes.cancel(runId), {}); }
}

// --wait alone waits 60 s; MCP passes the seconds.
export const waitSeconds = (flag) => flag === true ? 60 : Number(flag) > 0 ? Number(flag) : 0;

// Play a Run's events to the reader. Reading never cancels the Run; only `stop` does.
export async function observe(ctx, events) {
  const observer = new RunObserver();
  const write = ctx.json ? () => {} : (text) => ctx.stdout.write(text);
  for await (const event of events) write(observer.apply(event));
  if (observer.status === "failed") ctx.exitCode = 1;
  return { run_id: observer.runId, cursor: observer.cursor, status: observer.status, reply: { text: observer.text }, streamed: !ctx.json };
}

// Send one logical message and return its outcome. `where` tells the reader how to look again.
export async function send(ctx, api, { content, flags, where, extra = {} }) {
  const key = flags.key ?? randomUUID();
  if (flags.stream) {
    const events = resumable((after) => after ? api.events(after) : api.stream({ content, key }), { sleep: ctx.sleep });
    return { ...extra, client_message_id: key, ...await observe(ctx, events()) };
  }
  const wait = waitSeconds(flags.wait);
  const r = { ...extra, client_message_id: key, ...await api.send({ content, key, wait }) };
  if (r.status === "failed") ctx.exitCode = 1;
  if (wait && r.status === "running") ctx.log(`Still running. Read the reply later with \`${where}\`.`);
  return r;
}

export const formatSent = (r) => r.streamed ? "" : r.reply ? r.reply.text : r.message?.id ?? r.run_id ?? r.client_message_id;

export const sendOptions = {
  wait: { type: "boolean", describe: "Hold up to 60 s for the reply (--wait=N for N seconds)" },
  stream: { type: "boolean", describe: "Print the reply as it arrives; resumes if the connection drops" },
  key: { type: "string", describe: "client_message_id: reuse it to retry a send safely (default: new)" }
};

export const formatMessages = (r) => r.messages?.length
  ? r.messages.map((m) => `[${m.id}] ${m.role === "user" ? "you" : "assistant"} (${m.created_at})\n${m.text}`).join("\n\n")
  : "No messages.";
