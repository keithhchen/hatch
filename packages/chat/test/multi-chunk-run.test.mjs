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

/** In-memory double of the Studio transport: automated tests only. Each snapshot read waits for the test to answer it. */
class FakeTransport extends ConversationTransport {
  constructor() { super(); this.reads = []; this.connections = []; }
  get steerable() { return true; }
  get journal() { return false; }
  snapshot() { return new Promise(resolve => this.reads.push(resolve)); }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "completed" }); }
  connect(_id, handlers) { const connection = new Stream(handlers); this.connections.push(connection); return connection; }
}
const running = [{ id: "run_1", status: "running" }];
const page = (messages, runs = running, cursor = 1) => ({ conversation: { id: "assistant" }, messages, runs, events: [], cursor, has_more: false });
class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor { execute() { return Promise.resolve({ status: "error", error: { code: "x" } }); } cancel() {} requestApproval() { return Promise.resolve({ approved: false }); } }

const user = { id: "m1", role: "user", content: "hi", run_id: "run_1" };
const reply = (n, content) => ({ id: `run_1:${n}`, run_id: "run_1", role: "assistant", content });
const textOf = message => message.transient ? (message.timeline ?? []).map(entry => entry.content ?? "").join("") : message.content;
const shownText = controller => controller.getState().messages.filter(message => message.role === "assistant").map(textOf).join("|");
const CHUNKS = ["chunk one.", "chunk two.", "chunk three.", "chunk four."];

async function begin() {
  const transport = new FakeTransport();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pendingStore: new MemoryPendingStore(), pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("assistant");
  await flush();
  transport.reads.shift()(page([user]));
  await flush();
  const connection = transport.connections[0];
  const lost = [];
  const shownEver = new Set();
  controller.subscribe(() => {
    const shown = shownText(controller);
    for (const chunk of shownEver) if (!shown.includes(chunk)) lost.push(`${chunk} missing from ${shown}`);
    for (const chunk of CHUNKS) if (shown.includes(chunk)) shownEver.add(chunk);
  });
  const stream = (chunk, offset) => connection.emit({ type: "assistant.delta", run_id: "run_1", delta: { kind: "text", content: chunk, offset } });
  const committed = () => connection.emit({ type: "conversation.changed", committed: "assistant" });
  return { transport, controller, lost, stream, committed, connection };
}

test("text already shown never leaves the page while later chunks stream and reads answer late", async () => {
  const { transport, controller, lost, stream, committed } = await begin();
  const saved = [];
  let offset = 0;
  for (const [index, chunk] of CHUNKS.entries()) {
    stream(chunk, offset);
    offset += chunk.length;
    await flush();
    saved.push(reply(index + 1, chunk));
    committed();
    await flush();
    // The read is answered with what was saved before the previous chunk ended, while this one is already streaming.
    stream(" ", offset);
    offset += 1;
    await flush();
    transport.reads.shift()?.(page([user, ...saved.slice(0, index)], running, index + 2));
    await flush();
  }
  assert.deepEqual(lost, []);
  controller.dispose();
});

test("a read answered after the next chunk began streaming keeps every earlier chunk", async () => {
  const { transport, controller, stream, committed } = await begin();
  stream("chunk one.", 0);
  committed();
  await flush();
  transport.reads.shift()(page([user, reply(1, "chunk one.")], running, 2));
  await flush();
  stream("chunk two.", 10);
  committed();
  await flush();
  // The read starts now; chunk three is streaming before it is answered, and it does not yet hold chunk two.
  stream("chunk three.", 20);
  await flush();
  transport.reads.shift()(page([user, reply(1, "chunk one.")], running, 3));
  await flush();
  const shown = shownText(controller);
  for (const chunk of CHUNKS.slice(0, 3)) assert.ok(shown.includes(chunk), `${chunk} missing from ${shown}`);
  controller.dispose();
});

test("a read that holds all the saved chunks while the last one streams shows each exactly once", async () => {
  const { transport, controller, stream, committed } = await begin();
  stream("chunk one.", 0);
  committed();
  await flush();
  transport.reads.shift()(page([user, reply(1, "chunk one.")], running, 2));
  await flush();
  stream("chunk two.", 10);
  committed();
  await flush();
  stream("chunk three.", 20);
  await flush();
  transport.reads.shift()(page([user, reply(1, "chunk one."), reply(2, "chunk two.")], running, 3));
  await flush();
  const shown = shownText(controller);
  for (const chunk of CHUNKS.slice(0, 3)) assert.equal(shown.split(chunk).length - 1, 1, `${chunk} in ${shown}`);
  controller.dispose();
});
