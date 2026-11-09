import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { agentEntries, assertAgentAvailable, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import type { Role, Session } from "../factoryAgents/store.js";
import type { AssistantHost } from "./assistantConversation.js";
import { MemoryEventLog } from "./eventLog.js";
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
  sessions: Session[] = [];
  started: Array<{ id: string; text: string }> = [];
  steered: string[] = [];
  stopped: string[] = [];
  reply = "All done.";
  replyAfterMs = 20;
  events = new EventEmitter();
  private definitions = initialAgentDefinitions();
  store = {
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
        this.started.push({ id, text: (message as unknown as { origin: { text: string } }).origin.text });
        target.status = "running";
        setTimeout(() => { target.messages.push(assistantLine(this.reply)); target.status = "idle"; }, this.replyAfterMs);
      }
      return { queued };
    },
    stop: (id: string) => { this.stopped.push(id); },
  };
  entries = async () => agentEntries(await this.definitions, this.sessions);
  assertRoleAvailable = async (role: Role) => assertAgentAvailable(await this.entries(), role);
}

class FakeAssistant implements AssistantHost {
  events = new EventEmitter();
  lines: Array<{ id: string; role: "expert" | "assistant"; text: string; at: string }> = [{ id: "m1", role: "assistant", text: "Hello", at: "2026-01-01T00:00:00.000Z" }];
  running = false;
  ingested: Array<{ id: string; source: string; text: string }> = [];
  stopped = 0;
  view = async () => ({ messages: this.lines, running: this.running });
  ingest = async (_account: string, item: { id: string; source: "web"; text: string }) => {
    this.ingested.push(item);
    this.running = true;
    setTimeout(() => { this.lines.push({ id: item.id, role: "expert", text: item.text, at: "t" }, { id: "m9", role: "assistant", text: "Noted.", at: "t" }); this.running = false; }, 20);
    return true;
  };
  stop = async () => { this.stopped++; };
}

async function harness(options: { assistant?: boolean } = { assistant: true }) {
  const workspace = new FakeWorkspace();
  const assistant = new FakeAssistant();
  const routes = new ConversationRoutes({
    authenticate: async request => { const token = request.headers.authorization?.replace(/^Bearer /, ""); return token && TOKENS[token] ? { id: TOKENS[token]! } : undefined; },
    token: request => request.headers.authorization?.replace(/^Bearer /, ""),
    product: async (account, id) => account === "a1" && id === PRODUCT ? {} : undefined,
    workspace: async () => workspace,
    assistant: () => options.assistant === false ? undefined : assistant,
    json: (response, status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); },
    readJson: async request => { let body = ""; for await (const chunk of request) body += chunk; return JSON.parse(body || "{}"); },
    eventLog: new MemoryEventLog(), ledger: new MemoryMessageLedger(),
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
  return { workspace, assistant, call, close: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
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
