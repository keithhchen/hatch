import assert from "node:assert/strict";
import test from "node:test";
import { MemoryPendingStore } from "../src/ports/index.js";
import { LogTransport, flush, openController, rows, say, sleep, text, runState, user } from "./harness.mjs";

const soon = () => new Date(Date.now() + 60_000).toISOString();

/** A steerable transport that answers a failed Run again by starting Run 2. */
function transportFor(options = {}) {
  const transport = new LogTransport({ steerable: true, autoOpen: true, autoReady: true, retriesRun: true, conversationId: "assistant", ...options });
  transport.calls = [];
  transport.outcomes = [];
  transport.retryRun = async (conversationId, key) => {
    transport.calls.push({ conversationId, key });
    const outcome = transport.outcomes.shift() ?? { run_id: "run_2" };
    if (outcome instanceof Error) throw outcome;
    transport.stream(["run.superseded", { run_id: "run_1", by: outcome.run_id }], runState(outcome.run_id, "running"));
    return outcome;
  };
  return transport;
}

const open = async (transport, options = {}) => openController({ transport, id: "assistant", pendingStore: new MemoryPendingStore(), reconnectAttempts: 0, ...options });

async function failedReply(options) {
  const transport = transportFor(options);
  const pendingStore = new MemoryPendingStore();
  const { controller, connection } = await open(transport, { pendingStore });
  await say(controller, "hello");
  const sent = connection.messages[0];
  transport.stream(user(sent.clientMessageId, "run_1", "hello"), runState("run_1", "running"), runState("run_1", "failed", { failure: { code: "upstream_error", message: "fetch failed" } }));
  return { transport, controller, pendingStore, connection };
}

test("a failed reply is told apart from a connection error, and answering it starts a Run under a key minted at the click", async () => {
  const { transport, controller, pendingStore } = await failedReply();
  assert.deepEqual(controller.getState().failedRun, { id: "run_1" });
  assert.equal(controller.getState().error.code, "upstream_error");
  assert.equal(controller.canRetryRun, true);
  assert.equal(transport.calls.length, 0, "nothing is sent until the user clicks");
  await controller.retryRun();
  assert.equal(transport.calls.length, 1);
  assert.match(transport.calls[0].key, /^retry_/);
  assert.equal(controller.getState().failedRun, null);
  assert.equal(controller.getState().error, null);
  assert.equal(controller.getState().activeRun, "run_2");
  assert.deepEqual(pendingStore.load("assistant"), [], "the key is settled once the server has answered");
  controller.dispose();
});

test("an ambiguous failure keeps the key, so clicking again is the same Run; a refusal spends it", async () => {
  const { transport, controller, pendingStore } = await failedReply();
  transport.outcomes.push(new Error("network down"), Object.assign(new Error("busy"), { status: 409 }));
  await controller.retryRun();
  const [kept] = pendingStore.load("assistant");
  assert.equal(kept.kind, "retry");
  assert.ok(controller.getState().error);
  await controller.retryRun();
  assert.equal(transport.calls[1].key, kept.clientMessageId, "the same key is sent again");
  assert.deepEqual(pendingStore.load("assistant"), [], "a 409 is the server's answer");
  assert.equal(controller.getState().failedRun?.id, "run_1", "the reply can still be answered again later");
  controller.dispose();
});

test("a reload does not send a retry key as a message", async () => {
  const { transport, controller, pendingStore } = await failedReply();
  transport.outcomes.push(new Error("network down"));
  await controller.retryRun();
  const { controller: reopened } = await open(transport, { pendingStore });
  assert.equal(reopened.pendings.size, 0);
  reopened.dispose();
  controller.dispose();
});

test("without transport support there is nothing to answer again, and a connection error still reconnects", async () => {
  const { transport, controller } = await failedReply({ retriesRun: false });
  assert.equal(controller.canRetryRun, false);
  await controller.retryRun();
  assert.equal(transport.calls.length, 0);
  controller.dismissError();
  assert.equal(controller.getState().failedRun, null);
  controller.fail(new Error("connection lost"));
  const connections = transport.connections.length;
  controller.retry();
  assert.equal(controller.getState().error, null);
  assert.equal(transport.connections.length, connections + 1);
  controller.dispose();
});

