import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, MemoryPendingStore, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = () => new Promise(resolve => setImmediate(resolve));

class Stream extends RuntimeConnection {
  constructor(handlers) { super(); this.handlers = handlers; this.open = true; queueMicrotask(() => handlers.onOpen()); }
  hello() { this.handlers.onEvent({ type: "session.ready", conversation_id: "assistant" }); }
  send() { return Promise.resolve(); }
  toolResult() {}
  cancel() {}
  get ready() { return this.open; }
  close() { this.open = false; }
  emit(event) { this.handlers.onEvent(event); }
}

/** In-memory double of the Studio transport: automated tests only. */
class FakeTransport extends ConversationTransport {
  constructor() { super(); this.page = page(); this.connections = []; }
  get steerable() { return true; }
  get journal() { return false; }
  snapshot() { return Promise.resolve(this.page); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "completed" }); }
  connect(_id, handlers) { const connection = new Stream(handlers); this.connections.push(connection); return connection; }
}
const page = (messages = [], runs = [], cursor = 1) => ({ conversation: { id: "assistant" }, messages, runs, events: [], cursor, has_more: false });
class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor { execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); } cancel() {} requestApproval() { return Promise.resolve({ approved: false }); } }

const user = { id: "m1", role: "user", content: "hi", run_id: "run_1" };
const reply = (n, content) => ({ id: `run_1:${n}`, run_id: "run_1", role: "assistant", content });
const textOf = message => message.transient ? (message.timeline ?? []).map(entry => entry.content ?? "").join("") : message.content;

/** Every state the page is drawn from, once a reply has begun, must show the reply's words. */
async function watch(script) {
  const transport = new FakeTransport();
  transport.page = page([user], [{ id: "run_1", status: "running" }]);
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pendingStore: new MemoryPendingStore(), pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("assistant");
  await flush();
  const gaps = [];
  let streaming = false;
  controller.subscribe(() => {
    if (!streaming) return;
    const shown = controller.getState().messages.filter(message => message.role === "assistant").map(textOf).join("");
    if (!shown.includes("Hello")) gaps.push(controller.getState().messages.map(message => [message.id, message.transient ? "live" : "saved", textOf(message)]));
  });
  transport.connections[0].emit({ type: "assistant.delta", run_id: "run_1", delta: { kind: "text", content: "Hello there", offset: 0 } });
  streaming = true;
  await script({ transport, connection: transport.connections[0] });
  controller.dispose();
  return { gaps, controller };
}

test("the streamed reply stays on the page from its first words until the saved message takes its place", async () => {
  const { gaps, controller } = await watch(async ({ transport, connection }) => {
    transport.page = page([user, reply(1, "Hello there")], [{ id: "run_1", status: "running" }], 2);
    connection.emit({ type: "conversation.changed", committed: "assistant" });
    await flush();
    transport.page = page(transport.page.messages, [], 3);
    connection.emit({ type: "turn.completed", run_id: "run_1", finish_reason: "completed" });
    await flush();
  });
  assert.deepEqual(gaps, []);
  assert.deepEqual(controller.getState().messages.map(message => [message.id, message.transient]), [["m1", undefined], ["run_1:1", undefined]]);
});

test("a reply committed after the Run's end is read is still on the page until it arrives", async () => {
  const { gaps } = await watch(async ({ transport, connection }) => {
    transport.page = page([user], [], 3);
    connection.emit({ type: "turn.completed", run_id: "run_1", finish_reason: "completed" });
    await flush();
  });
  assert.deepEqual(gaps, []);
});

test("a Run with two replies never gives two rows the same key", async () => {
  const { controller } = await watch(async ({ transport, connection }) => {
    transport.page = page([user, reply(1, "Hello there")], [{ id: "run_1", status: "running" }], 2);
    connection.emit({ type: "conversation.changed", committed: "assistant" });
    await flush();
  });
  const keys = controller.getState().messages.map(message => message.renderKey ?? `${message.run_id}-${message.role}`);
  assert.equal(new Set(keys).size, keys.length, keys.join(","));
});
