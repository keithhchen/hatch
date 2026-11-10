import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, MemoryPendingStore, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

class Connection extends RuntimeConnection {
  constructor(handlers) { super(); this.handlers = handlers; this.open = true; queueMicrotask(() => handlers.onOpen()); }
  hello() { this.handlers.onEvent({ type: "session.ready", conversation_id: "assistant" }); }
  async send(message) { this.handlers.onEvent({ type: "message.accepted", client_message_id: message.clientMessageId, run_id: "run_1", outcome: "started" }); }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
}

/** In-memory double of a transport that can answer a failed Run again: automated tests only. */
class FakeTransport extends ConversationTransport {
  constructor({ retries = true } = {}) { super(); this.retries = retries; this.calls = []; this.outcomes = []; this.connections = []; this.runs = []; }
  get steerable() { return true; }
  get journal() { return false; }
  get retriesRun() { return this.retries; }
  async retryRun(conversationId, key) {
    this.calls.push({ conversationId, key });
    const outcome = this.outcomes.shift() ?? { run_id: "run_2" };
    if (outcome instanceof Error) throw outcome;
    this.runs = [{ id: outcome.run_id, status: "running" }];
    return outcome;
  }
  snapshot() { return Promise.resolve({ conversation: { id: "assistant" }, messages: [], runs: this.runs, events: [], cursor: 1, has_more: false }); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  connect(_id, handlers) { const connection = new Connection(handlers); this.connections.push(connection); return connection; }
}
class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor { execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); } cancel() {} requestApproval() { return Promise.resolve({ approved: false }); } }

async function failedReply(options) {
  const transport = new FakeTransport(options);
  const pendingStore = new MemoryPendingStore();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pendingStore, pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("assistant");
  await flush();
  controller.setDraft("hello");
  await controller.send();
  await flush();
  transport.connections[0].handlers.onEvent({ type: "turn.failed", run_id: "run_1", error: { code: "upstream_error", message: "fetch failed" } });
  await flush();
  return { transport, controller, pendingStore };
}

test("a failed reply is told apart from a connection error, and answering it starts a Run under a key minted at the click", async () => {
  const { transport, controller, pendingStore } = await failedReply();
  assert.deepEqual(controller.getState().failedRun, { id: "run_1" });
  assert.equal(controller.canRetryRun, true);
  assert.equal(transport.calls.length, 0, "nothing is sent until the user clicks");
  await controller.retryRun();
  await flush();
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
  const reopened = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pendingStore, pollMs: 60_000, reconnectAttempts: 0 });
  reopened.open("assistant");
  await flush();
  assert.equal(reopened.pendings.size, 0);
  reopened.dispose();
  controller.dispose();
});

test("without transport support there is nothing to answer again, and a connection error still reconnects", async () => {
  const { transport, controller } = await failedReply({ retries: false });
  assert.equal(controller.canRetryRun, false);
  await controller.retryRun();
  assert.equal(transport.calls.length, 0);
  controller.dismissError();
  assert.equal(controller.getState().failedRun, null);
  // A connection error is not a failed reply: retry() reconnects as before.
  controller.fail(new Error("connection lost"));
  const connections = transport.connections.length;
  controller.retry();
  assert.equal(controller.getState().error, null);
  assert.equal(transport.connections.length, connections + 1);
  controller.dispose();
});
