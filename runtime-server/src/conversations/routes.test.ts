import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agentEntries, assertAgentAvailable, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import type { Role, Session } from "../factoryAgents/store.js";
import type { AssistantHost } from "./assistantConversation.js";
import type { AssetScope } from "../assets/domain.js";
import type { AssetDesk } from "./assets.js";
import { ConversationError, type ReadyAsset } from "./conversation.js";
import { MemoryEventLog } from "./eventLog.js";
import { EventLogJournal } from "./journal.js";
import { MemoryMessageLedger } from "./ledger.js";
import { ConversationRoutes } from "./routes.js";
import type { WorkerWorkspace } from "./workerConversation.js";

// Explicit fakes for the transport, auth and 409/202 contracts; the real store and runtime are exercised in workerConversation.test.ts.
const TOKENS: Record<string, string> = { owner: "a1", stranger: "a2" };
const PRODUCT = "p1";

function session(role: Role, patch: Partial<Session> = {}): Session {
  return { id: `s-${role}`, role, title: role, createdAt: "t0", updatedAt: "t1", revision: 0, turn: 0, status: "idle", files: [], comments: [], messages: [], context: [], todos: [], ...patch };
}
const assistantLine = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 5, stopReason: "stop" }) as unknown as AgentMessage;

class FakeWorkspace implements WorkerWorkspace {
  /** Like the real runtime, it journals its own events from the start, whatever route is or is not watching. */
  constructor(log: MemoryEventLog) { const journal = new EventLogJournal(log, event => event.sessionId); this.events.on("event", event => journal.append(event)); }
  sessions: Session[] = [];
  private runs = new Map<string, string>();
  started: Array<{ id: string; text: string }> = [];
  steered: string[] = [];
  stopped: string[] = [];
  reply = "All done.";
  replyAfterMs = 20;
  events = new EventEmitter();
  private definitions = initialAgentDefinitions();
  manual = new Map<string, Buffer>();
  store = {
    backend: { writeManual: async (name: string, bytes: Buffer) => { this.manual.set(name, bytes); } },
    list: async () => this.sessions,
    create: async (role: Role) => { const created = session(role); this.sessions.push(created); return created; },
  };
  runtime = {
    events: this.events,
    send: async (id: string, message: AgentMessage) => {
      const target = this.sessions.find(s => s.id === id)!;
      const queued = target.status === "running";
      target.messages.push(message);
      if (queued) this.steered.push(id);
      else {
        this.runs.set(id, `run-${this.started.length + 1}`);
        this.started.push({ id, text: (message as unknown as { origin: { text: string } }).origin.text });
        target.status = "running";
        setTimeout(() => { target.messages.push(assistantLine(this.reply)); target.status = "idle"; this.runs.delete(id); this.events.emit("event", { sessionId: id, type: "run_end", status: "completed" }); }, this.replyAfterMs);
      }
      return { queued, runId: this.runs.get(id)! };
    },
    runId: (id: string) => this.runs.get(id),
    stop: (id: string) => { this.stopped.push(id); },
  };
  entries = async () => agentEntries(await this.definitions, this.sessions);
  assertRoleAvailable = async (role: Role) => assertAgentAvailable(await this.entries(), role);
}

class FakeAssistant implements AssistantHost {
  events = new EventEmitter();
  lines: Array<{ id: string; role: "expert" | "assistant"; text: string; at: string }> = [{ id: "m1", role: "assistant", text: "Hello", at: "2026-01-01T00:00:00.000Z" }];
  running = false;
  ingested: Array<{ id: string; source: string; text: string; images?: string[]; attachments?: Array<{ type: string; name: string; assetId: string }> }> = [];
  stopped = 0;
  /** Looks at the world the moment a message is delivered. */
  onDelivery: () => void = () => undefined;
  view = async () => ({ messages: this.lines, running: this.running, ...(this.running ? { runId: "arun-1" } : {}) });
  submit = async (_account: string, item: { id: string; source: "web"; text: string; images?: string[]; attachments?: Array<{ type: "image" | "file" | "audio"; name: string; assetId: string }> }) => {
    this.onDelivery();
    this.ingested.push(item);
    this.running = true;
    setTimeout(() => { this.lines.push({ id: item.id, role: "expert", text: item.text, at: "t" }, { id: "m9", role: "assistant", text: "Noted.", at: "t" }); this.running = false; }, 20);
    return { runId: "arun-1" };
  };
  /** The desk here is a fake and ignores it. */
  workshop = () => ({ files: { writeManual: async () => undefined }, place: () => "" });
  stop = async () => { this.stopped++; };
}

