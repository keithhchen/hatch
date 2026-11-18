import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

// Found by the browser edge-case suite (scenario 3c): a Run that ended while the Runtime was unreachable left the page
// "syncing" forever, because polling never started for a Run the page had been holding a stream for. In-memory Runtime double.

const flush = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class Connection extends RuntimeConnection {
  constructor(handlers) { super(); this.handlers = handlers; this.open = true; }
  hello() {}
  send() {}
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

class OutageTransport extends ConversationTransport {
  constructor() { super(); this.down = false; this.connections = []; this.reads = 0; }
  list() { return Promise.resolve({ conversations: [{ id: "conv" }] }); }
  read(value) { this.reads += 1; return this.down ? Promise.reject(Object.assign(new Error("unavailable"), { status: 502 })) : Promise.resolve(value); }
  snapshot() { return this.read(this.page); }
  events(_id, { afterCursor }) { return this.read({ events: [], runs: this.page.runs, cursor: afterCursor, through_cursor: afterCursor, has_more: false }); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "completed" }); }
  connect(_id, handlers) { const connection = new Connection(handlers); this.connections.push(connection); return connection; }
}

class NoAttachments extends AttachmentSource {
  accepts() { return false; }
  prepareAll() { return Promise.resolve([]); }
}

class NoTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "local_tool_unavailable" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false }); }
}

test("a Run that completes while the Runtime is unreachable settles by polling once it is back", async () => {
  const transport = new OutageTransport();
  transport.page = { conversation: { id: "conv" }, messages: [], runs: [], events: [], cursor: 1, has_more: false };
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 20, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  controller.setDraft("hello");
  await controller.send();
  const runId = controller.getState().activeRun;
  connection.emit({ type: "message.accepted", run_id: runId, client_message_id: undefined, outcome: "started" });
  connection.emit({ type: "assistant.delta", run_id: runId, delta: { kind: "text", content: "done" } });

  transport.down = true;
  connection.emit({ type: "turn.completed", run_id: runId });
  await wait(80);
  assert.equal(controller.getState().activeRun, runId, "still waiting for the saved reply while the Runtime is down");
  assert.ok(transport.reads >= 3, "keeps trying while it is down");

  transport.page = {
    conversation: { id: "conv" }, runs: [{ id: runId, status: "completed" }], events: [], cursor: 5, has_more: false,
    messages: [{ id: "u1", run_id: runId, role: "user", content: "hello" }, { id: `${runId}:1`, run_id: runId, role: "assistant", content: "done" }]
  };
  transport.down = false;
  await wait(120);
  const state = controller.getState();
  assert.equal(state.activeRun, null);
  assert.equal(state.error, null, "the outage's error does not outlive the outage");
  assert.deepEqual(state.messages.map(message => message.role), ["user", "assistant"]);
  controller.dispose();
});

test("a Run whose session died for good (retries spent, no terminal frame) is freed from its record, with the interruption shown", async () => {
  const transport = new OutageTransport();
  transport.page = { conversation: { id: "conv" }, messages: [], runs: [], events: [], cursor: 1, has_more: false };
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 20, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  controller.setDraft("hello");
  await controller.send();
  const runId = controller.getState().activeRun;
  connection.emit({ type: "message.accepted", run_id: runId, client_message_id: undefined, outcome: "started" });
  connection.emit({ type: "assistant.delta", run_id: runId, delta: { kind: "text", content: "par" } });

  transport.down = true;
  connection.handlers.onClose();
  await wait(60);
  assert.equal(controller.getState().connection, "idle");
  assert.equal(controller.getState().activeRun, runId, "the composer stays closed while the Run's fate is unknown");

  transport.page = {
    conversation: { id: "conv" }, events: [], cursor: 5, has_more: false,
    runs: [{ id: runId, status: "interrupted", failure: { code: "runtime_restarted", message: "The Runtime restarted while this Run was in progress. Send the message again to continue." } }],
    messages: [{ id: "u1", run_id: runId, role: "user", content: "hello" }, { id: `${runId}:1`, run_id: runId, role: "assistant", content: "par" }]
  };
  transport.down = false;
  await wait(120);
  const state = controller.getState();
  assert.equal(state.activeRun, null);
  assert.equal(state.failedRun?.id, runId);
  assert.equal(state.error?.code, "runtime_restarted");
  controller.dispose();
});

test("a read the stream asked for that fails once is tried again, and no error is shown", async () => {
  const transport = new OutageTransport();
  transport.page = { conversation: { id: "conv" }, messages: [], runs: [], events: [], cursor: 1, has_more: false };
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 20, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  transport.connections[0].emit({ type: "session.ready", conversation_id: "conv" });
  const reads = transport.reads;
  let failures = 1;
  transport.snapshot = () => { transport.reads += 1; return failures-- > 0 ? Promise.reject(new Error("Something went wrong. Try again.")) : Promise.resolve({ ...transport.page, messages: [{ id: "u1", run_id: "r1", role: "user", content: "hi" }] }); };
  transport.connections[0].emit({ type: "conversation.changed", committed: "assistant" });
  await wait(10);
  assert.equal(controller.getState().error, null, "one failed read shows nothing");
  await wait(60);
  assert.ok(transport.reads >= reads + 2, "the read is tried again");
  assert.equal(controller.getState().error, null);
  assert.deepEqual(controller.getState().messages.map(message => message.content), ["hi"]);
  controller.dispose();
});

test("a read error that is shown goes away when a later read succeeds", async () => {
  const transport = new OutageTransport();
  transport.page = { conversation: { id: "conv" }, messages: [], runs: [], events: [], cursor: 1, has_more: false };
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 20, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  transport.down = true;
  connection.emit({ type: "conversation.changed", committed: "assistant" });
  await wait(60);
  assert.ok(controller.getState().error, "two failed reads in a row are shown");
  transport.down = false;
  connection.emit({ type: "conversation.changed", committed: "assistant" });
  await wait(20);
  assert.equal(controller.getState().error, null, "the next good read takes it back");
  controller.dispose();
});

test("a resync from the server makes the page read the conversation again", async () => {
  const transport = new OutageTransport();
  transport.page = { conversation: { id: "conv" }, messages: [], runs: [], events: [], cursor: 1, has_more: false };
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 20, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  transport.connections[0].emit({ type: "session.ready", conversation_id: "conv" });
  await flush();
  const reads = transport.reads;
  transport.page = { ...transport.page, messages: [{ id: "u1", run_id: "r1", role: "user", content: "missed" }] };
  transport.connections[0].emit({ type: "resync" });
  await wait(30);
  assert.ok(transport.reads > reads, "the conversation was read again");
  assert.deepEqual(controller.getState().messages.map(message => message.content), ["missed"]);
  controller.dispose();
});
