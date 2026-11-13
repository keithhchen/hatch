import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

// Found by the browser edge-case suite (runtime-server/scripts/verify-web-edges): each test is the client half of an edge the
// real web chat hit. They use an in-memory Runtime double, so they are unit tests, not product evidence.

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

class ScriptedTransport extends ConversationTransport {
  constructor() { super(); this.pages = []; this.connections = []; }
  list() { return Promise.resolve({ conversations: [{ id: "conv" }] }); }
  snapshot() { return Promise.resolve(this.pages.shift() ?? this.page); }
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

const build = (tools = new RefusingTools()) => {
  const transport = new ScriptedTransport();
  transport.page = page();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools, describeError: error => `text:${error.code}`, pollMs: 60_000 });
  return { transport, controller };
};

async function sendOne(text = "hello") {
  const ctx = build();
  ctx.controller.open("conv");
  await flush();
  const connection = ctx.transport.connections[0];
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  ctx.controller.setDraft(text);
  await ctx.controller.send();
  const sent = connection.sent.find(frame => frame.type === "client.message");
  connection.emit({ type: "message.accepted", run_id: sent.runId, client_message_id: sent.clientMessageId, outcome: "started" });
  return { ...ctx, connection, runId: sent.runId, clientMessageId: sent.clientMessageId };
}

test("a Run the user stopped ends as a cancellation: no error banner, no answer-again", async () => {
  const { transport, controller, connection, runId } = await sendOne();
  connection.emit({ type: "assistant.delta", run_id: runId, delta: { kind: "text", content: "partial" } });
  transport.pages.push(page([{ id: "u1", run_id: runId, role: "user", content: "hello" }], [{ id: runId, status: "cancelled" }], 4));
  connection.emit({ type: "turn.failed", run_id: runId, error: { code: "run_cancelled", message: "user_requested" } });
  await flush();
  const state = controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.failedRun, null);
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.status, { key: "connected" });
  controller.dispose();
});

test("a refused frame about a finished Run does not turn its completed reply into a failure", async () => {
  const { transport, controller, connection, runId } = await sendOne();
  transport.pages.push(page([
    { id: "u1", run_id: runId, role: "user", content: "hello" },
    { id: "a1", run_id: runId, role: "assistant", content: "done" }
  ], [{ id: runId, status: "completed" }], 4));
  connection.emit({ type: "turn.completed", run_id: runId });
  await flush();
  connection.emit({ type: "frame.rejected", run_id: runId, error: { code: "unknown_run", message: "No pending run" } });
  await flush();
  const state = controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.failedRun, null);
  assert.deepEqual(state.messages.map(message => message.id), ["u1", "a1"]);
  controller.dispose();
});

test("a refused frame about a live Run leaves the Run running", async () => {
  const { controller, connection, runId } = await sendOne();
  connection.emit({ type: "frame.rejected", run_id: runId, error: { code: "unknown_tool_call", message: "No pending tool call" } });
  connection.emit({ type: "assistant.delta", run_id: runId, delta: { kind: "text", content: "still here" } });
  const state = controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.activeRun, runId);
  assert.equal(state.messages.at(-1).timeline[0].content, "still here");
  controller.dispose();
});

test("a message the server joined to another tab's Run follows that Run: its stream shows and the page's own Run id is dropped", async () => {
  const { controller, connection, clientMessageId } = await (async () => {
    const ctx = build();
    ctx.controller.open("conv");
    await flush();
    const connection = ctx.transport.connections[0];
    connection.emit({ type: "session.ready", conversation_id: "conv" });
    ctx.controller.setDraft("from tab B");
    await ctx.controller.send();
    const sent = connection.sent.find(frame => frame.type === "client.message");
    return { ...ctx, connection, clientMessageId: sent.clientMessageId };
  })();
  connection.emit({ type: "message.accepted", run_id: "run_of_tab_a", client_message_id: clientMessageId, outcome: "steered" });
  connection.emit({ type: "assistant.delta", run_id: "run_of_tab_a", delta: { kind: "text", content: "streaming for A" } });
  const state = controller.getState();
  assert.equal(state.activeRun, "run_of_tab_a");
  assert.equal(state.messages.at(-1).timeline[0].content, "streaming for A");
  assert.equal(state.messages[0].state, "queued");
  controller.dispose();
});

test("a replayed local tool request after a reconnect is executed once and answered on the live session", async () => {
  let executions = 0;
  const tools = new (class extends RefusingTools { execute() { executions += 1; return Promise.resolve({ status: "ok", result: { n: executions } }); } })();
  const { transport, controller } = build(tools);
  transport.page = page([], [{ id: "run_live", status: "running" }]);
  controller.open("conv");
  await flush();
  const connection = transport.connections[0];
  connection.emit({ type: "tool_call.request", run_id: "run_live", tool_call_id: "t1", name: "shell_exec" });
  await flush();
  connection.emit({ type: "tool_call.request", run_id: "run_live", tool_call_id: "t1", name: "shell_exec" });
  await flush();
  assert.equal(executions, 1);
  const results = connection.sent.filter(frame => frame.type === "tool_call.result");
  assert.equal(results.length, 2);
  assert.ok(results.every(frame => frame.status === "ok"));
  controller.dispose();
});