const IMAGE: ReadyAsset = { id: "a-img", kind: "image", name: "chart.png", mimeType: "image/png", bytes: 10, sha256: "h-img", path: "input/manual/chart.png" };
const NOTES: ReadyAsset = { id: "a-doc", kind: "file", name: "notes.pdf", mimeType: "application/pdf", bytes: 2048, sha256: "h-doc", path: "input/manual/notes.pdf" };
/** An explicit fake of the upload side; the real one runs in pipelineAssets.test.ts. */
class FakeDesk implements AssetDesk {
  staged: string[] = [];
  attached: Array<{ ids: string[]; messageId: string }> = [];
  uploads: Array<{ name: string; bytes: number }> = [];
  /** Assets that already belong to a message. */
  used = new Set<string>();
  constructor(private files: Map<string, Buffer>) {}
  resolve = async (scope: AssetScope, id: string) => {
    if (scope.kind !== "account" || scope.accountId !== "a1") return undefined;
    const asset = id === "a-img" ? IMAGE : id === "a-doc" ? NOTES : id === "a-used" ? { ...NOTES, id: "a-used" } : undefined;
    return id === "a-wait" ? "pending" as const : asset && this.used.has(id) ? { ...asset, messageId: "old" } : asset;
  };
  stage = async (_scope: unknown, assets: readonly ReadyAsset[]) => { for (const asset of assets) { this.staged.push(asset.path); this.files.set(asset.path, Buffer.from("bytes")); } };
  attach = async (_scope: unknown, assets: readonly ReadyAsset[], messageId: string) => { this.attached.push({ ids: assets.map(asset => asset.id), messageId }); };
  release = async (_scope: unknown, assets: readonly ReadyAsset[], messageId: string) => { this.attached = this.attached.filter(entry => entry.messageId !== messageId || !assets.some(asset => entry.ids.includes(asset.id))); };
  upload = async (_scope: unknown, input: { name: string; bytes: Buffer }) => {
    if (input.name === "bad.exe") throw new ConversationError(415, "unsupported_type", "Not a supported file type.");
    this.uploads.push({ name: input.name, bytes: input.bytes.length });
    return { asset_id: "a-new", kind: "file" as const, name: input.name, bytes: input.bytes.length, state: "ready" as const };
  };
}

