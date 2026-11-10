import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, MemoryPendingStore, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

/** A connection of a transport whose server owns Run ids: a send is a request that answers with its outcome. */
class RequestConnection extends RuntimeConnection {
  constructor(transport, handlers) { super(); this.transport = transport; this.handlers = handlers; this.open = true; queueMicrotask(() => handlers.onOpen()); }
  hello() { this.handlers.onEvent({ type: "session.ready", conversation_id: "assistant" }); }
  async send(message) {
    this.transport.sent.push(message);
    const receipt = this.transport.receipts.shift() ?? { run_id: "run_server", outcome: "started" };
    this.handlers.onEvent({ type: "message.accepted", client_message_id: message.clientMessageId, ...receipt });
  }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

/** In-memory double of the Studio transport: automated tests only. */
class FakeSteerableTransport extends ConversationTransport {
  constructor() { super(); this.pages = []; this.sent = []; this.receipts = []; this.connections = []; this.snapshots = 0; this.page = page(); this.runs = {}; }
  get steerable() { return true; }
  get journal() { return false; }
  snapshot() { this.snapshots += 1; return Promise.resolve(this.pages.shift() ?? this.page); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve(this.runs[runId] ?? { id: runId, status: "completed" }); }
  connect(_id, handlers) { const connection = new RequestConnection(this, handlers); this.connections.push(connection); return connection; }
}

const page = (messages = [], runs = [], cursor = 1) => ({ conversation: { id: "assistant" }, messages, runs, events: [], cursor, has_more: false });

class NoAttachments extends AttachmentSource {
  accepts() { return false; }
  prepareAll() { return Promise.resolve([]); }
}
class NoTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false }); }
}

async function open({ transport = new FakeSteerableTransport(), pendingStore = new MemoryPendingStore() } = {}) {
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pendingStore, pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("assistant");
  await flush();
  return { transport, controller, pendingStore, connection: transport.connections[0] };
}

const say = async (controller, text) => { controller.setDraft(text); await controller.send(); await flush(); };

test("two identical texts sent back to back are two messages under two keys, the second steering the Run", async () => {
  const { transport, controller } = await open();
  transport.receipts.push({ run_id: "run_1", outcome: "started" }, { run_id: "run_1", outcome: "steered" });
  await say(controller, "again");
  await say(controller, "again");
  assert.equal(transport.sent.length, 2);
  assert.notEqual(transport.sent[0].clientMessageId, transport.sent[1].clientMessageId);
  const users = controller.getState().messages.filter(message => message.role === "user");
  assert.deepEqual(users.map(message => message.id), transport.sent.map(message => message.clientMessageId), "the page is keyed by the minted ids");
  assert.deepEqual(users.map(message => message.state), [undefined, "queued"], "joining a running Run is queued until the Run takes it up");
  assert.equal(controller.getState().activeRun, "run_1", "the provisional Run id is replaced by the server's");
  controller.dispose();
});

test("the composer stays open for a Run in flight and a Product transport keeps it closed", async () => {
  const { transport, controller } = await open();
  await say(controller, "first");
  assert.ok(controller.getState().activeRun);
  assert.equal(controller.steerable, true);
  await say(controller, "second");
  assert.equal(transport.sent.length, 2);
  controller.dispose();
});

test("a reload sends a message the server never acknowledged again, under the same key", async () => {
  const pendingStore = new MemoryPendingStore();
  pendingStore.save({ conversationId: "assistant", clientMessageId: "message_kept", content: "before the refresh", attachments: [{ asset_id: "a1", type: "file" }] });
  const { transport, controller } = await open({ pendingStore });
  assert.deepEqual(transport.sent.map(message => [message.clientMessageId, message.content, message.attachments]), [["message_kept", "before the refresh", [{ asset_id: "a1", type: "file" }]]]);
  assert.equal(controller.getState().messages[0].id, "message_kept");
  assert.equal(pendingStore.load("assistant").length, 0, "acknowledged, so no longer pending");
  controller.dispose();
});

