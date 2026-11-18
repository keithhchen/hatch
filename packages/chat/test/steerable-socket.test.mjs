import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

// A transport that steers over its socket (Product Chat on the web): a send is a frame, and the answer is an event,
// `message.accepted` or `message.rejected`. In-memory double: automated tests only.

const flush = () => new Promise(resolve => setImmediate(resolve));

class SocketConnection extends RuntimeConnection {
  constructor(transport, handlers) { super(); this.transport = transport; this.handlers = handlers; this.open = true; queueMicrotask(() => handlers.onOpen()); }
  hello() { this.handlers.onEvent({ type: "session.ready", conversation_id: "conv" }); }
  send(frame) { this.transport.sent.push(frame); }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

class SocketTransport extends ConversationTransport {
  constructor() { super(); this.sent = []; this.connections = []; }
  get steerable() { return true; }
  get requestsOutliveStream() { return false; }
  get journal() { return false; }
  snapshot() { return Promise.resolve({ conversation: { id: "conv" }, messages: [], runs: [], events: [], cursor: 1, has_more: false }); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "running" }); }
  connect(_id, handlers) { const connection = new SocketConnection(this, handlers); this.connections.push(connection); return connection; }
}

class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false }); }
}

async function open() {
  const transport = new SocketTransport();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  return { transport, controller, connection: transport.connections[0] };
}

const say = async (controller, text) => { controller.setDraft(text); await controller.send(); await flush(); };
const texts = controller => controller.getState().messages.map(message => `${message.role}:${message.content}${message.state ? `(${message.state})` : ""}`);

test("a message sent during a Run is a steer: it shows queued, the Run is the same, and the composer stays open", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "start");
  const [first] = transport.sent;
  connection.emit({ type: "message.accepted", run_id: first.runId, client_message_id: first.clientMessageId, outcome: "started" });
  assert.equal(controller.steerable, true);

  await say(controller, "also this");
  const steer = transport.sent[1];
  assert.equal(steer.runId, first.runId);
  connection.emit({ type: "message.accepted", run_id: first.runId, client_message_id: steer.clientMessageId, outcome: "steered" });
  await flush();
  assert.ok(texts(controller).includes("user:also this(queued)"), texts(controller).join("|"));
  assert.equal(controller.getState().activeRun, first.runId);
});

test("a refused steer goes back to the composer alone: the other message stays and the Run keeps running", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "start");
  const first = transport.sent[0];
  connection.emit({ type: "message.accepted", run_id: first.runId, client_message_id: first.clientMessageId, outcome: "started" });
  await say(controller, "too long");
  const steer = transport.sent[1];

  connection.emit({ type: "message.rejected", run_id: first.runId, client_message_id: steer.clientMessageId, error: { code: "limit", message: "slow down" } });
  await flush();
  const state = controller.getState();
  assert.equal(state.draft, "too long");
  assert.ok(!texts(controller).some(text => text.includes("too long")));
  assert.ok(texts(controller).some(text => text.startsWith("user:start")));
  assert.equal(state.activeRun, first.runId);
  assert.equal(state.failedRun, null);
  assert.equal(state.error.message, "slow down");
});

test("a refused first message goes back to the composer and no Run is left", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "hello");
  const first = transport.sent[0];
  connection.emit({ type: "message.rejected", run_id: first.runId, client_message_id: first.clientMessageId, error: { code: "free_limit", message: "limit" } });
  await flush();
  const state = controller.getState();
  assert.equal(state.draft, "hello");
  assert.equal(state.activeRun, null);
  assert.deepEqual(texts(controller), []);
});

test("a message the socket may have lost goes again on reconnect, under the same key, once", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "start");
  const first = transport.sent[0];
  connection.close();
  controller.handleClose(connection, controller.link, "conv");
  controller.reconnect();
  await flush();
  const again = transport.sent.filter(frame => frame.clientMessageId === first.clientMessageId);
  assert.equal(again.length, 2);
  assert.equal(again[1].runId, first.runId);
  // The server answers the replay; the message is not sent a third time.
  transport.connections[1].emit({ type: "message.accepted", run_id: first.runId, client_message_id: first.clientMessageId, outcome: "replayed" });
  await flush();
  assert.equal(transport.sent.filter(frame => frame.clientMessageId === first.clientMessageId).length, 2);
});
