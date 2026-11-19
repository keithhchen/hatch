import assert from "node:assert/strict";
import test from "node:test";
import { MemoryPendingStore, SessionPendingStore } from "../src/ports/index.js";
import { LogTransport, flush, openController, queued, rows, runState, say, text, user } from "./harness.mjs";

const steerable = () => new LogTransport({ steerable: true, autoOpen: true, autoReady: true });
const open = (options = {}) => openController({ transport: steerable(), reconnectAttempts: 0, ...options });
const accept = (connection, frame, outcome = "started") => connection.emit({ type: "message.accepted", run_id: frame.runId, client_message_id: frame.clientMessageId, outcome });

test("a message sent during a Run is a steer: queued until the Run takes it up, then in place; the composer stays open", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "start");
  const [first] = connection.messages;
  accept(connection, first);
  transport.stream(user(first.clientMessageId, "run_1", "start"), runState("run_1", "running"), text("run_1", "Working."));
  assert.equal(controller.steerable, true);
  assert.deepEqual(rows(controller), ["user:start", "assistant:Working.*"]);

  await say(controller, "also this");
  const steer = connection.messages[1];
  assert.equal(steer.runId, "run_1");
  assert.deepEqual(rows(controller), ["user:start", "assistant:Working.*", "user:also this(sending)"]);
  accept(connection, steer, "steered");
  assert.deepEqual(rows(controller), ["user:start", "assistant:Working.*", "user:also this(queued)"]);
  transport.stream(queued(steer.clientMessageId, "run_1", "also this"));
  assert.deepEqual(rows(controller), ["user:start", "assistant:Working.*", "user:also this(queued)"], "the log's queued message replaces the optimistic one");
  assert.equal(controller.pendings.size, 0);
  assert.equal(controller.getState().activeRun, "run_1");

  // The Run takes it up: [A, steps, M, B], never M at the top.
  transport.stream(user(steer.clientMessageId, "run_1", "also this"), text("run_1", "Now this."));
  assert.deepEqual(rows(controller), ["user:start", "assistant:Working.", "user:also this", "assistant:Now this.*"]);
  const keys = controller.getState().messages.map(message => message.renderKey);
  assert.equal(new Set(keys).size, keys.length);
  controller.dispose();
});

test("two identical texts sent back to back are two messages under two keys", async () => {
  const { controller, connection } = await open();
  await say(controller, "again");
  accept(connection, connection.messages[0]);
  await say(controller, "again");
  assert.equal(connection.messages.length, 2);
  assert.notEqual(connection.messages[0].clientMessageId, connection.messages[1].clientMessageId);
  assert.equal(connection.messages[1].runId, connection.messages[0].runId, "the second joins the Run the first started");
  controller.dispose();
});

test("a refused steer goes back to the composer alone: the other message stays and the Run keeps running", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "start");
  const first = connection.messages[0];
  accept(connection, first);
  transport.stream(user(first.clientMessageId, "run_1", "start"), runState("run_1", "running"));
  await say(controller, "too long");
  const steer = connection.messages[1];
  connection.emit({ type: "message.rejected", run_id: "run_1", client_message_id: steer.clientMessageId, error: { code: "limit", message: "slow down" } });
  const state = controller.getState();
  assert.equal(state.draft, "too long");
  assert.deepEqual(rows(controller), ["user:start", "assistant:*"]);
  assert.equal(state.activeRun, "run_1");
  assert.equal(state.failedRun, null);
  assert.equal(state.error.message, "slow down");
  controller.dispose();
});

test("a refused first message goes back to the composer and no Run is left", async () => {
  const { controller, connection } = await open();
  await say(controller, "hello");
  const first = connection.messages[0];
  connection.emit({ type: "message.rejected", run_id: first.runId, client_message_id: first.clientMessageId, error: { code: "free_limit", message: "limit" } });
  const state = controller.getState();
  assert.equal(state.draft, "hello");
  assert.equal(state.activeRun, null);
  assert.deepEqual(rows(controller), []);
  controller.dispose();
});

