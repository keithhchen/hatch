import assert from "node:assert/strict";
import test from "node:test";
import { LogTransport, flush, openController, rows, runState, say, sleep, text, user } from "./harness.mjs";

// Product Chat's socket: a send is answered by an event, a session can go silent, the log is how a page catches up.
const open = (options = {}, transportOptions = {}) => openController({ transport: new LogTransport({ steerable: true, autoOpen: true, autoReady: true, ...transportOptions }), reconnectAttempts: Number.POSITIVE_INFINITY, ...options });

test("a send the session never answers goes back to the composer with a plain error, under the same key", async () => {
  const { transport, controller } = await open({ ackTimeoutMs: 30 });
  await say(controller, "hello");
  const [first] = transport.connection.messages;
  await sleep(80);
  const state = controller.getState();
  assert.equal(state.draft, "hello");
  assert.equal(state.error?.key, "sendNotConfirmed");
  assert.deepEqual(rows(controller).filter(row => row.startsWith("user:")), []);
  // The session was judged dead: a new one is open, and the message is not sent behind the user's back.
  assert.equal(transport.connections.length, 2);
  await flush();
  assert.equal(transport.connection.messages.length, 0);
  await controller.send();
  assert.equal(transport.connection.messages[0].clientMessageId, first.clientMessageId);
  controller.dispose();
});

test("an acknowledged send is never restored", async () => {
  const { transport, controller, connection } = await open({ ackTimeoutMs: 30 });
  await say(controller, "hello");
  const [first] = connection.messages;
  connection.emit({ type: "message.accepted", run_id: first.runId, client_message_id: first.clientMessageId, outcome: "started" });
  transport.stream(user(first.clientMessageId, "run_1", "hello"), runState("run_1", "running"));
  await sleep(80);
  assert.equal(controller.getState().draft, "");
  assert.equal(controller.getState().error, null);
  assert.equal(transport.connections.length, 1);
  controller.dispose();
});

test("a message sent while the session is gone is sent once, when a session is up", async () => {
  const { transport, controller, connection } = await open({ ackTimeoutMs: 0 });
  connection.handlers.onClose();
  await say(controller, "while away");
  controller.nudge();
  await flush();
  assert.equal(transport.connections.flatMap(entry => entry.messages).filter(frame => frame.content === "while away").length, 1);
  assert.equal(controller.getState().error, null);
  controller.dispose();
});

test("online or a visible tab retries a session that is down at once, not after its backoff", async () => {
  const { transport, controller, connection } = await open();
  connection.handlers.onClose();
  assert.equal(controller.getState().connection, "connecting");
  assert.equal(transport.connections.length, 1);
  controller.nudge();
  assert.equal(transport.connections.length, 2);
  controller.dispose();
});

test("a session that says nothing for stallMs is replaced, and the new session resumes the log from the position held", async () => {
  const { transport, controller, connection } = await open({ stallMs: 80 });
  transport.stream(user("m1", "run_1"), runState("run_1", "running"));
  await sleep(40);
  connection.emit({ type: "session.heartbeat" });
  await sleep(60);
  assert.equal(transport.connections.length, 1, "a frame within stallMs is a sign of life");
  transport.push(text("run_1", "missed while silent"));
  await sleep(150);
  assert.ok(transport.connections.length >= 2);
  assert.equal(transport.connections[1].sent[0].after, 2);
  assert.deepEqual(rows(controller), ["user:m1", "assistant:missed while silent*"]);
  controller.dispose();
});

test("a stop is a cancel frame for the Run the log says is going; a stopped Run shows no error and nothing to answer again", async () => {
  const { transport, controller, connection } = await open();
  transport.stream(user("m1", "run_1"), runState("run_1", "running"), text("run_1", "long answer"));
  controller.cancel();
  assert.deepEqual(connection.sent.at(-1), { type: "turn.cancel", runId: "run_1" });
  assert.equal(controller.getState().status.key, "stopping");
  transport.stream(runState("run_1", "cancelled"));
  const state = controller.getState();
  assert.equal(state.error, null);
  assert.equal(state.failedRun, null);
  assert.deepEqual(state.status, { key: "connected" });
  assert.deepEqual(rows(controller), ["user:m1", "assistant:long answer"]);
  controller.dispose();
});

test("a Run that completes while the Runtime is unreachable settles by reading the log once it is back", async () => {
  const transport = new LogTransport({ autoOpen: true, autoReady: true });
  transport.push(user("m1", "run_live"), runState("run_live", "running"), text("run_live", "par"));
  const { controller, connection } = await openController({ transport, pollMs: 20, reconnectAttempts: 0 });
  connection.handlers.onClose();
  assert.equal(controller.getState().connection, "idle");
  transport.readError = new Error("unreachable");
  await sleep(60);
  assert.equal(controller.getState().error.message, "unreachable");
  transport.readError = null;
  transport.push(text("run_live", "tial"), runState("run_live", "completed"));
  await sleep(60);
  assert.equal(controller.getState().activeRun, null);
  assert.equal(controller.getState().error, null, "a later read that succeeds takes the error back");
  assert.deepEqual(rows(controller), ["user:m1", "assistant:partial"]);
  controller.dispose();
});

test("a read of the log is made one at a time and pages are followed to the end", async () => {
  const { transport, controller } = await open();
  transport.push(...Array.from({ length: 450 }, (_, index) => text("run_1", `${index},`)));
  await controller.refresh("conv");
  assert.deepEqual(transport.reads.map(read => read.after), [undefined, 0, 200, 400]);
  assert.equal(controller.log.position, 450);
  assert.equal(controller.getState().messages[0].content.startsWith("0,1,2,"), true);
  controller.dispose();
});

test("a conversation left while a read was in flight is not touched by its answer", async () => {
  const transport = new LogTransport({ autoOpen: true, autoReady: true });
  const { controller } = await openController({ transport });
  const log = transport.log.bind(transport);
  let release;
  transport.log = (id, options) => options.after === undefined ? log(id, options) : (() => { const answer = log(id, options); return new Promise(resolve => { release = () => resolve(answer); }); })();
  transport.push(user("m1", "run_1"));
  const read = controller.refresh("conv");
  await flush();
  transport.events = [];
  controller.open("other");
  release();
  await read;
  assert.deepEqual(rows(controller), []);
  controller.dispose();
});
