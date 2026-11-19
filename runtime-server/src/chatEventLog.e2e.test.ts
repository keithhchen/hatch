/**
 * The conversation's event log is the one source of what a chat page shows. Reloading at any moment of a Run, and reopening it later, shows
 * everything so far in the same order, then continues live: nothing missing, nothing twice.
 *
 * Real pieces: the Runtime server (HTTP + WebSocket, local store and Postgres), the real ConversationController / fold of @hatch/chat run in Node
 * over a Node transport, and a scripted model that streams the real agent events and freezes at gates the test releases. The oracle is an
 * independent raw WebSocket observer that never reloads, projected by a tiny reducer that shares no code with the client.
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";
import type { AgentRuntime } from "./agentRuntime.js";
import { chatCompactionAdapter } from "./compaction.js";
import { CompactionStrategy, policyFor } from "./compactionStrategy.js";
import { InMemoryConversationRepository, PostgresConversationRepository } from "./conversationRepository.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresStore } from "./postgresStore.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { RuntimeStore, localRuntimeAuthority } from "./store.js";

// The real client, straight from the monorepo (it is not a dependency of the Runtime).
const chat: any = await import(new URL("../../packages/chat/src/index.js", import.meta.url).href);

const binding = {
  creator_id: "22222222-2222-4222-8222-222222222222",
  user_id: "11111111-1111-4111-8111-111111111111",
  agent_id: "33333333-3333-4333-8333-333333333333",
  product_id: "33333333-3333-4333-8333-333333333333",
  corpus_digest: `sha256:${"b".repeat(64)}`
};
const helloScope = { creator_id: binding.creator_id, user_id: binding.user_id, product_id: binding.product_id };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => unknown, what: string | (() => string | Promise<string>), timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(8);
  }
  throw new Error(`Timed out waiting for ${typeof what === "function" ? await what() : what}`);
}


// ---------------------------------------------------------------- scripted model
type Item = Record<string, any>;
const big = () => ({ content: "x".repeat(50_000) });
const text = (...chunks: string[]): Item[] => chunks.map((content) => ({ type: "assistant.delta", delta: { kind: "text", content } }));
const thinking = (index: number, chunks: string[], end = true): Item[] => [
  { type: "assistant.delta", delta: { kind: "thinking_start", contentIndex: index } },
  ...chunks.map((delta) => ({ type: "assistant.delta", delta: { kind: "thinking_delta", contentIndex: index, delta } })),
  ...(end ? [{ type: "assistant.delta", delta: { kind: "thinking_end", contentIndex: index, content: chunks.join("") } }] : [])
];
const toolEvent = (id: string, status: "requested" | "completed", name = "web_lookup"): Item => ({
  type: "tool_call.delta", tool_call_id: id, name, locality: "server", approval: "none", status, arguments: { q: id },
  ...(status === "completed" ? { result: big() } : {})
});
const gate = (name: string): Item => ({ gate: name });

/** Runs a script of wire events, freezing at each gate until the test releases it. */
class Model {
  script: Item[] = [];
  private readonly gates = new Map<string, { reached: Promise<void>; mark: () => void; released: Promise<void>; release: () => void }>();
  attempts = 0;
  private gateOf(name: string) {
    let entry = this.gates.get(name);
    if (!entry) {
      let mark!: () => void; let release!: () => void;
      entry = { reached: new Promise<void>((r) => { mark = r; }), mark, released: new Promise<void>((r) => { release = r; }), release };
      this.gates.set(name, entry);
    }
    return entry;
  }
  /** A test that failed while the model was frozen must not leave the server unable to close. */
  releaseAll(): void { for (const entry of this.gates.values()) entry.release(); this.script = []; }
  reached(name: string): Promise<void> { return this.gateOf(name).reached; }
  release(name: string): void { this.gateOf(name).release(); }
  runtime(): AgentRuntime {
    const model = this;
    return { async *run(input: any, ctx: any) {
      model.attempts += 1;
      for (const item of model.script) {
        if (typeof item.gate === "string") {
          const entry = model.gateOf(item.gate);
          entry.mark();
          await Promise.race([entry.released, new Promise((_, reject) => ctx?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted"))))]);
        } else if (item.compact) {
          // Between tool steps the real Agent asks the Run's compaction whether the history needs room; a big enough history is summarized.
          const filler = Array.from({ length: 5 }, () => ({ role: "assistant", content: "filler ".repeat(1_500) }));
          await ctx.compactMessagesIfNeeded([...ctx.messages, ...filler], "mid_turn");
        } else if (item.claim) { await ctx.claimSteered?.(); } else if (typeof item.fail === "string") throw new Error(item.fail);
        else yield { ...item, run_id: input.run_id } as any;
      }
      yield { type: "turn.completed", run_id: input.run_id, finish_reason: "stop" } as any;
    } } as unknown as AgentRuntime;
  }
}

// ---------------------------------------------------------------- chaos proxy (TCP, in front of the Runtime)
type Link = { client: net.Socket; upstream: net.Socket; upgraded: boolean; held: Buffer[]; seenFrame: boolean };
class ChaosProxy {
  /** The first frame a client sends after the WebSocket upgrade (its hello) is delayed by this long, once. */
  helloDelayMs = 0;
  /** Frames from the Runtime to clients wait here while true. */
  holdDownstream = false;
  private readonly links = new Set<Link>();
  private readonly server: net.Server;
  port = 0;
  constructor(private readonly target: number) {
    this.server = net.createServer((client) => this.accept(client));
  }
  async listen(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }
  private accept(client: net.Socket): void {
    const link: Link = { client, upstream: net.connect(this.target, "127.0.0.1"), upgraded: false, held: [], seenFrame: false };
    this.links.add(link);
    let chain = Promise.resolve();
    client.on("data", (data) => {
      if (!link.upgraded) { link.upstream.write(data); return; }
      const delay = !link.seenFrame ? this.helloDelayMs : 0;
      if (!link.seenFrame) { link.seenFrame = true; this.helloDelayMs = 0; }
      chain = chain.then(async () => { if (delay) await sleep(delay); link.upstream.write(data); });
    });
    link.upstream.on("data", (data) => {
      if (!link.upgraded && data.toString("latin1", 0, 12).startsWith("HTTP/1.1 101")) link.upgraded = true;
      if (link.upgraded && this.holdDownstream) link.held.push(data); else client.write(data);
    });
    const end = () => { this.links.delete(link); client.destroy(); link.upstream.destroy(); };
    client.on("close", end); link.upstream.on("close", end); client.on("error", end); link.upstream.on("error", end);
  }
  releaseDownstream(): void {
    this.holdDownstream = false;
    for (const link of this.links) for (const data of link.held.splice(0)) link.client.write(data);
  }
  dropAll(): void { for (const link of [...this.links]) { link.client.destroy(); link.upstream.destroy(); } }
  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------- the page: a Node transport under the real controller
const ConversationTransport: any = chat.ConversationTransport;
const RuntimeConnection: any = chat.RuntimeConnection;

class NodeConnection extends RuntimeConnection {
  socket: WebSocket;
  constructor(private readonly conversationId: string, base: string, { onOpen, onEvent, onClose }: any) {
    super();
    this.socket = new WebSocket(`${base.replace("http:", "ws:")}/runtime`);
    this.socket.on("open", onOpen);
    this.socket.on("message", (data) => onEvent(JSON.parse(String(data))));
    this.socket.on("close", onClose);
    this.socket.on("error", () => undefined);
  }
  hello(localTools: string[], after?: number) { this.frame({ type: "client.hello", protocol_version: PROTOCOL_VERSION, conversation_id: this.conversationId, ...helloScope, license_token: "recovery-license", client_version: "hatch-web", local_tools: localTools, ...(after != null ? { after } : {}) }); }
  send({ runId, clientMessageId, content = "", attachments = [], taskStart = false, localTools }: any) {
    this.frame({ type: "client.message", run_id: runId, client_message_id: clientMessageId, conversation_id: this.conversationId, local_tools: localTools,
      ...(taskStart ? { task_start: true } : {}), reject_by_message: true, message: { role: "user", content, ...(attachments.length ? { attachments } : {}) } });
  }
  toolResult(runId: string, toolCallId: string, result: object) { this.frame({ type: "tool_call.result", run_id: runId, tool_call_id: toolCallId, ...result }); }
  cancel(runId: string) { this.frame({ type: "turn.cancel", run_id: runId }); }
  frame(message: object) { this.socket.send(JSON.stringify(message)); }
  get ready() { return this.socket.readyState === WebSocket.OPEN; }
  close() { this.socket.close(); }
}

/** The same transport the dashboard ships (`WebConversationTransport`), over Node's fetch. */
class NodeTransport extends ConversationTransport {
  constructor(private readonly base: string) { super(); }
  get retriesRun() { return true; }
  get steerable() { return true; }
  get requestsOutliveStream() { return false; }
  get adoptsForeignRuns() { return true; }
  private url(pathname: string, parameters: Record<string, string> = {}) { return `${this.base}/v1/conversations${pathname}?${new URLSearchParams({ ...binding, ...parameters })}`; }
  private async request(url: string, init: { method?: string; body?: object } = {}) {
    const response = await fetch(url, { method: init.method, headers: init.body ? { "content-type": "application/json" } : {}, body: init.body ? JSON.stringify(init.body) : undefined });
    const body = await response.json();
    if (!response.ok) throw Object.assign(new Error(JSON.stringify(body)), { status: response.status });
    return body;
  }
  list(cursor?: string) { return this.request(this.url("", cursor ? { cursor } : {})); }
  create() { return this.request(this.url(""), { method: "POST", body: { client_request_id: `c_${Math.random().toString(36).slice(2)}` } }); }
  retryRun(id: string, key: string) { return this.request(this.url(`/${id}/retry`), { method: "POST", body: { retry_id: key, client: "web" } }); }
  log(id: string, { after, limit, turns, before }: any) {
    return this.request(this.url(`/${id}/log`, { ...(after != null ? { after: String(after) } : {}), ...(limit != null ? { limit: String(limit) } : {}), ...(turns != null ? { turns: String(turns) } : {}), ...(before != null ? { before: String(before) } : {}) }));
  }
  toolDetail(id: string, ref: any) { return this.request(this.url(`/${id}/tools/${ref.run_id}/${ref.tool_call_id}`)); }
  assetUrl(id: string, assetId: string) { return this.url(`/${id}/assets/${assetId}`); }
  connect(id: string, handlers: any) { return new NodeConnection(id, this.base, handlers); }
}

class NoAttachments extends chat.AttachmentSource { accepts() { return false; } async prepareAll() { return []; } }
class NoTools extends chat.ToolExecutor { get localTools() { return []; } cancel() {} execute() { return Promise.resolve({ status: "error", error: { code: "none" } }); } requestApproval() { return Promise.resolve({ approved: false }); } }

// ---------------------------------------------------------------- parts: what a page shows, and what the log said
type Part =
  | { kind: "user"; content: string }
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string; open: boolean }
  | { kind: "tool"; id: string; status: string };

/**
 * The independent reducer: public log events of one conversation as the ordered parts a reader should see. It shares no code with the
 * client. A steered message is queued (shown last) until the Run claims it, and then stands where the claim happened.
 */
function project(events: any[], { users = false } = {}): Part[] {
  const parts: Part[] = [];
  const queued = new Map<string, Part>();
  const open = new Map<number, Extract<Part, { kind: "thinking" }>>();
  let replyFrom = 0;
  for (const event of events) {
    if (event.type === "message.queued") queued.set(event.id, { kind: "user", content: event.content });
    else if (event.type === "user.message") {
      queued.delete(event.id);
      parts.push({ kind: "user", content: event.content });
      replyFrom = parts.length;
    } else if (event.type === "assistant.text") {
      const last = parts.at(-1);
      if (last?.kind === "text") last.content += event.content;
      else parts.push({ kind: "text", content: (parts.slice(replyFrom).some((part) => part.kind === "text") ? "\n\n" : "") + event.content });
    } else if (event.type === "assistant.thinking") {
      if (event.phase === "start") { const part = { kind: "thinking" as const, content: "", open: true }; parts.push(part); open.set(event.index, part); }
      else if (event.phase === "delta") open.get(event.index)!.content += event.delta;
      else { const part = open.get(event.index)!; part.content = event.content; part.open = false; open.delete(event.index); }
    } else if (event.type === "tool.call") {
      const known = parts.find((part): part is Extract<Part, { kind: "tool" }> => part.kind === "tool" && part.id === event.tool_call_id);
      if (known) known.status = event.status; else parts.push({ kind: "tool", id: event.tool_call_id, status: event.status });
    }
  }
  const all = [...parts, ...queued.values()];
  return users ? all : all.filter((part) => part.kind !== "user");
}

/** Thread messages (live or saved: the fold makes no difference) as parts: adjacent text is one part, statuses are not parts. */
function partsOfMessages(messages: any[], { users = false } = {}): Part[] {
  const parts: Part[] = [];
  for (const message of messages) {
    if (message.role === "user") { if (users) parts.push({ kind: "user", content: message.content }); continue; }
    for (const entry of message.timeline ?? []) {
      if (entry.kind === "text") {
        const last = parts.at(-1);
        if (last?.kind === "text") last.content += entry.content; else parts.push({ kind: "text", content: entry.content });
      } else if (entry.kind === "thinking") parts.push({ kind: "thinking", content: entry.content, open: entry.streaming === true });
      else if (entry.kind === "tool") parts.push({ kind: "tool", id: entry.content.toolCallId, status: entry.status });
    }
  }
  return parts;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** The oracle: a raw socket on the conversation that never reloads, recording every public event it is sent. */
class Oracle {
  events: any[] = [];
  lastPosition = 0;
  private socket!: WebSocket;
  static async open(base: string, conversationId: string): Promise<Oracle> {
    const oracle = new Oracle();
    oracle.socket = new WebSocket(`${base.replace("http:", "ws:")}/runtime`);
    oracle.socket.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "log.event") { oracle.events.push(frame.event); oracle.lastPosition = frame.event.position; }
      else oracle.frames.push(frame);
    });
    await new Promise<void>((resolve, reject) => { oracle.socket.once("open", resolve); oracle.socket.once("error", reject); });
    oracle.socket.send(JSON.stringify({ type: "client.hello", protocol_version: PROTOCOL_VERSION, conversation_id: conversationId, ...helloScope, license_token: "recovery-license", local_tools: [], after: 0 }));
    await waitFor(() => oracle.frames.some((frame) => frame.type === "session.ready"), "oracle ready");
    return oracle;
  }
  frames: any[] = [];
  parts(opts?: { users?: boolean }): Part[] { return project(this.events, opts); }
  runIds(): string[] { return [...new Set(this.events.filter((event) => event.type === "run.state").map((event) => event.run_id))]; }
  ended(): boolean { return this.events.some((event) => event.type === "run.state" && TERMINAL.has(event.status)); }
  close() { this.socket.terminate(); }
}

class Page {
  controller: any;
  constructor(readonly transport: any, readonly conversationId: string) {
    this.controller = new chat.ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 150 });
  }
  get state() { return this.controller.getState(); }
  /** The thread as ordered parts: the whole conversation's replies, each step once. */
  parts(opts?: { users?: boolean }): Part[] { return partsOfMessages(this.state.messages, opts); }
  liveRows() { return this.state.messages.filter((message: any) => message.transient && message.role === "assistant"); }
  open() { this.controller.open(this.conversationId); }
  async ready(): Promise<void> {
    await waitFor(() => this.state.snapshotConversationId === this.conversationId && this.state.connection === "open", "page settled");
    await sleep(30);
  }
  /** The page holds every event the server has told so far (the oracle is the measure of what was told). */
  async caughtUp(oracle: Oracle): Promise<void> {
    await waitFor(() => this.controller.log.position >= oracle.lastPosition && this.state.connection === "open", () => `page caught up (page ${this.controller.log.position}, oracle ${oracle.lastPosition})`);
    await sleep(15);
  }
  async send(content: string) { this.controller.setDraft(content); await this.controller.send(); }
  dispose() { this.controller.dispose(); }
}