async function harness(options: { assistant?: boolean } = { assistant: true }) {
  const eventLog = new MemoryEventLog();
  const workspace = new FakeWorkspace(eventLog);
  const assistant = new FakeAssistant();
  const desk = new FakeDesk(workspace.manual);
  const routes = new ConversationRoutes({
    authenticate: async request => { const token = request.headers.authorization?.replace(/^Bearer /, ""); return token && TOKENS[token] ? { id: TOKENS[token]! } : undefined; },
    token: request => request.headers.authorization?.replace(/^Bearer /, ""),
    product: async (account, id) => account === "a1" && id === PRODUCT ? {} : undefined,
    workspace: async () => workspace,
    assistant: () => options.assistant === false ? undefined : assistant,
    json: (response, status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); },
    readJson: async request => { let body = ""; for await (const chunk of request) body += chunk; return JSON.parse(body || "{}"); },
    readBytes: async request => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); return Buffer.concat(chunks); },
    eventLog, ledger: new MemoryMessageLedger(), assets: () => desk,
    pace: { pollMs: 5 },
  });
  const server = http.createServer((req, res) => { void routes.handle(req, res, new URL(req.url!, "http://x")).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, init: { method?: string; token?: string | null; body?: unknown; signal?: AbortSignal } = {}) => fetch(`${base}${path}`, {
    method: init.method ?? "GET", signal: init.signal,
    headers: { ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? "owner"}` }), "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { workspace, assistant, desk, call, base, close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}
const root = `/v1/creator/products/${PRODUCT}/workers`;

test("workers: authentication, ownership and unknown routes", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call(root, { token: null })).status, 401);
    assert.equal((await h.call(root, { token: "stranger" })).status, 404, "another account's product is not found");
    assert.equal((await h.call("/v1/creator/products/other/workers")).status, 404);
    const unknown = await h.call(`${root}/nobody/messages`);
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "worker_not_found");
    assert.equal((await h.call(`${root}/generation/messages`)).status, 404, "internal role names are not worker ids");
    assert.equal((await h.call(`${root}/research/stop`, { method: "GET" })).status, 405);
    assert.equal((await h.call("/v1/creator/products/p1/other")).status, 404, "paths that are not conversations are not handled here");
    assert.equal(h.workspace.started.length, 0);
  } finally { await h.close(); }
});

test("workers: list shows availability and status", async () => {
  const h = await harness();
  try {
    h.workspace.sessions.push(session("research", { status: "running", updatedAt: "t9" }));
    const { workers } = await (await h.call(root)).json() as { workers: Array<Record<string, unknown>> };
    assert.deepEqual(workers.map(w => w.id), ["research", "interview", "builder", "cases", "evaluator"]);
    assert.deepEqual(workers[0], { id: "research", name: "Deep Research", availability: "available", status: "running", conversation_id: "s-research", updated_at: "t9" });
    assert.equal(workers[2]!.availability, "locked");
    assert.deepEqual(workers[2]!.blocked_by, { missing_required: [], needs_one_of: ["research", "interview"] });
    assert.equal(workers[3]!.status, "idle");
    assert.equal("conversation_id" in workers[3]!, false);
  } finally { await h.close(); }
});

test("workers: a locked worker is 409 with the reason and nothing starts", async () => {
  const h = await harness();
  try {
    const response = await h.call(`${root}/cases/messages`, { method: "POST", body: { content: "go" } });
    assert.equal(response.status, 409);
    const { error } = await response.json() as { error: { code: string; message: string; details: unknown } };
    assert.equal(error.code, "worker_unavailable");
    assert.match(error.message, /builder must produce output first/);
    assert.deepEqual(error.details, { worker: "cases", missing_required: ["builder"], needs_one_of: [] });
    assert.equal(h.workspace.sessions.length, 0, "no conversation is created for a blocked worker");
    assert.equal(h.workspace.started.length, 0);
  } finally { await h.close(); }
});

test("workers: send answers 202 with the accepted message, creating the conversation once", async () => {
  const h = await harness();
  try {
    const bad = await h.call(`${root}/research/messages`, { method: "POST", body: { content: "  " } });
    assert.equal(bad.status, 400);
    const response = await h.call(`${root}/research/messages`, { method: "POST", body: { content: "Look into Alice" } });
    assert.equal(response.status, 202);
    const body = await response.json() as { conversation_id: string; message: { id: string; role: string; text: string }; status: string; queued: boolean };
    assert.equal(body.conversation_id, "s-research");
    assert.equal(body.status, "running");
    assert.equal(body.queued, false);
    assert.deepEqual([body.message.role, body.message.text], ["user", "Look into Alice"]);
    assert.deepEqual(h.workspace.started, [{ id: "s-research", text: "Look into Alice" }]);
    // The same message id is the one history shows, then the reply follows it.
    await new Promise(resolve => setTimeout(resolve, 60));
    const history = await (await h.call(`${root}/research/messages`)).json() as { status: string; messages: Array<{ id: string; role: string; text: string }> };
    assert.equal(history.status, "idle");
    assert.deepEqual(history.messages.map(m => [m.role, m.text]), [["user", "Look into Alice"], ["assistant", "All done."]]);
    assert.equal(history.messages[0]!.id, body.message.id);
    const after = await (await h.call(`${root}/research/messages?after=${body.message.id}`)).json() as { messages: unknown[] };
    assert.equal(after.messages.length, 1);
    assert.equal((await h.call(`${root}/research/messages?after=nope`)).status, 400);
    assert.equal(h.workspace.sessions.length, 1);
  } finally { await h.close(); }
});

test("workers: a message to a running worker is steered and says queued", async () => {
  const h = await harness();
  try {
    h.workspace.sessions.push(session("research", { status: "running" }));
    const response = await h.call(`${root}/research/messages`, { method: "POST", body: { content: "Also check LinkedIn" } });
    assert.equal(response.status, 202);
    assert.equal(((await response.json()) as { queued: boolean }).queued, true);
    assert.deepEqual(h.workspace.steered, ["s-research"]);
    assert.equal(h.workspace.started.length, 0);
  } finally { await h.close(); }
});

test("workers: wait holds until the reply, or returns the running status at the timeout", async () => {
  const h = await harness();
  try {
    const done = await h.call(`${root}/research/messages?wait=30`, { method: "POST", body: { content: "Summarize" } });
    assert.equal(done.status, 200);
    const body = await done.json() as { status: string; reply: { role: string; text: string }; message: { text: string } };
    assert.equal(body.status, "idle");
    assert.deepEqual([body.reply.role, body.reply.text, body.message.text], ["assistant", "All done.", "Summarize"]);
    h.workspace.replyAfterMs = 60_000;
    const slow = await h.call(`${root}/research/messages?wait=0.05`, { method: "POST", body: { content: "Again" } });
    assert.equal(slow.status, 202);
    const pending = await slow.json() as { status: string; reply?: unknown };
    assert.equal(pending.status, "running");
    assert.equal(pending.reply, undefined);
    assert.equal((await h.call(`${root}/research/messages?wait=abc`, { method: "POST", body: { content: "x" } })).status, 400);
  } finally { h.workspace.sessions.forEach(s => { s.status = "idle"; }); await h.close(); }
});

test("workers: stop is 202, events stream the session's own events only", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call(`${root}/research/events`)).status, 404, "no conversation before the first message");
    h.workspace.sessions.push(session("research", { status: "running" }), session("evaluator"));
    const controller = new AbortController();
    const stream = await h.call(`${root}/research/events`, { signal: controller.signal });
    assert.match(stream.headers.get("content-type")!, /text\/event-stream/);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    h.workspace.events.emit("event", { sessionId: "s-evaluator", type: "delta", text: "not mine" });
    h.workspace.events.emit("event", { sessionId: "s-research", type: "voice.delta", text: "internal" });
    h.workspace.events.emit("event", { sessionId: "s-research", type: "delta", text: "hello" });
    const chunk = decoder.decode((await reader.read()).value);
    assert.equal(chunk, 'id: 1\ndata: {"type":"delta","text":"hello"}\n\n', "the SSE id is the log cursor");
    controller.abort();
    const stop = await h.call(`${root}/research/stop`, { method: "POST" });
    assert.equal(stop.status, 202);
    assert.deepEqual(h.workspace.stopped, ["s-research"]);
  } finally { await h.close(); }
});

test("assistant: same shape and verbs, over the existing Assistant", async () => {
  const h = await harness();
  try {
    const path = "/v1/creator/assistant/conversation";
    assert.equal((await h.call(`${path}/messages`, { token: null })).status, 401);
    const history = await (await h.call(`${path}/messages`)).json() as { status: string; messages: Array<Record<string, unknown>> };
    assert.deepEqual(history, { status: "idle", messages: [{ id: "m1", role: "assistant", text: "Hello", created_at: "2026-01-01T00:00:00.000Z" }] });
    const sent = await h.call(`${path}/messages?wait=30`, { method: "POST", body: { content: "Remind me tomorrow" } });
    assert.equal(sent.status, 200);
    const body = await sent.json() as { message: { id: string; role: string }; reply: { text: string }; status: string };
    assert.equal(body.reply.text, "Noted.");
    assert.equal(body.message.role, "user");
    assert.equal((body as unknown as { run_id: string }).run_id, "arun-1", "the Assistant's turn has a Run of its own");
    assert.equal(h.assistant.ingested[0]!.id, body.message.id);
    assert.equal(h.assistant.ingested[0]!.source, "web");
    const after = await (await h.call(`${path}/messages?after=m1`)).json() as { messages: Array<{ role: string; text: string }> };
    assert.deepEqual(after.messages.map(m => [m.role, m.text]), [["user", "Remind me tomorrow"], ["assistant", "Noted."]]);
    assert.equal((await h.call(`${path}/stop`, { method: "POST" })).status, 202);
    assert.equal(h.assistant.stopped, 1);
  } finally { await h.close(); }
});

test("assistant: 503 when the Registry has no database", async () => {
  const h = await harness({ assistant: false });
  try {
    const response = await h.call("/v1/creator/assistant/conversation/messages");
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "assistant_unavailable");
  } finally { await h.close(); }
});

const post = (h: Awaited<ReturnType<typeof harness>>, body: unknown, query = "", headers: Record<string, string> = {}) =>
  fetch(`${h.base}${root}/research/messages${query}`, { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("idempotency: same key and content is one message, other content is 409", async () => {
  const h = await harness();
  try {
    const key = { "idempotency-key": "client-1" };
    const first = await (await post(h, { content: "Look into Alice" }, "", key)).json() as { message: { id: string } };
    const again = await post(h, { content: "Look into Alice" }, "", key);
    assert.equal(again.status, 202);
    assert.equal(((await again.json()) as { message: { id: string } }).message.id, first.message.id, "the original message comes back");
    assert.equal(h.workspace.started.length, 1, "delivered once");
    const conflict = await post(h, { content: "Something else" }, "", key);
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, "idempotency_conflict");
    assert.equal(((await (await post(h, { content: "Look into Alice", idempotency_key: "client-1" })).json()) as { message: { id: string } }).message.id, first.message.id, "the key may travel in the body");
    const unkeyed = await (await post(h, { content: "Look into Alice" })).json() as { message: { id: string } };
    assert.notEqual(unkeyed.message.id, first.message.id, "without a key a repeat is a new message");
  } finally { await h.close(); }
});

test("attachments: parts resolve to ready assets; pending, missing and mismatched assets are refused", async () => {
  const h = await harness();
  try {
    const ok = await post(h, { content: [{ type: "text", text: "see these" }, { type: "image", assetId: "a-img" }, { type: "file", assetId: "a-doc" }] });
    assert.equal(ok.status, 202);
    const body = await ok.json() as { message: { attachments: unknown[] } };
    assert.deepEqual(body.message.attachments, [{ type: "image", name: "chart.png", asset_id: "a-img" }, { type: "file", name: "notes.pdf", asset_id: "a-doc" }]);
    const stored = h.workspace.sessions[0]!.messages[0] as unknown as { content: Array<{ type: string; text?: string; data?: string }>; origin: { text: string } };
    assert.equal(stored.origin.text, "see these");
    assert.equal(stored.content[0]!.text, "see these\n[file: notes.pdf (application/pdf, 2048 bytes) at input/manual/notes.pdf]", "a file is one line for the model");
    assert.equal(stored.content[1]!.data, "hatch-file:input/manual/chart.png", "an image is a path reference");
    const refused = async (assetId: string, type = "image") => { const r = await post(h, { content: [{ type, assetId }] }); return [r.status, ((await r.json()) as { error: { code: string } }).error.code]; };
    assert.deepEqual(await refused("a-wait"), [409, "asset_not_ready"]);
    assert.deepEqual(await refused("nope"), [404, "asset_not_found"]);
    assert.deepEqual(await refused("a-doc", "image"), [400, "asset_kind_mismatch"]);
    assert.equal((await post(h, { content: [{ type: "image" }] })).status, 400);
    assert.equal((await post(h, { content: "x", client: "fax" })).status, 400, "an unknown client is refused");
  } finally { await h.close(); }
});

test("snapshot and events share one cursor: replay from it has no gap and no duplicate", async () => {
  const h = await harness();
  try {
    h.workspace.sessions.push(session("research", { status: "running" }));
    const emit = (type: string, extra: Record<string, unknown> = {}) => h.workspace.events.emit("event", { sessionId: "s-research", type, ...extra });
    emit("message_end"); emit("delta", { text: "Hel" }); emit("delta", { text: "lo" });
    await new Promise(resolve => setTimeout(resolve, 30));
    const snapshot = await (await h.call(`${root}/research/snapshot`)).json() as { cursor: string; status: { state: string }; partial: string; messages: unknown[] };
    assert.deepEqual([snapshot.cursor, snapshot.status.state, snapshot.partial], ["3", "running", "Hello"], "partial output is what has streamed since the last finished message");
    emit("delta", { text: "!" }); emit("tool", { name: "list" });
    await new Promise(resolve => setTimeout(resolve, 30));
    const replay = async (init: { path?: string; headers?: Record<string, string> }) => {
      const controller = new AbortController();
      const response = await fetch(`${h.base}${root}/research/events${init.path ?? ""}`, { signal: controller.signal, headers: { authorization: "Bearer owner", ...init.headers } });
      const reader = response.body!.getReader(); let text = "";
      while (!text.includes("tool")) text += new TextDecoder().decode((await reader.read()).value);
      controller.abort();
      return text;
    };
    const expected = ': connected\n\nid: 4\ndata: {"type":"delta","text":"!"}\n\nid: 5\ndata: {"type":"tool","name":"list"}\n\n';
    assert.equal(await replay({ path: `?after=${snapshot.cursor}` }), expected);
    assert.equal(await replay({ headers: { "last-event-id": snapshot.cursor } }), expected, "Last-Event-ID resumes the same way");
    assert.equal((await h.call(`${root}/research/events?after=99`)).status, 400, "a cursor the log never issued");
    assert.equal((await h.call(`${root}/research/events?after=x`)).status, 400);
    assert.deepEqual(h.workspace.stopped, [], "watching and unwatching never stops the Run");
  } finally { await h.close(); }
});

test("wait timeout answers 202 with the run to follow; Accept: text/event-stream streams the turn to its end", async () => {
  const h = await harness();
  try {
    h.workspace.replyAfterMs = 80;
    const slow = await post(h, { content: "Slow one" }, "?wait=0.02");
    assert.equal(slow.status, 202);
    const pending = await slow.json() as { run_id: string; cursor: string; status: string };
    assert.deepEqual([pending.run_id, pending.cursor, pending.status], ["run-1", "0", "running"], "the Run is not the conversation");
    await new Promise(resolve => setTimeout(resolve, 150));
    h.workspace.replyAfterMs = 40;
    const streamed = await post(h, { content: "Stream it" }, "", { accept: "text/event-stream" });
    assert.match(streamed.headers.get("content-type")!, /text\/event-stream/);
    const text = await streamed.text();
    assert.match(text, /^: connected\n\nevent: accepted\ndata: \{.*"text":"Stream it".*\}\n\n/);
    assert.match(text, /id: \d+\ndata: \{"type":"run_end","status":"completed"\}\n\n/);
    assert.match(text, /event: done\ndata: \{\}\n\n$/);
  } finally { await h.close(); }
});

test("snapshot names the Run in progress, which is not the conversation", async () => {
  const h = await harness();
  try {
    const sent = await (await post(h, { content: "Go" })).json() as { run_id: string; conversation_id: string };
    assert.equal(sent.run_id, "run-1");
    assert.notEqual(sent.run_id, sent.conversation_id);
    const snapshot = await (await h.call(`${root}/research/snapshot`)).json() as { run_id?: string; status: { state: string } };
    assert.deepEqual([snapshot.status.state, snapshot.run_id], ["running", "run-1"]);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(((await (await h.call(`${root}/research/snapshot`)).json()) as { run_id?: string }).run_id, undefined, "no Run, no run_id");
  } finally { await h.close(); }
});

test("attachments: staged before delivery, bound to the accepted message, and a replay binds nothing twice", async () => {
  const h = await harness();
  try {
    const content = [{ type: "text", text: "see this" }, { type: "file", assetId: "a-doc" }];
    const first = await (await post(h, { content }, "", { "idempotency-key": "k-assets" })).json() as { message: { id: string } };
    assert.deepEqual(h.desk.staged, [NOTES.path], "the bytes were in the workspace before the message was delivered");
    assert.ok(h.workspace.manual.has(NOTES.path));
    assert.deepEqual(h.desk.attached, [{ ids: ["a-doc"], messageId: first.message.id }], "bound to the id the history shows");
    const again = await (await post(h, { content }, "", { "idempotency-key": "k-assets" })).json() as { message: { id: string } };
    assert.equal(again.message.id, first.message.id);
    assert.equal(h.desk.attached.length, 1, "a replay is not a second binding");
    assert.equal(h.desk.staged.length, 1);
  } finally { await h.close(); }
});

test("attachments: an asset that already belongs to a message is refused before anything is delivered", async () => {
  const h = await harness();
  try {
    h.desk.used.add("a-used");
    const response = await post(h, { content: [{ type: "file", assetId: "a-used" }] });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, "asset_already_used");
    assert.equal(h.workspace.started.length, 0);
    assert.deepEqual(h.desk.attached, []);
  } finally { await h.close(); }
});

test("upload: the body is the file, the name is a query parameter; refusals say why", async () => {
  const h = await harness();
  try {
    const upload = (query: string, body: string) => fetch(`${h.base}${root}/research/assets${query}`, { method: "POST", headers: { authorization: "Bearer owner" }, body: body || undefined });
    const ok = await upload("?name=notes.txt", "hello");
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { asset_id: "a-new", kind: "file", name: "notes.txt", bytes: 5, state: "ready" });
    assert.equal((await upload("", "hello")).status, 400, "a file needs a name");
    assert.equal((await upload("?name=empty.txt", "")).status, 400);
    const refused = await upload("?name=bad.exe", "MZ");
    assert.deepEqual([refused.status, ((await refused.json()) as { error: { code: string } }).error.code], [415, "unsupported_type"]);
    assert.equal((await fetch(`${h.base}${root}/research/assets?name=a.txt`, { method: "POST", body: "x" })).status, 401);
    assert.equal((await fetch(`${h.base}${root}/research/assets?name=a.txt`, { headers: { authorization: "Bearer owner" } })).status, 405);
  } finally { await h.close(); }
});

test("the Assistant takes attachments like a worker: upload, bound to the message before delivery, run_id returned", async () => {
  const h = await harness();
  try {
    const path = "/v1/creator/assistant/conversation";
    const upload = await fetch(`${h.base}${path}/assets?name=notes.txt`, { method: "POST", headers: { authorization: "Bearer owner" }, body: "hello" });
    assert.deepEqual([upload.status, ((await upload.json()) as { asset_id: string }).asset_id], [201, "a-new"]);
    assert.equal((await fetch(`${h.base}${path}/assets?name=a.txt`, { method: "POST", body: "x" })).status, 401);
    let boundAtDelivery: unknown;
    h.assistant.onDelivery = () => { boundAtDelivery = [...h.desk.attached]; };
    const sent = await (await h.call(`${path}/messages`, { method: "POST", body: { content: [{ type: "text", text: "see this" }, { type: "image", assetId: "a-img" }, { type: "file", assetId: "a-doc" }] } })).json() as { run_id: string; message: { id: string; attachments: unknown[] } };
    assert.equal(sent.run_id, "arun-1");
    assert.deepEqual(boundAtDelivery, [{ ids: ["a-img", "a-doc"], messageId: sent.message.id }], "bound before the Assistant sees the message, to the id the history shows");
    assert.deepEqual(sent.message.attachments, [{ type: "image", name: "chart.png", asset_id: "a-img" }, { type: "file", name: "notes.pdf", asset_id: "a-doc" }]);
    const item = h.assistant.ingested[0]!;
    assert.deepEqual(item.images, [IMAGE.path]);
    assert.match(item.text, /^see this\n\[file: notes\.pdf/);
    assert.deepEqual(item.attachments, [{ type: "image", name: "chart.png", assetId: "a-img" }, { type: "file", name: "notes.pdf", assetId: "a-doc" }]);
  } finally { await h.close(); }
});