test("a message the socket may have lost goes again on reconnect, under the same key, once", async () => {
  const { transport, controller, connection } = await open();
  await say(controller, "start");
  const first = connection.messages[0];
  connection.close();
  controller.handleClose(connection, controller.link, "conv");
  controller.reconnect();
  await flush();
  const again = transport.connection.messages.filter(frame => frame.clientMessageId === first.clientMessageId);
  assert.equal(again.length, 1);
  accept(transport.connection, first, "replayed");
  transport.stream(user(first.clientMessageId, "run_1", "start"), runState("run_1", "running"));
  await flush();
  assert.equal(transport.connection.messages.length, 1, "not a third time");
  assert.deepEqual(rows(controller), ["user:start", "assistant:*"]);
  controller.dispose();
});

test("a reload sends a message the log does not hold again, under the same key; one it holds is not sent again", async () => {
  const pendingStore = new MemoryPendingStore();
  pendingStore.save({ conversationId: "conv", clientMessageId: "message_kept", content: "before the refresh", attachments: [{ asset_id: "a1", type: "file" }] });
  pendingStore.save({ conversationId: "conv", clientMessageId: "message_held", content: "hi", attachments: [] });
  const transport = steerable();
  transport.push(queued("message_held", "run_1", "hi"), user("m0", "run_1"), runState("run_1", "running"));
  const { controller, connection } = await openController({ transport, pendingStore, reconnectAttempts: 0 });
  assert.deepEqual(connection.messages.map(frame => [frame.clientMessageId, frame.content, frame.attachments]), [["message_kept", "before the refresh", [{ asset_id: "a1", type: "file" }]]]);
  assert.equal(connection.messages[0].runId, "run_1", "it joins the Run that is going");
  assert.deepEqual(pendingStore.load("conv").map(record => record.clientMessageId), ["message_kept"]);
  accept(connection, connection.messages[0], "steered");
  assert.deepEqual(pendingStore.load("conv"), [], "acknowledged, so no longer pending");
  controller.dispose();
});

test("a message not yet acknowledged survives a reload in the tab's session storage and is sent once under its key", async () => {
  const raw = {};
  const storage = () => ({ getItem: key => raw[key] ?? null, setItem: (key, value) => { raw[key] = value; } });
  const first = await open({ pendingStore: new SessionPendingStore(storage, "k"), ackTimeoutMs: 0 });
  first.connection.handlers.onClose();
  await say(first.controller, "before the reload");
  first.controller.dispose();
  const second = await open({ pendingStore: new SessionPendingStore(storage, "k"), ackTimeoutMs: 0 });
  assert.deepEqual(second.connection.messages.map(frame => frame.content), ["before the reload"]);
  accept(second.connection, second.connection.messages[0]);
  assert.deepEqual(JSON.parse(raw.k), []);
  second.controller.dispose();
});

test("a failed send that may have reached the server is sent again under the same key; a refused one (a 4xx) is a different message", async () => {
  const { transport, controller, connection } = await open();
  const original = connection.send.bind(connection);
  connection.send = async message => { transport.sent = [...(transport.sent ?? []), message]; throw Object.assign(new Error("offline"), { code: "network" }); };
  await say(controller, "keep my key");
  const key = transport.sent[0].clientMessageId;
  assert.equal(controller.getState().draft, "keep my key");
  connection.send = original;
  await controller.send();
  await flush();
  assert.equal(connection.messages.at(-1).clientMessageId, key);
  connection.send = async message => { transport.sent.push(message); throw Object.assign(new Error("bad"), { status: 400 }); };
  accept(connection, connection.messages.at(-1));
  await say(controller, "too long");
  connection.send = original;
  await say(controller, "shorter");
  assert.notEqual(transport.sent.at(-1).clientMessageId, connection.messages.at(-1).clientMessageId);
  controller.dispose();
});

test("a message another tab sent is on the page from the log, and the Run it started is followed", async () => {
  const transport = new LogTransport({ steerable: true, autoOpen: true, autoReady: true, adoptsForeignRuns: true });
  const { controller } = await openController({ transport });
  transport.stream(user("m_b", "run_b", "from my phone"), runState("run_b", "queued"), runState("run_b", "running"), text("run_b", "hi"));
  assert.equal(controller.getState().activeRun, "run_b");
  assert.deepEqual(rows(controller), ["user:from my phone", "assistant:hi*"]);
  assert.equal(transport.reads.length, 1, "no read for it: the session carried it");
  controller.dispose();
});
