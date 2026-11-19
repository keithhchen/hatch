import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutor } from "../src/ports/index.js";
import { LogTransport, bringUp, flush, openController, ready, rows, runState, say, text, tool, user } from "./harness.mjs";

test("a sent message shows at once, streams into a transient reply from the log, and settles when the Run ends", async () => {
  const { transport, controller, connection } = await openController();
  assert.deepEqual(transport.reads, [{ turns: 20 }]);
  await bringUp(connection);
  controller.setDraft("hello");
  await controller.send();
  const sent = connection.messages[0];
  assert.equal(sent.content, "hello");
  assert.deepEqual(sent.localTools, []);
  assert.deepEqual(rows(controller), ["user:hello(sending)", "assistant:*"]);
  assert.deepEqual(controller.getState().status, { key: "sending" });
  connection.emit({ type: "message.accepted", run_id: sent.runId, client_message_id: sent.clientMessageId, outcome: "started" });
  transport.stream(user(sent.clientMessageId, "run_1", "hello"), runState("run_1", "running"), text("run_1", "Hi "), text("run_1", "there"));
  assert.deepEqual(rows(controller), ["user:hello", "assistant:Hi there*"]);
  assert.equal(controller.getState().messages[1].transient, true);
  assert.equal(controller.getState().draft, "");
  assert.equal(controller.getState().activeRun, "run_1");
  assert.deepEqual(controller.getState().status, { key: "agentReplying" });
  transport.stream(runState("run_1", "completed"));
  const state = controller.getState();
  assert.deepEqual(rows(controller), ["user:hello", "assistant:Hi there"]);
  assert.equal(state.messages[1].renderKey, "run_1-assistant");
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.status, { key: "connected" });
  controller.dispose();
});

test("opening reads the latest turns and resumes the live session from where they end, over rows no client renders", async () => {
  const transport = new LogTransport();
  transport.push(user("m1", "r1", "earlier"), runState("r1", "completed"), text("r1", "Answer"));
  transport.skip(3);
  const { controller, connection } = await openController({ transport });
  assert.deepEqual(rows(controller), ["user:earlier", "assistant:Answer"]);
  connection.handlers.onOpen();
  assert.deepEqual(connection.sent, [{ type: "client.hello", localTools: [], after: 6 }]);
  controller.dispose();
});

test("a frame at or below the position held is ignored, and an overlapping page folds once", async () => {
  const transport = new LogTransport();
  const [first] = transport.push(user("m1", "r1"), runState("r1", "running"), text("r1", "Hel"));
  const { controller, connection } = await openController({ transport });
  connection.emit({ type: "log.event", event: first });
  connection.emit({ type: "log.event", event: transport.events[2] });
  transport.stream(text("r1", "lo"));
  assert.deepEqual(rows(controller), ["user:m1", "assistant:Hello*"]);
  await controller.refresh("conv");
  assert.deepEqual(rows(controller), ["user:m1", "assistant:Hello*"]);
  assert.deepEqual(transport.reads.at(-1), { after: 4, limit: 200 });
  controller.dispose();
});

test("earlier turns are read by position, a page of turns at a time", async () => {
  const transport = new LogTransport();
  for (let turn = 1; turn <= 22; turn += 1) transport.push(user(`m${turn}`, `r${turn}`), runState(`r${turn}`, "completed"), text(`r${turn}`, `a${turn}`));
  const { controller } = await openController({ transport });
  assert.equal(controller.getState().messages.length, 40);
  assert.equal(controller.getState().historyCursor, 7);
  await controller.loadHistory();
  assert.deepEqual(transport.reads.at(-1), { turns: 20, before: 7 });
  assert.equal(controller.getState().messages.length, 44);
  assert.equal(controller.getState().historyCursor, null);
  assert.equal(controller.getState().messages[0].content, "m1");
  controller.dispose();
});

test("client tool and approval requests are answered through the ToolExecutor; the steps come from the log", async () => {
  const transport = new LogTransport();
  transport.push(user("m1", "run_live"), runState("run_live", "running"));
  const { controller, connection } = await openController({ transport });
  connection.emit({ type: "tool_call.request", run_id: "run_live", tool_call_id: "t1", name: "file_read" });
  connection.emit({ type: "approval.request", run_id: "run_live", tool_call_id: "t2", name: "file_write" });
  await flush();
  const results = connection.sent.filter(frame => frame.type === "tool_call.result");
  assert.deepEqual(results.map(frame => [frame.toolCallId, frame.status, frame.error.message]), [["t1", "error", "text:local_tool_unavailable"], ["t2", "error", "text:approval_unavailable"]]);
  transport.stream(tool("run_live", "t1", "failed", { locality: "client", error: { code: "local_tool_unavailable" } }));
  assert.deepEqual(controller.getState().messages.at(-1).timeline.map(entry => [entry.kind, entry.status]), [["tool", "failed"]]);
  controller.dispose();
});