// ---------------------------------------------------------------- fixture
type Fixture = { runtime: RuntimeServer; base: string; model: Model; store: RuntimeStore; repository: any; conversationId: string; dir: string; backend: string };
const cleanup: Array<() => unknown> = [];
const models: Model[] = [];
let summaryGate: { started: Promise<void>; release: () => void } | undefined;
afterEach(async () => {
  for (const model of models.splice(0)) model.releaseAll();
  summaryGate?.release();
  for (const action of cleanup.splice(0).reverse()) await Promise.resolve(action()).catch(() => undefined);
});

async function listen(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
const BACKENDS = ["local", ...(databaseUrl ? ["postgres"] : [])] as const;
type Backend = (typeof BACKENDS)[number];
/** One schema per Postgres fixture; a reboot on the same fixture shares it (a restart keeps the database). */
const schemas = new Map<string, { pool: Pool; schema: string }>();

async function boot(backend: Backend, extra: Record<string, unknown> = {}, reuse?: { dir: string; conversationId: string }, script: Item[] = []): Promise<Fixture> {
  const dir = reuse?.dir ?? await mkdtemp(path.join(os.tmpdir(), "hatch-chat-log-"));
  let store: any; let repository: any;
  if (backend === "postgres") {
    let entry = schemas.get(dir);
    if (!entry) {
      const schema = `chatlog_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.end();
      entry = { schema, pool: new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 12 }) };
      schemas.set(dir, entry);
      cleanup.push(async () => { const admin = new Pool({ connectionString: databaseUrl }); await admin.query(`DROP SCHEMA IF EXISTS "${entry!.schema}" CASCADE`); await admin.end(); await entry!.pool.end().catch(() => undefined); schemas.delete(dir); });
    }
    repository = new PostgresConversationRepository(entry.pool);
    store = new PostgresStore({ pool: entry.pool });
    repository.bindSubmissionStore(store);
    await repository.initialize();
  } else {
    store = new RuntimeStore(dir);
    repository = new InMemoryConversationRepository(localRuntimeAuthority(dir));
    await repository.initialize();
  }
  const model = new Model();
  model.script = script;
  models.push(model);
  const runtime = createRuntimeServer({ insecureLocalMode: true, conversationStore: store, conversationRepository: repository, createRuntime: () => model.runtime(), ...extra });
  cleanup.push(() => runtime.close());
  const base = await listen(runtime.server);
  const conversationId = reuse?.conversationId ?? (await new NodeTransport(base).create()).conversation.id;
  return { runtime, base, model, store, repository, conversationId, dir, backend };
}

/** A page opened on the conversation, through `base` (the Runtime or a proxy in front of it). */
async function openPage(fixture: Fixture, base = fixture.base, settle = true): Promise<Page> {
  const page = new Page(new NodeTransport(base), fixture.conversationId);
  cleanup.push(() => page.dispose());
  page.open();
  if (settle) await page.ready();
  return page;
}

/** A fresh page load: the old page is gone, a new controller and transport open the conversation. */
async function reload(old: Page, fixture: Fixture, base = fixture.base, settle = true): Promise<Page> {
  old.dispose();
  return openPage(fixture, base, settle);
}

const show = (parts: Part[]) => JSON.stringify(parts, null, 1);
function samePartList(actual: Part[], expected: Part[], what: string) { assert.deepEqual(actual, expected, `${what}\nactual: ${show(actual)}\nexpected: ${show(expected)}`); }

/** The oracle and every given page hold the same log. */
async function sync(oracle: Oracle, ...pages: Page[]) {
  // Text and thinking are written in chunks every 250 ms: what a frozen model has said is in the log a moment after.
  await sleep(400);
  let last = -1;
  await waitFor(() => { const same = oracle.lastPosition === last; last = oracle.lastPosition; return same && oracle.events.length > 0; }, "the log to settle");
  for (const page of pages) await page.caughtUp(oracle);
}
const hasSavedReply = (page: Page) => page.state.messages.some((message: any) => message.role === "assistant" && !message.transient);
/** The page shows the Run as finished: nothing live, composer idle. */
const finished = (page: Page) => waitFor(() => !page.state.activeRun && !page.liveRows().length && hasSavedReply(page), "the Run to end on the page");

/** Starts a Run frozen at `freeze`, with a page and the oracle in step with it. */
async function startFrozen(backend: Backend, script: Item[], freeze: string, extra: Record<string, unknown> = {}) {
  const fixture = await boot(backend, extra, undefined, script);
  const oracle = await Oracle.open(fixture.base, fixture.conversationId);
  cleanup.push(() => oracle.close());
  const page = await openPage(fixture);
  await page.send("go");
  await fixture.model.reached(freeze);
  await sync(oracle, page);
  return { fixture, oracle, page };
}

/**
 * The generic reload scenario: freeze, the page shows what the log said, reload, the same list; release, the Run ends with the full
 * reply, and a later fresh page load shows that same reply.
 */
async function reloadMoment(backend: Backend, script: Item[], freeze: string, during?: (page: Page, oracle: Oracle, fixture: Fixture) => Promise<void> | void) {
  const { fixture, oracle, page } = await startFrozen(backend, script, freeze);
  const expected = oracle.parts();
  samePartList(page.parts(), expected, "before the reload");
  const after = await reload(page, fixture);
  samePartList(after.parts(), expected, "after the reload");
  assert.equal(after.liveRows().length, 1, "the page holds one live row");
  await during?.(after, oracle, fixture);
  fixture.model.release(freeze);
  await waitFor(() => oracle.ended(), "the Run to end");
  await finished(after);
  const final = oracle.parts();
  samePartList(after.parts(), final, "the finished reply on the reloaded page");
  const later = await openPage(fixture);
  samePartList(later.parts(), final, "a later fresh page load of the finished conversation");
  return { fixture, oracle, page: after, final };
}

// ================================================================ a. the exact production repro
const A_PARAGRAPH = ["Here is what I found. ", "The market is growing fast. ", "Three players dominate it."];
const primaryScript = (): Item[] => [
  ...thinking(0, ["Let me look ", "this up."]),
  toolEvent("t1", "requested"), toolEvent("t1", "completed"),
  ...text(...A_PARAGRAPH),
  toolEvent("t2", "requested"), toolEvent("t3", "requested"), toolEvent("t2", "completed"),
  ...text("Now the second part, ", "which begins here and "), gate("freezeB"),
  ...text("carries on to its end."),
  toolEvent("t3", "completed")
];

for (const backend of BACKENDS) {
  test(`a [${backend}]. reload mid-sentence of the second text after two step rows shows the same ordered parts, then continues live`, async () => {
    const { fixture, oracle, page } = await startFrozen(backend, primaryScript(), "freezeB");
    const before = page.parts();
    assert.deepEqual(before.map((part) => part.kind), ["thinking", "tool", "text", "tool", "tool", "text"], show(before));
    samePartList(before, oracle.parts(), "before the reload, the page equals the oracle");
    const textB = before.at(-1) as { content: string };
    assert.equal(textB.content, "\n\nNow the second part, which begins here and ", "text B starts its own paragraph and holds all it had streamed");
    assert.equal((before[2] as { content: string }).content, A_PARAGRAPH.join(""), "text A is its own part");

    const after = await reload(page, fixture);
    samePartList(after.parts(), before, "after the reload");
    assert.equal(after.liveRows().length, 1, "one live row, not a duplicate");

    fixture.model.release("freezeB");
    await waitFor(() => after.state.activeRun === null && after.liveRows().length === 0, "the Run to end on the reloaded page");
    const done = oracle.parts();
    samePartList(after.parts(), done, "the finished reply equals what the log said");
    assert.equal((done.at(-1) as { content: string }).content, "\n\nNow the second part, which begins here and carries on to its end.", "no text missing, none twice");
    assert.deepEqual(done.map((part) => part.kind === "tool" ? (part as any).status : part.kind), ["thinking", "completed", "text", "completed", "completed", "text"]);
  });
}

// ================================================================ b. one reload at each moment of a Run
const stepsThenText = (): Item[] => [...thinking(0, ["plan"]), toolEvent("t1", "requested"), toolEvent("t1", "completed")];

test("b1. reload before the first token", async () => {
  await reloadMoment("local", [gate("g"), ...stepsThenText(), ...text("An ", "answer.")], "g");
});

test("b2. reload in the middle of a text", async () => {
  await reloadMoment("local", [...stepsThenText(), ...text("An answer that ", "is half "), gate("g"), ...text("done.")], "g");
});

test("b3. reload in the middle of a thinking: further deltas extend the same thinking, never a second one", async () => {
  const { page, final } = await reloadMoment("local", [
    ...text("First words."),
    { type: "assistant.delta", delta: { kind: "thinking_start", contentIndex: 3 } },
    { type: "assistant.delta", delta: { kind: "thinking_delta", contentIndex: 3, delta: "I am " } },
    { type: "assistant.delta", delta: { kind: "thinking_delta", contentIndex: 3, delta: "thinking " } },
    gate("g"),
    { type: "assistant.delta", delta: { kind: "thinking_delta", contentIndex: 3, delta: "on." } },
    { type: "assistant.delta", delta: { kind: "thinking_end", contentIndex: 3, content: "I am thinking on." } },
    ...text("Done.")
  ], "g", (reloaded) => {
    const thought = reloaded.parts().filter((part) => part.kind === "thinking");
    assert.deepEqual(thought, [{ kind: "thinking", content: "I am thinking ", open: true }], "the thinking is open and holds what it had");
  });
  assert.deepEqual(page.parts().filter((part) => part.kind === "thinking"), [{ kind: "thinking", content: "I am thinking on.", open: false }]);
  assert.equal(final.filter((part) => part.kind === "thinking").length, 1);
});

test("b4. reload while a long-running tool is still going", async () => {
  await reloadMoment("local", [...stepsThenText(), ...text("Looking it up. "), toolEvent("slow", "requested"), toolEvent("fast", "requested"), toolEvent("fast", "completed"), gate("g"), toolEvent("slow", "completed"), ...text("Found it.")], "g",
    (page) => {
      const tools = page.parts().filter((part) => part.kind === "tool");
      assert.deepEqual(tools.map((tool: any) => [tool.id, tool.status]), [["t1", "completed"], ["slow", "requested"], ["fast", "completed"]]);
    });
});

test("b5. the Run ends while the page is not hearing (delivery held): a fresh page shows the whole reply", async () => {
  const fixture = await boot("local", {}, undefined, [...stepsThenText(), ...text("Part one. "), toolEvent("t2", "requested"), gate("g"), toolEvent("t2", "completed"), ...text("Part two.")]);
  const oracle = await Oracle.open(fixture.base, fixture.conversationId);
  cleanup.push(() => oracle.close());
  const proxy = new ChaosProxy(Number(new URL(fixture.base).port));
  cleanup.push(() => proxy.close());
  const page = await openPage(fixture, await proxy.listen());
  await page.send("go");
  await fixture.model.reached("g");
  await sync(oracle, page);
  proxy.holdDownstream = true;
  fixture.model.release("g");
  await waitFor(() => oracle.ended(), "the Run to end");
  assert.equal(page.state.activeRun !== null, true, "the page has not been told");
  const fresh = await reload(page, fixture);
  samePartList(fresh.parts(), oracle.parts(), "a page opened right after the end, before the old one heard it");
  assert.equal(fresh.state.activeRun, null);
  assert.equal(fresh.liveRows().length, 0);
});

test("b6. reload with the hello delayed 500 ms while the model keeps streaming: the late hello resumes after what the page read", async () => {
  const fixture = await boot("local", {}, undefined, [...stepsThenText(), ...text("Before. "), gate("g1"), toolEvent("t2", "requested"), ...text("While the hello is on its way. ", "More. "), toolEvent("t2", "completed"), ...text("Still more. "), gate("g2"), ...text("The end.")]);
  const oracle = await Oracle.open(fixture.base, fixture.conversationId);
  cleanup.push(() => oracle.close());
  const first = await openPage(fixture);
  await first.send("go");
  await fixture.model.reached("g1");
  await sync(oracle, first);
  first.dispose();
  const proxy = new ChaosProxy(Number(new URL(fixture.base).port));
  cleanup.push(() => proxy.close());
  proxy.helloDelayMs = 500;
  const page = await openPage(fixture, await proxy.listen(), false);
  await waitFor(() => page.state.snapshotConversationId === fixture.conversationId, "the first read");
  fixture.model.release("g1");
  await fixture.model.reached("g2");
  assert.notEqual(page.state.connection, "open", "the hello is still on its way");
  await page.ready();
  await sync(oracle, page);
  samePartList(page.parts(), oracle.parts(), "after the late hello");
  fixture.model.release("g2");
  await waitFor(() => oracle.ended(), "the Run to end");
  await finished(page);
  samePartList(page.parts(), oracle.parts(), "finished");
});

// ================================================================ c. the same list at four moments
for (const backend of BACKENDS) {
  test(`c [${backend}]. one Run, one ordered list: live, reloaded mid-Run, finished, and loaded fresh later`, async () => {
    const script: Item[] = [
      ...text("Opening words. "),
      ...thinking(0, ["considering ", "options"]),
      toolEvent("a", "requested"), toolEvent("a", "completed"),
      ...text("Between steps. "),
      ...thinking(1, ["a second thought"]),
      toolEvent("b", "requested"), toolEvent("c", "requested"), toolEvent("c", "completed"), toolEvent("b", "completed"),
      ...text("The last paragraph ", "is cut off here, "), gate("g"), ...text("and ends here.")
    ];
    const { fixture, oracle, page } = await startFrozen(backend, script, "g");
    const live = page.parts();
    const frozen = oracle.parts();
    samePartList(live, frozen, "moment 1: live");
    assert.deepEqual(live.map((part) => part.kind), ["text", "thinking", "tool", "text", "thinking", "tool", "tool", "text"]);
    const reloaded = await reload(page, fixture);
    samePartList(reloaded.parts(), frozen, "moment 2: after a reload mid-Run");
    fixture.model.release("g");
    await waitFor(() => oracle.ended(), "the Run to end");
    await finished(reloaded);
    const done = oracle.parts();
    samePartList(reloaded.parts(), done, "moment 3: the saved reply replaced the live row");
    const fresh = await openPage(fixture);
    samePartList(fresh.parts(), done, "moment 4: a later fresh page load");
    samePartList(done.slice(0, -1), frozen.slice(0, -1), "everything before the last text is unchanged");
    assert.equal((done.at(-1) as any).content, `${(frozen.at(-1) as any).content}and ends here.`);
    assert.equal(fresh.liveRows().length + reloaded.liveRows().length, 0);
  });
}

// ================================================================ d. every way a Run can end keeps what the live view showed
const stepsAndText = (): Item[] => [...thinking(0, ["weighing it up"]), toolEvent("t1", "requested"), toolEvent("t1", "completed"), ...text("Some findings so far. "), toolEvent("t2", "requested"), toolEvent("t3", "requested"), toolEvent("t2", "completed"), ...text("And a second paragraph ")];

test("d1. a Run that fails after some steps: the reopened page shows the same parts the live view had", async () => {
  const { fixture, oracle, page } = await startFrozen("local", [...stepsAndText(), gate("g"), { fail: "the provider fell over" }], "g");
  const live = page.parts();
  fixture.model.release("g");
  await waitFor(() => oracle.ended(), "the Run to end");
  await waitFor(() => !page.state.activeRun, "the page to see the end");
  samePartList(page.parts(), live, "the page that watched it fail keeps what it showed");
  samePartList((await openPage(fixture)).parts(), live, "a page opened after the failure");
  samePartList(live, oracle.parts(), "and that is what the log said");
});

test("d2. a Run the user cancels mid-run: the reopened page shows the same parts the live view had", async () => {
  const { fixture, oracle, page } = await startFrozen("local", [...stepsAndText(), gate("g"), ...text("never shown")], "g");
  const live = page.parts();
  page.controller.cancel();
  await waitFor(() => oracle.ended(), "the Run to be cancelled");
  await waitFor(() => !page.state.activeRun, "the page to see the end");
  samePartList(page.parts(), live, "the page that cancelled keeps what it showed");
  samePartList((await openPage(fixture)).parts(), live, "a page opened after the cancel");
  samePartList(live, oracle.parts(), "and that is what the log said");
});

/** The process dies: its lease lapses and it never ends the Run. A new process boots on the same data. */
async function crash(fixture: Fixture, oracle: Oracle, script: Item[], extra: Record<string, unknown> = {}): Promise<Fixture> {
  const runId = oracle.runIds().at(-1)!;
  const run = await fixture.repository.findRun(runId);
  await fixture.repository.renewLease(runId, run!.executorId!, -1_000);
  await fixture.runtime.close();
  return boot(fixture.backend as Backend, extra, { dir: fixture.dir, conversationId: fixture.conversationId }, script);
}

for (const backend of BACKENDS) {
  test(`d3 [${backend}]. a restart interrupts the Run, answers it again, and tells the buyer nothing: no error, the retry's reply, the interrupted partial gone`, async () => {
    const { fixture, oracle, page } = await startFrozen(backend, [...stepsAndText(), gate("g")], "g");
    const live = page.parts();
    assert.equal(live.length, 6);
    const restarted = await crash(fixture, oracle, [...thinking(0, ["again"]), ...text("A fresh answer.")]);
    const again = await Oracle.open(restarted.base, restarted.conversationId);
    cleanup.push(() => again.close());
    // The page that was open when the process died resumes from its last position on a new session, and never shows an error.
    await waitFor(() => page.state.connection === "open" || page.state.connection === "connecting", "the page to reconnect", 15_000);
    const reopened = await openPage(restarted);
    await waitFor(() => again.events.some((event) => event.type === "run.state" && event.status === "completed"), "the retry to complete", 15_000);
    await waitFor(() => reopened.state.activeRun === null && reopened.parts().some((part) => part.kind === "text"), "the reopened page to show the retry");
    assert.equal(reopened.state.error, null, "no notice");
    assert.equal(reopened.state.failedRun, null);
    assert.deepEqual(reopened.parts().map((part) => part.kind), ["thinking", "text"], JSON.stringify(again.events.map((event) => [event.position, event.type, event.run_id?.slice(-4), event.status ?? event.phase ?? (event.content ?? "").slice(0, 12)])) + " only the retry's reply: the interrupted partial is superseded");
    assert.equal(again.runIds().length, 2, "the interrupted Run and its retry");
    page.dispose();
  });
}

test("d4. an interrupted Run nobody answers again keeps every step it showed, on a page opened later", async () => {
  // Three cuts in a row: a reply is started again at most twice, after that its partial reply stays.
  const script = () => [...stepsAndText(), gate("g")];
  let { fixture, oracle, page } = await startFrozen("local", script(), "g");
  const live = page.parts();
  page.dispose();
  for (let cut = 0; cut < 3; cut++) {
    const last = cut === 2;
    fixture = await crash(fixture, oracle, last ? [] : script());
    if (!last) { await fixture.model.reached("g"); }
    oracle = await Oracle.open(fixture.base, fixture.conversationId);
    cleanup.push(() => oracle.close());
    if (!last) await waitFor(() => oracle.events.some((event) => event.type === "run.state" && event.status === "running" && event.run_id !== oracle.events.find((e) => e.type === "run.state")!.run_id), "the retry to run");
  }
  const reopened = await openPage(fixture);
  await waitFor(() => reopened.state.activeRun === null, "the page to settle");
  samePartList(reopened.parts(), live, "the last interrupted reply, with its thinking, steps and text");
  assert.equal(reopened.state.error, null);
});

// ================================================================ e. two pages on one conversation
test("e. a second page sends; the first, idle or reloaded mid-Run, ends with the identical ordered parts", async (t) => {
  const fixture = await boot("local", {}, undefined, [...stepsAndText(), gate("g"), ...text("and it ends here."), toolEvent("t3", "completed")]);
  const oracle = await Oracle.open(fixture.base, fixture.conversationId);
  cleanup.push(() => oracle.close());
  const idle = await openPage(fixture);
  const sender = await openPage(fixture);
  await sender.send("go");
  await fixture.model.reached("g");
  await sync(oracle, sender, idle);
  const frozen = oracle.parts();
  samePartList(sender.parts(), frozen, "the page that sent");
  samePartList(idle.parts(), frozen, "the idle page, from the tail alone");
  const reloaded = await reload(idle, fixture);
  samePartList(reloaded.parts(), frozen, "the idle page after a reload mid-Run");
  fixture.model.release("g");
  await waitFor(() => oracle.ended(), "the Run to end");
  await Promise.all([finished(sender), finished(reloaded)]);
  const done = oracle.parts();
  samePartList(sender.parts(), done, "sender finished");
  samePartList(reloaded.parts(), done, "reloaded page finished");
  t.diagnostic("done");
});

// ================================================================ s. the steered message stands where it happened (prod bug, iPhone)
for (const backend of BACKENDS) {
  test(`s [${backend}]. text A and steps, the user steers with M, the Run claims it, text B: [A, steps, M, B] live, reloaded, finished, reopened and on a second client`, async () => {
    const script: Item[] = [
      ...text("Here is the first part of the answer. "),
      toolEvent("s1", "requested"), toolEvent("s1", "completed"),
      ...text("Second sentence before the steer. "), gate("steered"),
      { claim: true },
      ...text("After reading your note, the rest."), gate("end")
    ];
    const { fixture, oracle, page } = await startFrozen(backend, script, "steered");
    const second = await openPage(fixture);
    await sync(oracle, page, second);
    await page.send("also check the price");
    await waitFor(() => oracle.events.some((event) => event.type === "message.queued"), "the steer to be accepted");
    await sync(oracle, page, second);
    const queued = page.parts({ users: true });
    assert.equal((queued.at(-1) as any).content, "also check the price", "until the Run takes it up, it is last and queued");
    assert.equal(page.state.messages.at(-1).state, "queued");
    fixture.model.release("steered");
    await fixture.model.reached("end");
    await sync(oracle, page, second);
    const expected = oracle.parts({ users: true });
    assert.deepEqual(expected.map((part) => part.kind), ["user", "text", "tool", "text", "user", "text"], show(expected));
    assert.equal((expected[4] as any).content, "also check the price");
    assert.match((expected[5] as any).content, /^After reading your note/);
    const opts = { users: true };
    samePartList(page.parts(opts), expected, "moment 1: live");
    samePartList(second.parts(opts), expected, "a second client, live");
    const reloaded = await reload(page, fixture);
    samePartList(reloaded.parts(opts), expected, "moment 2: after a reload");
    fixture.model.release("end");
    await waitFor(() => oracle.ended(), "the Run to end");
    await Promise.all([finished(reloaded), finished(second)]);
    const done = oracle.parts(opts);
    samePartList(reloaded.parts(opts), done, "moment 3: after the Run ended");
    samePartList(second.parts(opts), done, "the second client after the end");
    const fresh = await openPage(fixture);
    samePartList(fresh.parts(opts), done, "moment 4: reopened later");
    assert.deepEqual(done.map((part) => part.kind), ["user", "text", "tool", "text", "user", "text"], "the message is never at the top");
    assert.equal(fresh.state.messages[0].role, "user");
    assert.equal(fresh.state.messages[0].content, "go");
  });
}

// ================================================================ f. compaction
const within = <T>(promise: Promise<T>, what: string, ms = 5_000) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${what}`)), ms).unref())]);
const gatedSummaries = (): { strategy: () => CompactionStrategy<any>; gate: NonNullable<typeof summaryGate> } => {
  let started!: () => void; let release!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  summaryGate = { started: startedPromise, release };
  return { gate: summaryGate, strategy: () => new CompactionStrategy(chatCompactionAdapter(async () => { started(); await released; return "## Goal\nan earlier question"; }), policyFor(4_096)) };
};
const ungatedSummaries = () => ({ compactionStrategy: () => new CompactionStrategy(chatCompactionAdapter(async () => "## Goal\nan earlier question"), policyFor(4_096)) });
/** What a page that reads the log fresh would show of the conversation right now. */
async function readFresh(fixture: Fixture) {
  const transport = new NodeTransport(fixture.base);
  const page = await transport.log(fixture.conversationId, { turns: 20 });
  return chat.projectLog(chat.foldLogEvents(chat.emptyLog(), page.events, page.head));
}

test("f1. compaction between the tool steps of a long Run changes nothing the page shows, and the Run finishes", async () => {
  const steps = (from: number, count: number): Item[] => Array.from({ length: count }, (_, i) => [toolEvent(`s${from + i}`, "requested"), toolEvent(`s${from + i}`, "completed"), ...text(`Step ${from + i} done. `)]).flat();
  const script: Item[] = [...thinking(0, ["a long job"]), ...steps(1, 4), { compact: true }, ...steps(5, 4), gate("g"), ...text("Wrapping up.")];
  const { fixture, oracle, page } = await startFrozen("local", script, "g", ungatedSummaries());
  assert.ok(oracle.events.some((event) => event.type === "compaction.ended"), "the Run did compact");
  const frozen = oracle.parts();
  samePartList(page.parts(), frozen, "the live page across the compaction");
  const reloaded = await reload(page, fixture);
  samePartList(reloaded.parts(), frozen, "after a reload after the compaction");
  fixture.model.release("g");
  await waitFor(() => oracle.ended(), "the Run to end");
  await finished(reloaded);
  samePartList(reloaded.parts(), oracle.parts(), "finished");
  samePartList((await openPage(fixture)).parts(), oracle.parts(), "fresh page");
});

test("f2. a reload while the Run is compacting shows the Run active and the composer not idle, then idle after", async () => {
  const summaries = gatedSummaries();
  const fixture = await boot("local", { compactionStrategy: summaries.strategy }, undefined, [...stepsAndText(), { compact: true }, ...text("after the summary.")]);
  const oracle = await Oracle.open(fixture.base, fixture.conversationId);
  cleanup.push(() => oracle.close());
  const page = await openPage(fixture);
  await page.send("go");
  await within(summaries.gate.started, "the summary to start");
  await sync(oracle, page);
  const fresh = await readFresh(fixture);
  assert.equal(fresh.runState, "compacting");
  assert.equal(fresh.compacting, true);
  const frozen = oracle.parts();
  const reloaded = await reload(page, fixture);
  assert.ok(reloaded.state.activeRun, "the Run is active on the reloaded page");
  assert.notEqual(reloaded.state.status.key, "connected", "the composer is not idle");
  assert.equal(reloaded.state.compacting, true);
  samePartList(reloaded.parts(), frozen, "what the Run showed before it started compacting");
  summaries.gate.release();
  await waitFor(() => oracle.ended(), "the Run to end");
  await finished(reloaded);
  assert.equal(reloaded.state.compacting, false);
  assert.equal(reloaded.state.status.key, "connected");
  samePartList(reloaded.parts(), oracle.parts(), "finished");
});

test("f3. a reload during the compaction after a reply keeps the composer waiting until it ends", async () => {
  const summaries = gatedSummaries();
  const fixture = await boot("local", { compactionStrategy: summaries.strategy }, undefined, [...text("A short reply.")]);
  const page = await openPage(fixture);
  await page.send(`a very long message ${"padding ".repeat(2_000)}`);
  await within(summaries.gate.started, "the summary to start");
  await finished(page);
  assert.equal((await readFresh(fixture)).compacting, true, "the log says the history is being summarized");
  const reloaded = await reload(page, fixture);
  assert.equal(reloaded.state.compacting, true, "the reloaded page knows");
  summaries.gate.release();
  await waitFor(() => reloaded.state.compacting === false, "the composer to unlock");
});

test("f4. a restart during a compaction converges: nothing stays compacting, the Run is answered again", async () => {
  const summaries = gatedSummaries();
  const fixture = await boot("local", { compactionStrategy: summaries.strategy }, undefined, [...stepsAndText(), { compact: true }, ...text("never reached")]);
  const oracle = await Oracle.open(fixture.base, fixture.conversationId);
  cleanup.push(() => oracle.close());
  const page = await openPage(fixture);
  await page.send("go");
  await within(summaries.gate.started, "the summary to start");
  await sync(oracle, page);
  assert.equal((await readFresh(fixture)).compacting, true);
  page.dispose();
  summaries.gate.release();
  const restarted = await crash(fixture, oracle, [...text("Answered again.")], ungatedSummaries());
  const again = await Oracle.open(restarted.base, restarted.conversationId);
  cleanup.push(() => again.close());
  await waitFor(() => again.events.some((event) => event.type === "run.state" && event.status === "completed"), "the retry to complete", 15_000);
  const reopened = await openPage(restarted);
  const view = await readFresh(restarted);
  assert.equal(view.compacting, false, "no compaction is left open");
  assert.equal(view.activeRun, null);
  assert.equal(reopened.state.compacting, false);
  assert.equal(reopened.state.status.key, "connected");
  assert.equal(reopened.state.error, null);
});
