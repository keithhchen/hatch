import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, SessionPendingStore, ToolExecutor } from "../src/ports/index.js";
import { RuntimeEventReducer } from "../src/domain/runtime-events.js";
import { ChatTimeline } from "../src/domain/timeline.js";

// Product Chat's socket: a send is answered by an event, other clients' Runs arrive on the session, a session can go silent.
// In-memory doubles: automated tests only.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const flush = () => new Promise(resolve => setImmediate(resolve));

class Connection extends RuntimeConnection {
  constructor(transport, handlers) { super(); this.transport = transport; this.handlers = handlers; this.open = true; queueMicrotask(() => handlers.onOpen()); }
  hello() { this.handlers.onEvent({ type: "session.ready", conversation_id: "conv" }); }
  send(frame) { this.transport.sent.push(frame); }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

class Transport extends ConversationTransport {
  constructor() { super(); this.sent = []; this.connections = []; this.snapshots = 0; this.runs = []; }
  get steerable() { return true; }
  get requestsOutliveStream() { return false; }
  get adoptsForeignRuns() { return true; }
  get journal() { return false; }
  snapshot() {
    this.snapshots += 1;
    return Promise.resolve({ conversation: { id: "conv" }, messages: [], runs: this.runs, events: [], cursor: 1, has_more: false });
  }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "running" }); }
  connect(_id, handlers) { const connection = new Connection(this, handlers); this.connections.push(connection); return connection; }
}

class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false }); }
}

async function open(options = {}) {
  const transport = new Transport();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 60_000, reconnectAttempts: Number.POSITIVE_INFINITY, ...options });
  controller.open("conv");
  await flush();
  return { transport, controller, connection: transport.connections[0] };
}

const say = async (controller, text) => { controller.setDraft(text); await controller.send(); await flush(); };
const rows = controller => controller.getState().messages.map(message => `${message.role}:${message.content}${message.state ? `(${message.state})` : ""}`);

test("a send the session never answers goes back to the composer with a plain error, under the same key", async () => {
  const { transport, controller } = await open({ ackTimeoutMs: 30 });
  await say(controller, "hello");
  const [first] = transport.sent;
  await sleep(80);
  const state = controller.getState();
  assert.equal(state.draft, "hello");
  assert.equal(state.error?.key, "sendNotConfirmed");
  assert.deepEqual(rows(controller).filter(row => row.startsWith("user:")), []);
  // The session was judged dead: a new one is open, and the message is not sent behind the user's back.
  assert.equal(transport.connections.length, 2);
  await flush();
  assert.equal(transport.sent.length, 1);
  await controller.send();
  assert.equal(transport.sent[1].clientMessageId, first.clientMessageId);
});

test("an acknowledged send is never restored", async () => {
  const { transport, controller, connection } = await open({ ackTimeoutMs: 30 });
  await say(controller, "hello");
  const [first] = transport.sent;
  connection.emit({ type: "message.accepted", run_id: first.runId, client_message_id: first.clientMessageId, outcome: "started" });
  await sleep(80);
  assert.equal(controller.getState().draft, "");
  assert.equal(controller.getState().error, null);
});

test("a message sent while the session is gone is sent once, when a session is up", async () => {
  const { transport, controller, connection } = await open({ ackTimeoutMs: 0 });
  connection.handlers.onClose();
  await say(controller, "while away");
  controller.nudge();
  await flush();
  assert.equal(transport.sent.filter(frame => frame.content === "while away").length, 1);
  assert.equal(controller.getState().error, null);
});

test("online or a visible tab retries a session that is down at once, not after its backoff", async () => {
  const { transport, controller, connection } = await open();
  connection.handlers.onClose();
  assert.equal(controller.getState().connection, "connecting");
  assert.equal(transport.connections.length, 1);
  controller.nudge();
  assert.equal(transport.connections.length, 2);
});

test("a session that says nothing for stallMs is replaced, and the page reads what it missed", async () => {
  const { transport, controller, connection } = await open({ stallMs: 80 });
  const reads = transport.snapshots;
  await sleep(40);
  connection.emit({ type: "session.heartbeat" });
  await sleep(60);
  assert.equal(transport.connections.length, 1, "a frame within stallMs is a sign of life");
  await sleep(150);
  assert.equal(transport.connections.length >= 2, true);
  assert.ok(transport.snapshots > reads);
  controller.dispose();
});

test("a Run another client started is adopted on the first event heard of it, once", async () => {
  const { transport, controller, connection } = await open();
  transport.runs = [{ id: "run_b", status: "running", created_at: "2026-11-19T00:00:00Z" }];
  const reads = transport.snapshots;
  connection.emit({ type: "message.accepted", conversation_id: "conv", run_id: "run_b", client_message_id: "m_b", outcome: "started" });
  connection.emit({ type: "turn.state", run_id: "run_b", status: "queued" });
  connection.emit({ type: "assistant.delta", run_id: "run_b", delta: { kind: "text", content: "hi", offset: 0 } });
  await flush();
  await flush();
  assert.equal(transport.snapshots, reads + 1);
  assert.equal(controller.getState().activeRun, "run_b");
  connection.emit({ type: "assistant.delta", run_id: "run_b", delta: { kind: "text", content: " there", offset: 2 } });
  await flush();
  assert.equal(transport.snapshots, reads + 1, "no further reads for a Run the page holds");
});

test("a transport that does not see other clients' Runs is not asked to read for them", async () => {
  const { transport, controller, connection } = await open();
  Object.defineProperty(transport, "adoptsForeignRuns", { value: false });
  const reads = transport.snapshots;
  connection.emit({ type: "turn.state", run_id: "run_x", status: "running" });
  await flush();
  assert.equal(transport.snapshots, reads);
  assert.equal(controller.getState().activeRun, null);
});

test("a reply saved while the Run goes on is read: assistant.message is a change", () => {
  const outcome = new RuntimeEventReducer().reduce(new ChatTimeline(), { type: "assistant.message", run_id: "r", message_id: "m" }, null);
  assert.deepEqual([outcome.kind, outcome.committed], ["changed", "assistant"]);
});

test("a message not yet acknowledged survives a reload and is sent once under its key", async () => {
  const raw = {};
  const storage = () => ({ getItem: key => raw[key] ?? null, setItem: (key, value) => { raw[key] = value; } });
  const first = await open({ pendingStore: new SessionPendingStore(storage, "k"), ackTimeoutMs: 0 });
  first.connection.handlers.onClose();
  await say(first.controller, "before the reload");
  first.controller.dispose();
  const second = await open({ pendingStore: new SessionPendingStore(storage, "k"), ackTimeoutMs: 0 });
  await flush();
  assert.deepEqual(second.transport.sent.map(frame => frame.content), ["before the reload"]);
  const [frame] = second.transport.sent;
  second.connection.emit({ type: "message.accepted", run_id: frame.runId, client_message_id: frame.clientMessageId, outcome: "started" });
  assert.deepEqual(JSON.parse(raw.k), []);
});