class GatingTools extends ToolExecutor {
  constructor(prepare) { super(); this.prepare = prepare; this.executed = []; this.prepared = []; }
  get localTools() { return ["file_write"]; }
  prepareRun(run) { this.prepared.push(run); return this.prepare(run); }
  execute(request) { this.executed.push(request.tool_call_id); return Promise.resolve({ status: "ok", result: { ok: true } }); }
  cancel() {}
  requestApproval() { return Promise.resolve({ approved: true }); }
}

test("an approved approval.request waits for its tool_call.request instead of executing twice", async () => {
  const tools = new GatingTools(() => Promise.resolve());
  const { connection } = await openController({ tools });
  connection.emit({ type: "approval.request", run_id: "run_live", tool_call_id: "t1", name: "file_write" });
  await flush();
  assert.deepEqual(tools.executed, []);
  connection.emit({ type: "tool_call.request", run_id: "run_live", tool_call_id: "t1", name: "file_write" });
  connection.emit({ type: "tool_call.request", run_id: "run_live", tool_call_id: "t1", name: "file_write" });
  await flush();
  assert.deepEqual(tools.executed, ["t1"]);
  assert.equal(connection.sent.filter(frame => frame.type === "tool_call.result").length, 2, "a replayed request gets the one result again");
});

test("client authority is prepared before a message is sent; a failed preparation restores the draft", async () => {
  let refuse = false;
  const tools = new GatingTools(() => refuse ? Promise.reject(new Error("no workspace")) : Promise.resolve());
  const { controller, connection } = await openController({ tools });
  await bringUp(connection);
  await say(controller, "hello");
  const sent = connection.messages[0];
  assert.deepEqual(tools.prepared, [{ conversationId: "conv", runId: sent.runId }]);
  assert.deepEqual(sent.localTools, ["file_write"]);
  refuse = true;
  controller.setDraft("again");
  await controller.send();
  assert.equal(connection.messages.length, 1);
  assert.equal(controller.getState().draft, "again");
  assert.equal(controller.getState().error.message, "no workspace");
});

test("a session error before acceptance restores the draft", async () => {
  const { controller, connection } = await openController();
  await bringUp(connection);
  await say(controller, "keep me");
  connection.emit({ type: "session.error", error: { code: "busy" } });
  const state = controller.getState();
  assert.equal(state.draft, "keep me");
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.error, { code: "busy" });
  controller.dispose();
});

test("a session bound to another Conversation is rejected", async () => {
  const { controller, connection } = await openController();
  connection.emit(ready("other"));
  assert.equal(controller.getState().error.key, "conversationIdentityMismatch");
  assert.equal(connection.open, false);
  controller.dispose();
});

test("a dropped session retries three times, then goes idle without an error; the next send reconnects", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { transport, controller, connection } = await openController();
  assert.equal(controller.getState().connection, "connecting");
  connection.emit(ready("conv"));
  assert.equal(controller.getState().connection, "open");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    transport.connection.handlers.onClose();
    assert.equal(controller.getState().connection, "connecting");
    t.mock.timers.tick(5_000);
  }
  assert.equal(transport.connections.length, 4);
  transport.connection.handlers.onClose();
  t.mock.timers.tick(60_000);
  assert.equal(transport.connections.length, 4);
  assert.equal(controller.getState().connection, "idle");
  assert.equal(controller.getState().error, null);
  controller.setDraft("hello");
  await controller.send();
  assert.equal(transport.connections.length, 5);
  assert.equal(controller.getState().connection, "connecting");
  assert.equal(controller.attempts, 0);
  controller.dispose();
});

test("a reconnect resumes the log from the position held: what happened while down arrives, and a Run that ended frees the composer", async () => {
  const transport = new LogTransport({ autoOpen: true, autoReady: true });
  transport.push(user("m1", "run_live"), runState("run_live", "running"), text("run_live", "par"));
  const { controller, connection } = await openController({ transport });
  assert.equal(controller.getState().activeRun, "run_live");
  connection.handlers.onClose();
  transport.push(text("run_live", "tial"), runState("run_live", "completed"));
  controller.reconnect();
  await flush();
  assert.equal(transport.connection.sent[0].after, 3);
  assert.equal(controller.getState().activeRun, null);
  assert.deepEqual(rows(controller), ["user:m1", "assistant:partial"]);
  controller.dispose();
});

test("compaction: the run says compacting while it runs, and a compaction between Runs locks the composer until its end; the chip is recorded once", async () => {
  const transport = new LogTransport();
  transport.push(user("m1", "run_live"), runState("run_live", "running"));
  const { controller } = await openController({ transport });
  transport.stream(runState("run_live", "compacting"));
  assert.equal(controller.getState().runState, "compacting");
  assert.equal(controller.getState().compacting, true);
  transport.stream(["compaction.started", { run_id: "run_live", compaction_id: "c1" }], ["compaction.ended", { run_id: "run_live", compaction_id: "c1" }], runState("run_live", "running"));
  assert.equal(controller.getState().runState, "running");
  assert.equal(controller.getState().compacting, false);
  assert.deepEqual(controller.getState().compactions, [{ id: "compaction-c1", runId: "run_live", conversationId: "conv" }]);
  transport.stream(runState("run_live", "completed"), ["compaction.started", { compaction_id: "c2" }]);
  assert.equal(controller.getState().compacting, true, "after the reply: the composer waits");
  transport.stream(["compaction.ended", { compaction_id: "c2", aborted: true }]);
  assert.equal(controller.getState().compacting, false);
  assert.equal(controller.getState().compactions.length, 1);
  controller.dispose();
});