test("a message the server already holds is not sent again after a reload", async () => {
  const pendingStore = new MemoryPendingStore();
  pendingStore.save({ conversationId: "assistant", clientMessageId: "message_held", content: "hi", attachments: [] });
  const transport = new FakeSteerableTransport();
  transport.page = page([{ id: "message_held", role: "user", content: "hi", state: "queued" }]);
  const { controller } = await open({ transport, pendingStore });
  assert.equal(transport.sent.length, 0);
  assert.equal(pendingStore.load("assistant").length, 0);
  controller.dispose();
});

test("a failed send that may have reached the server is sent again under the same key", async () => {
  const { transport, controller, connection } = await open();
  const original = connection.send.bind(connection);
  connection.send = async message => { transport.sent.push(message); throw Object.assign(new Error("offline"), { code: "network" }); };
  await say(controller, "keep my key");
  const first = transport.sent[0].clientMessageId;
  assert.equal(controller.getState().draft, "keep my key");
  connection.send = original;
  await controller.send();
  await flush();
  assert.equal(transport.sent.at(-1).clientMessageId, first);
  controller.dispose();
});

test("a refused send (a 4xx) is a different message when edited and sent again", async () => {
  const { transport, controller, connection } = await open();
  const original = connection.send.bind(connection);
  connection.send = async message => { transport.sent.push(message); throw Object.assign(new Error("bad"), { status: 400 }); };
  await say(controller, "too long");
  connection.send = original;
  await say(controller, "shorter");
  assert.notEqual(transport.sent[0].clientMessageId, transport.sent[1].clientMessageId);
  controller.dispose();
});

test("a slow snapshot never overwrites a newer one: reads are queued, so the newer one lands last", async () => {
  const { transport, controller } = await open();
  const slow = Promise.withResolvers();
  const answers = [slow.promise, Promise.resolve(page([{ id: "m", role: "assistant", content: "newer" }], [], 3))];
  transport.snapshot = () => answers.shift();
  const first = controller.refresh("assistant");
  const second = controller.refresh("assistant");
  await flush();
  slow.resolve(page([{ id: "m", role: "assistant", content: "older" }], [], 2));
  await Promise.all([first, second]);
  assert.deepEqual(controller.getState().messages.map(message => message.content), ["newer"]);
  controller.dispose();
});

test("reconnecting reads the conversation again", async () => {
  const { transport, controller, connection } = await open();
  const before = transport.snapshots;
  connection.handlers.onClose();
  controller.reconnect();
  await flush();
  assert.equal(transport.snapshots, before + 1);
  controller.dispose();
});

test("a Run that ended while the stream was down frees the composer after the reconnect", async () => {
  const transport = new FakeSteerableTransport();
  transport.page = page([], [{ id: "run_live", status: "running" }]);
  const { controller } = await open({ transport });
  assert.equal(controller.getState().activeRun, "run_live");
  transport.page = page([{ id: "run_live:1", run_id: "run_live", role: "assistant", content: "done" }], []);
  controller.reconnect();
  await flush();
  const state = controller.getState();
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.messages.map(message => message.transient), [undefined], "no live row is left behind");
  controller.dispose();
});

test("text the page already holds is not drawn twice: a replay is cut by offset and a snapshot's partial output joins it", async () => {
  const transport = new FakeSteerableTransport();
  transport.page = page([], [{ id: "run_live", status: "running", partial_output: "Hello wor" }]);
  const { controller, connection } = await open({ transport });
  const text = () => controller.getState().messages.at(-1).timeline.map(entry => entry.content).join("");
  assert.equal(text(), "Hello wor");
  const delta = (content, offset) => connection.emit({ type: "assistant.delta", run_id: "run_live", delta: { kind: "text", content, offset } });
  delta("Hello world", 0);
  assert.equal(text(), "Hello world");
  delta("ld", 9);
  assert.equal(text(), "Hello world");
  delta("!", 11);
  assert.equal(text(), "Hello world!");
  controller.dispose();
});

test("a lost terminal and the journal types: a refresh drain is not asked of a transport without a journal", async () => {
  const { transport, controller } = await open();
  transport.events = () => assert.fail("no journal page exists for this transport");
  await controller.refresh("assistant");
  await controller.refresh("assistant");
  controller.dispose();
});
