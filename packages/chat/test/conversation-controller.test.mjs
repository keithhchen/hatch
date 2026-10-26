import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

class RecordingConnection extends RuntimeConnection {
  constructor(handlers) { super(); this.handlers = handlers; this.sent = []; this.open = true; }
  hello(localTools) { this.sent.push({ type: "client.hello", localTools }); }
  send(message) { this.sent.push({ type: "client.message", ...message }); }
  toolResult(runId, toolCallId, result) { this.sent.push({ type: "tool_call.result", runId, toolCallId, ...result }); }
  cancel(runId) { this.sent.push({ type: "turn.cancel", runId }); }
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

/** In-memory Runtime double for the automated test only. */
class ScriptedTransport extends ConversationTransport {
  constructor() { super(); this.pages = []; this.connections = []; this.snapshots = 0; }
  list() { return Promise.resolve({ conversations: [{ id: "conv" }] }); }
  snapshot() { this.snapshots += 1; return Promise.resolve(this.pages.shift() ?? this.page); }
  events(_id, { afterCursor }) { return Promise.resolve({ events: [], runs: [], cursor: afterCursor, through_cursor: afterCursor, has_more: false }); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "running" }); }
  connect(_id, handlers) { const connection = new RecordingConnection(handlers); this.connections.push(connection); return connection; }
}

const page = (messages = [], runs = [], cursor = 1) => ({ conversation: { id: "conv" }, messages, runs, events: [], cursor, has_more: false });

class NoAttachments extends AttachmentSource {
  accepts() { return false; }
  prepareAll() { return Promise.resolve([]); }
}

class RefusingTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "local_tool_unavailable" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false, error: { code: "approval_unavailable" } }); }
}

function setup() {
  const transport = new ScriptedTransport();
  transport.page = page();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new RefusingTools(), describeError: error => `text:${error.code}`, pollMs: 60_000 });
  return { transport, controller };
}

test("a sent message streams into a transient reply and settles into the durable page", async () => {
  const { transport, controller } = setup();
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  assert.equal(controller.getState().snapshotConversationId, "conv");
  connection.handlers.onOpen();
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  controller.setDraft("hello");
  await controller.send();
  const sent = connection.sent.find(frame => frame.type === "client.message");
  assert.equal(sent.content, "hello");
  assert.deepEqual(sent.localTools, []);
  assert.deepEqual(controller.getState().messages.map(message => message.role), ["user", "assistant"]);
  connection.emit({ type: "message.accepted", run_id: sent.runId });
  connection.emit({ type: "assistant.delta", run_id: sent.runId, delta: { kind: "text", content: "Hi " } });
  connection.emit({ type: "assistant.delta", run_id: sent.runId, delta: { kind: "text", content: "there" } });
  const transient = controller.getState().messages[1];
  assert.equal(transient.transient, true);
  assert.equal(transient.timeline[0].content, "Hi there");
  assert.equal(controller.getState().draft, "");

  transport.pages.push(page([
    { id: "u1", run_id: sent.runId, role: "user", content: "hello" },
    { id: "a1", run_id: sent.runId, role: "assistant", content: "Hi there" }
  ], [{ id: sent.runId, status: "completed" }], 4));
  connection.emit({ type: "turn.completed", run_id: sent.runId });
  await flush();
  const state = controller.getState();
  assert.deepEqual(state.messages.map(message => message.id), ["u1", "a1"]);
  assert.equal(state.messages[1].renderKey, `${sent.runId}-assistant`);
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.status, { key: "connected" });
  controller.dispose();
});

test("client tool and approval requests are answered through the ToolExecutor", async () => {
  const { transport, controller } = setup();
  transport.page = page([], [{ id: "run_live", status: "running" }]);
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  assert.equal(controller.getState().activeRun, "run_live");
  connection.emit({ type: "tool_call.request", run_id: "run_live", tool_call_id: "t1", name: "file_read" });
  connection.emit({ type: "approval.request", run_id: "run_live", tool_call_id: "t2", name: "file_write" });
  await flush();
  const results = connection.sent.filter(frame => frame.type === "tool_call.result");
  assert.deepEqual(results.map(frame => [frame.toolCallId, frame.status, frame.error.message]), [["t1", "error", "text:local_tool_unavailable"], ["t2", "error", "text:approval_unavailable"]]);
  const timeline = controller.getState().messages.at(-1).timeline;
  assert.deepEqual(timeline.map(entry => [entry.kind, entry.status]), [["tool", "failed"], ["tool", "failed"]]);
  controller.dispose();
});

test("a session error before acceptance restores the draft", async () => {
  const { transport, controller } = setup();
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  controller.setDraft("keep me");
  await controller.send();
  connection.emit({ type: "session.error", error: { code: "busy" } });
  const state = controller.getState();
  assert.equal(state.draft, "keep me");
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.error, { code: "busy" });
  controller.dispose();
});

test("a session bound to another Conversation is rejected", async () => {
  const { transport, controller } = setup();
  controller.open("conv");
  await flush();
  transport.connections[0].emit({ type: "session.ready", conversation_id: "other" });
  assert.equal(controller.getState().error.key, "conversationIdentityMismatch");
  assert.equal(transport.connections[0].open, false);
  controller.dispose();
});

test("later refreshes drain the journal from the committed cursor", async () => {
  const { transport, controller } = setup();
  const reads = [];
  transport.events = (_id, options) => { reads.push(options); return Promise.resolve({ events: [], runs: [], cursor: 1, through_cursor: 1, has_more: false }); };
  controller.open("conv");
  await flush();
  assert.deepEqual(reads, []);
  await controller.refresh("conv");
  assert.deepEqual(reads, [{ afterCursor: 1, throughCursor: undefined }]);
  controller.dispose();
});
