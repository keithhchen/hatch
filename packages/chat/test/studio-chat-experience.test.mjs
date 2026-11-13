import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, MemoryPendingStore, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

class Stream extends RuntimeConnection {
  constructor(transport, handlers) { super(); Object.assign(this, { transport, handlers, open: true }); queueMicrotask(() => handlers.onOpen()); }
  hello() { this.handlers.onEvent({ type: "session.ready", conversation_id: "assistant" }); }
  send(message) { this.transport.sent.push(message); this.handlers.onEvent({ type: "message.accepted", client_message_id: message.clientMessageId, run_id: "run_1", outcome: "started" }); return Promise.resolve(); }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
  drop() { this.open = false; this.handlers.onClose(); }
}

/** In-memory double of the Studio transport: automated tests only. A snapshot read waits for the test unless `auto`. */
class FakeTransport extends ConversationTransport {
  constructor() { super(); this.reads = []; this.readCount = 0; this.sent = []; this.connections = []; this.next = page([]); this.auto = false; }
  get steerable() { return true; }
  get journal() { return false; }
  snapshot() { this.readCount += 1; return this.auto ? Promise.resolve(this.next) : new Promise(resolve => this.reads.push(resolve)); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "completed" }); }
  connect(_id, handlers) { const connection = new Stream(this, handlers); this.connections.push(connection); return connection; }
}
const page = (messages, runs = [], extra = {}) => ({ conversation: { id: "assistant" }, messages, runs, events: [], cursor: 1, has_more: false, ...extra });
class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor { execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); } cancel() {} requestApproval() { return Promise.resolve({ approved: false }); } }

const make = (options = {}) => {
  const transport = new FakeTransport();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pendingStore: new MemoryPendingStore(), pollMs: 60_000, ...options });
  return { transport, controller };
};

test("a message sent while the first snapshot is loading shows at once and is sent when the session is up", async () => {
  const { transport, controller } = make();
  controller.open("assistant");
  await flush();
  assert.equal(controller.snapshotPending, true);
  controller.setDraft("hello");
  await controller.send();
  const { messages, activeRun } = controller.getState();
  assert.deepEqual(messages.filter(message => message.role === "user").map(message => message.content), ["hello"]);
  assert.ok(activeRun, "the reply's indicator starts without waiting");
  assert.equal(controller.getState().draft, "");
  assert.equal(transport.sent.length, 0);
  transport.reads.shift()(page([]));
  await flush();
  assert.deepEqual(transport.sent.map(message => message.content), ["hello"]);
  assert.equal(controller.getState().messages.filter(message => message.role === "user").length, 1);
  controller.dispose();
});

test("the events of one message cause one read at a time, and one more when something changed meanwhile", async () => {
  const { transport, controller } = make();
  controller.open("assistant");
  await flush();
  transport.reads.shift()(page([]));
  await flush();
  const connection = transport.connections[0];
  const before = transport.readCount;
  for (let index = 0; index < 5; index += 1) connection.emit({ type: "conversation.changed", committed: "claimed" });
  await flush();
  assert.equal(transport.readCount - before, 1, "one read in flight");
  transport.reads.shift()(page([]));
  await flush();
  assert.equal(transport.readCount - before, 2, "one trailing read");
  transport.reads.shift()(page([]));
  await flush();
  assert.equal(transport.readCount - before, 2);
  controller.dispose();
});

test("the message this page sent is not read back when the server announces it, one another tab sent is", async () => {
  const { transport, controller } = make();
  transport.auto = true;
  controller.open("assistant");
  await flush();
  controller.setDraft("mine");
  await controller.send();
  await flush();
  const mine = controller.getState().messages.find(message => message.role === "user").id;
  const before = transport.readCount;
  transport.connections[0].emit({ type: "conversation.changed", committed: "user", message_id: mine });
  await flush();
  assert.equal(transport.readCount, before);
  transport.connections[0].emit({ type: "conversation.changed", committed: "user", message_id: "someone-else" });
  await flush();
  assert.equal(transport.readCount, before + 1);
  controller.dispose();
});

test("a lost session is retried without end and without saying so, and the next send says it only after a sustained outage", async () => {
  const { transport, controller } = make({ reconnectAttempts: Number.POSITIVE_INFINITY });
  transport.auto = true;
  controller.open("assistant");
  await flush();
  const statuses = [];
  controller.subscribe(() => statuses.push(controller.getState().status.key));
  for (let index = 0; index < 8; index += 1) {
    transport.connections.at(-1).drop();
    assert.notEqual(controller.getState().connection, "idle");
    controller.reconnect();
    await flush();
  }
  assert.ok(!statuses.includes("reconnecting") && !statuses.includes("disconnected"), statuses.join());
  transport.connections.at(-1).drop();
  controller.downSince = Date.now() - 60_000;
  controller.setDraft("anyone there");
  await controller.send();
  assert.equal(controller.getState().messages.some(message => message.content === "anyone there"), true);
  await flush();
  assert.deepEqual(transport.sent.map(message => message.content).includes("anyone there"), true);
  controller.dispose();
});

test("a compaction in progress when the page loads holds the composer until its end event", async () => {
  const { transport, controller } = make();
  transport.next = page([], [], { compacting: true });
  transport.auto = true;
  controller.open("assistant");
  await flush();
  assert.equal(controller.getState().compacting, true);
  transport.connections[0].emit({ type: "conversation.compaction", active: false });
  assert.equal(controller.getState().compacting, false);
  transport.connections[0].emit({ type: "conversation.compaction", active: true });
  assert.equal(controller.getState().compacting, true);
  controller.dispose();
});

test("a read that started before the compaction ended does not bring the lock back", async () => {
  const { transport, controller } = make();
  controller.open("assistant");
  await flush();
  transport.reads.shift()(page([], [], { compacting: true }));
  await flush();
  assert.equal(controller.getState().compacting, true);
  controller.refresh("assistant");
  await flush();
  transport.connections[0].emit({ type: "conversation.compaction", active: false });
  transport.reads.shift()(page([], [], { compacting: true }));
  await flush();
  assert.equal(controller.getState().compacting, false);
  controller.dispose();
});
