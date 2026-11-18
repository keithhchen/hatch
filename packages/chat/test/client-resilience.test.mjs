import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { ChatTimeline } from "../src/domain/timeline.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

class Connection extends RuntimeConnection {
  constructor(handlers) { super(); this.handlers = handlers; this.sent = []; this.open = true; }
  hello() {}
  send(message) { this.sent.push(message); }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

/** In-memory Runtime double for automated tests only. */
class Transport extends ConversationTransport {
  constructor({ steerable = false } = {}) { super(); this.isSteerable = steerable; this.pages = []; this.connections = []; this.snapshots = 0; this.page = page(); }
  get steerable() { return this.isSteerable; }
  snapshot() { this.snapshots += 1; const next = this.pages.shift() ?? this.page; return next instanceof Error ? Promise.reject(next) : Promise.resolve(next); }
  events(_id, { afterCursor }) { return this.eventsPage?.(afterCursor) ?? Promise.resolve({ events: [], runs: [], cursor: afterCursor, through_cursor: afterCursor, has_more: false }); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "running" }); }
  connect(_id, handlers) { const connection = new Connection(handlers); this.connections.push(connection); return connection; }
}
const page = (messages = [], runs = [], cursor = 1, extra = {}) => ({ conversation: { id: "conv" }, messages, runs, events: [], cursor, has_more: false, ...extra });
class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor {
  execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: false }); }
}
async function open(transport) {
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), describeError: error => `text:${error.code ?? error.message}`, pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("conv");
  await flush();
  return { controller, connection: transport.connections[0] };
}
const tool = (status, extra = {}) => ({ type: "tool_call.delta", run_id: "run_live", tool_call_id: "t1", name: "box.bash", arguments: {}, locality: "server", status, ...extra });
const liveTools = controller => controller.getState().messages.at(-1).timeline.filter(entry => entry.kind === "tool").map(entry => [entry.id, entry.status]);

// F10 -------------------------------------------------------------------------

test("F10: a journal holding a type this page does not know is read, and the cursor moves past it", async () => {
  const transport = new Transport();
  transport.page = page([], [], 5);
  const { controller } = await open(transport);
  transport.eventsPage = after => Promise.resolve({ events: [{ cursor: 6, type: "future.thing", payload: {} }], runs: [], cursor: 6, through_cursor: 6, has_more: false });
  transport.page = page([], [], 6);
  await controller.refresh("conv");
  assert.equal(controller.getState().error, null);
  controller.dispose();
});

test("F10: a refused journal is read again from the latest page once, and the page recovers", async () => {
  const transport = new Transport();
  transport.page = page([], [], 5);
  const { controller } = await open(transport);
  transport.eventsPage = () => Promise.resolve({ events: [], runs: [], cursor: 1, through_cursor: "x", has_more: false });
  transport.page = page([{ id: "m1", run_id: "r1", role: "assistant", content: "fresh" }], [], 9);
  await controller.refresh("conv");
  assert.deepEqual(controller.getState().messages.map(message => message.content), ["fresh"]);
  assert.equal(controller.getState().error, null);
  controller.dispose();
});

test("F10: a page that stays invalid is tried twice, then shown as an error, not looped", async () => {
  const transport = new Transport();
  transport.page = { ...page(), events: [{ cursor: 1, type: "run.state", payload: {} }] };
  const { controller } = await open(transport);
  await flush();
  assert.equal(transport.snapshots, 2);
  assert.ok(controller.getState().error);
  controller.dispose();
});

// F14 -------------------------------------------------------------------------

test("F14: a late event of an earlier Run does not hijack the Run a send is waiting on", async () => {
  const transport = new Transport({ steerable: true });
  const { controller, connection } = await open(transport);
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  connection.emit({ type: "assistant.delta", run_id: "run_old", delta: { kind: "text", content: "x" } });
  connection.emit({ type: "turn.completed", run_id: "run_old" });
  await flush();
  controller.setDraft("next");
  await controller.send();
  const minted = controller.getState().activeRun;
  assert.ok(minted);
  connection.emit(tool("requested", { run_id: "run_old" }));
  connection.emit({ type: "assistant.delta", run_id: "run_old", delta: { kind: "text", content: "late" } });
  assert.equal(controller.getState().activeRun, minted, "the earlier Run is not adopted");
  const clientMessageId = connection.sent[0].clientMessageId;
  connection.emit({ type: "message.accepted", run_id: "run_new", client_message_id: clientMessageId, outcome: "started" });
  assert.equal(controller.getState().activeRun, "run_new", "the Run the server acknowledged for this send is adopted");
  controller.dispose();
});

test("F14: before the ack, a Run that has not ended is adopted", async () => {
  const transport = new Transport({ steerable: true });
  const { controller, connection } = await open(transport);
  connection.emit({ type: "session.ready", conversation_id: "conv" });
  controller.setDraft("next");
  await controller.send();
  connection.emit({ type: "assistant.delta", run_id: "run_other_tab", delta: { kind: "text", content: "x" } });
  assert.equal(controller.getState().activeRun, "run_other_tab");
  controller.dispose();
});

// F15 -------------------------------------------------------------------------

test("F15: a read older than a live event never moves a tool back", async () => {
  const transport = new Transport();
  transport.page = page([], [{ id: "run_live", status: "running", partial_output: "", activity: { tool_calls: [tool("requested")] } }]);
  const { controller, connection } = await open(transport);
  connection.emit(tool("completed", { result: { ok: true } }));
  assert.deepEqual(liveTools(controller), [["tool-t1", "completed"]]);
  await controller.refresh("conv"); // the same, older page
  assert.deepEqual(liveTools(controller), [["tool-t1", "completed"]]);
  controller.dispose();
});

test("F15: a step moves forward, and a skill run too", () => {
  const timeline = new ChatTimeline();
  timeline.upsertTool(tool("requested"));
  timeline.upsertTool(tool("failed", { error: { code: "e" } }));
  timeline.upsertTool(tool("requested"));
  assert.equal(timeline.snapshot()[0].status, "failed");
  assert.deepEqual(timeline.snapshot()[0].content.error, { code: "e" });
  const run = status => ({ run_id: "r", skill_run_id: "s", name: "n", status });
  timeline.upsertSkillRun(run("completed"));
  timeline.upsertSkillRun(run("running"));
  assert.equal(timeline.snapshot().find(entry => entry.kind === "skill_run").status, "completed");
});

// Thinking tolerance ----------------------------------------------------------

test("a thinking end heard twice updates the step, it never adds a second one", () => {
  const timeline = new ChatTimeline();
  timeline.startThinking(0);
  timeline.finishThinking(0, "plan");
  timeline.finishThinking(0, "plan");
  assert.deepEqual(timeline.snapshot().map(entry => [entry.content, entry.streaming]), [["plan", false]]);
});

test("a thinking start heard twice leaves no step streaming for good", () => {
  const timeline = new ChatTimeline();
  timeline.startThinking(0);
  timeline.appendThinking(0, "a");
  timeline.startThinking(0);
  timeline.finishThinking(0, "b");
  assert.deepEqual(timeline.snapshot().map(entry => entry.streaming), [false, false]);
});

test("a new block at an index that finished before still draws", () => {
  const timeline = new ChatTimeline();
  timeline.startThinking(0);
  timeline.finishThinking(0, "one");
  timeline.startThinking(0);
  timeline.finishThinking(0, "two");
  assert.deepEqual(timeline.snapshot().map(entry => entry.content), ["one", "two"]);
});