test("a compaction in progress when the page loads holds the composer until its end", async () => {
  const transport = new LogTransport();
  transport.push(["compaction.started", { compaction_id: "c1" }]);
  const { controller } = await openController({ transport });
  assert.equal(controller.getState().compacting, true);
  transport.stream(["compaction.ended", { compaction_id: "c1" }]);
  assert.equal(controller.getState().compacting, false);
  controller.dispose();
});

test("approval decisions are recorded per tool call and validated", async () => {
  const { controller } = await openController();
  controller.markApproval("t1", "pending");
  controller.markApproval("t1", "allowed");
  assert.deepEqual(controller.getState().approvals, { t1: "allowed" });
  assert.throws(() => controller.markApproval("t1", "maybe"), RangeError);
  controller.dispose();
});

test("a message sent while the socket is open but the session is not ready waits for session.ready", async () => {
  const { transport, controller, connection } = await openController();
  connection.handlers.onOpen();
  await say(controller, "early");
  assert.deepEqual(connection.sent.map(frame => frame.type), ["client.hello"]);
  assert.equal(transport.connections.length, 1, "the connecting session is not torn down");
  assert.deepEqual(rows(controller), ["user:early(sending)", "assistant:*"]);
  connection.emit(ready("conv"));
  await flush();
  assert.deepEqual(connection.messages.map(frame => frame.content), ["early"]);
  controller.dispose();
});

test("a message sent while the first page is loading shows at once and is sent when the session is up", async () => {
  const transport = new LogTransport();
  let release;
  transport.log = () => new Promise(resolve => { release = () => resolve({ events: [], head: 0, has_more_before: false }); });
  const controller = (await openController({ transport })).controller;
  assert.equal(controller.snapshotPending, true);
  await say(controller, "early bird");
  assert.deepEqual(rows(controller), ["user:early bird(sending)", "assistant:*"]);
  assert.equal(transport.connections.length, 0);
  release();
  await flush();
  transport.connection.handlers.onOpen();
  transport.connection.emit(ready("conv"));
  await flush();
  assert.deepEqual(transport.connection.messages.map(frame => frame.content), ["early bird"]);
  controller.dispose();
});

test("a failed first read is shown, and retrying opens the conversation again", async () => {
  const transport = new LogTransport();
  transport.readError = new Error("down");
  const { controller } = await openController({ transport });
  assert.equal(controller.getState().error.message, "down");
  assert.equal(controller.snapshotPending, true);
  transport.readError = null;
  controller.retry();
  await flush();
  assert.equal(controller.snapshotPending, false);
  assert.equal(controller.getState().error, null);
  controller.dispose();
});

test("a reload mid-Run: the log holds the steps and text so far, a thinking block whose start was never read still draws, and the stream continues", async () => {
  const transport = new LogTransport();
  transport.push(user("m1", "run_live"), runState("run_live", "running"), text("run_live", "Hello."), tool("run_live", "t1", "completed"), tool("run_live", "t2", "requested"),
    ["assistant.thinking", { run_id: "run_live", index: 1, phase: "delta", delta: "so far" }]);
  const { controller } = await openController({ transport });
  const kinds = () => controller.getState().messages.at(-1).timeline.map(entry => entry.kind);
  assert.deepEqual(kinds(), ["text", "tool", "tool", "thinking"]);
  transport.stream(["assistant.thinking", { run_id: "run_live", index: 1, phase: "end", content: "so far, done" }], tool("run_live", "t2", "completed"), tool("run_live", "t3", "requested"), text("run_live", "More"));
  const reply = controller.getState().messages.at(-1);
  assert.deepEqual(reply.timeline.filter(entry => entry.kind === "tool").map(entry => [entry.id, entry.status]), [["tool-t1", "completed"], ["tool-t2", "completed"], ["tool-t3", "requested"]]);
  assert.deepEqual(reply.timeline.find(entry => entry.kind === "thinking").streaming, false);
  assert.equal(reply.content, "Hello.\n\nMore");
  assert.equal(controller.getState().error, null);
  controller.dispose();
});

test("a failed Run is a notice that can be answered again, and a new Run takes it away", async () => {
  const { transport, controller } = await openController();
  transport.stream(user("m1", "r1"), runState("r1", "running"), runState("r1", "failed", { failure: { code: "model_failed", message: "boom" } }));
  assert.deepEqual(controller.getState().failedRun, { id: "r1" });
  assert.equal(controller.getState().error.code, "model_failed");
  controller.dispose();
});