test("opening a conversation whose last reply failed offers to answer it again; one that completed offers nothing", async () => {
  const transport = transportFor();
  transport.push(user("m1", "run_9"), runState("run_9", "failed", { failure: { code: "upstream_error", message: "fetch failed" } }));
  const { controller } = await open(transport);
  assert.deepEqual(controller.getState().failedRun, { id: "run_9" });
  assert.ok(controller.getState().error);
  const completed = transportFor();
  completed.push(user("m1", "run_9"), runState("run_9", "failed"), user("m2", "run_10"), runState("run_10", "completed"));
  const { controller: other } = await open(completed);
  assert.equal(other.getState().failedRun, null);
  assert.equal(other.getState().error, null);
});

test("a Run a restart interrupted shows no error and offers no answer again: the server starts the reply again", async () => {
  const transport = transportFor();
  const { controller, connection } = await open(transport);
  await say(controller, "hello");
  const sent = connection.messages[0];
  transport.stream(user(sent.clientMessageId, "run_1", "hello"), runState("run_1", "running"), text("run_1", "partial"), runState("run_1", "interrupted", { failure: { code: "run_interrupted" } }));
  const state = controller.getState();
  assert.equal(state.error, null, "no notice, technical or not");
  assert.equal(state.failedRun, null);
  assert.equal(transport.calls.length, 0, "nothing is answered again by the client");
  assert.deepEqual(rows(controller), ["user:hello", "assistant:partial"], "the partial reply stays, quietly");
});

test("a reload in the gap: the interrupted reply being started again shows as working, with no notice", async () => {
  const transport = transportFor();
  transport.push(user("m1", "run_9"), runState("run_9", "running"), text("run_9", "partial"), runState("run_9", "interrupted"), ["run.retrying", { run_id: "run_9", until: soon() }]);
  const { controller } = await open(transport);
  const state = controller.getState();
  assert.equal(state.activeRun, "run_9");
  assert.equal(state.error, null);
  assert.equal(state.failedRun, null);
  assert.ok(state.messages.some(message => message.transient), "a working row is shown");
  controller.dispose();
});

test("a live client in the gap shows working, then the retry's Run replaces the interrupted reply and streams", async () => {
  const transport = transportFor();
  const { controller } = await open(transport);
  transport.stream(user("m1", "run_1", "hello"), runState("run_1", "running"), text("run_1", "part"), runState("run_1", "interrupted"), ["run.retrying", { run_id: "run_1", until: soon() }]);
  assert.equal(controller.getState().activeRun, "run_1", "working in the gap");
  assert.equal(controller.getState().error, null);
  transport.stream(["run.superseded", { run_id: "run_1", by: "run_2" }], runState("run_2", "running"), text("run_2", "whole answer"));
  assert.equal(controller.getState().activeRun, "run_2");
  assert.deepEqual(rows(controller), ["user:hello", "assistant:whole answer*"]);
  assert.equal(controller.getState().error, null);
  controller.dispose();
});

test("budget exhausted: the retry lapses and the client goes idle, quietly, the partial reply kept", async () => {
  const transport = transportFor();
  transport.push(user("m1", "run_9"), runState("run_9", "running"), text("run_9", "partial"), runState("run_9", "interrupted"), ["run.retrying", { run_id: "run_9", until: new Date(Date.now() + 80).toISOString() }]);
  const { controller } = await open(transport);
  assert.equal(controller.getState().activeRun, "run_9");
  await sleep(150);
  const state = controller.getState();
  assert.equal(state.activeRun, null);
  assert.equal(state.error, null);
  assert.equal(state.failedRun, null);
  assert.deepEqual(rows(controller), ["user:m1", "assistant:partial"]);
  controller.dispose();
  await flush();
});
