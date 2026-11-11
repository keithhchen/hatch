import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

class QuietConnection extends RuntimeConnection {
  get ready() { return true; }
  close() {} hello() {} send() {} toolResult() {} cancel() {}
}

/** Unit double of the Studio Assistant: the page lists only the Run in progress; a stream says what the journal recorded. */
class StudioDouble extends ConversationTransport {
  constructor() { super(); this.messages = []; this.running = null; this.held = []; this.hold = false; }
  get steerable() { return true; }
  get journal() { return false; }
  get retriesRun() { return true; }
  list() { return Promise.resolve({ conversations: [{ id: "assistant" }] }); }
  snapshot() {
    const body = { conversation: { id: "assistant" }, messages: [...this.messages], cursor: 1, has_more: false, events: [],
      runs: this.running ? [{ id: this.running, status: "running" }] : [] };
    if (!this.hold) return Promise.resolve(body);
    return new Promise(resolve => this.held.push(() => resolve(body)));
  }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "completed" }); }
  connect(_id, handlers) {
    const connection = new QuietConnection();
    this.emit = event => handlers.onEvent(event);
    this.handlers = handlers;
    return connection;
  }
}
class NoAttachments extends AttachmentSource { accepts() { return false; } prepareAll() { return Promise.resolve([]); } }
class NoTools extends ToolExecutor { execute() {} cancel() {} requestApproval() {} }

async function open() {
  const transport = new StudioDouble();
  const controller = new ConversationController({ transport, attachments: new NoAttachments(), tools: new NoTools(), pollMs: 60_000 });
  controller.open("assistant");
  await flush();
  transport.handlers.onOpen();
  transport.emit({ type: "session.ready", conversation_id: "assistant" });
  await flush();
  return { transport, controller };
}

const changed = committed => ({ type: "conversation.changed", committed });
const ended = run => ({ type: "turn.completed", run_id: run, finish_reason: "completed" });
const rows = controller => controller.getState().messages.filter(message => message.transient);

/** The journal of a Run the page did not start, in the order the Studio stream delivers it. */
const startSystemRun = (transport, run) => { transport.running = run; transport.emit(changed("claimed")); };
function saveReply(transport, run) {
  transport.messages.push({ id: `${run}:1`, role: "assistant", content: `reply ${run}`, run_id: run });
  transport.running = null;
}

test("two back-to-back Runs the page did not start end with no live row and no active Run", async () => {
  const { transport, controller } = await open();
  for (const run of ["run_a", "run_b"]) {
    startSystemRun(transport, run);                       // run.created
    transport.emit(changed("user"));                      // message.created (sys:...)
    transport.emit(changed("claimed"));                   // run.state running
    saveReply(transport, run);
    transport.emit(changed("assistant"));                 // message.created assistant
    transport.emit(ended(run));                           // run.state completed
  }
  await flush();
  const state = controller.getState();
  assert.deepEqual(rows(controller), []);
  assert.equal(state.activeRun, null);
  assert.deepEqual(state.messages.map(message => message.id), ["run_a:1", "run_b:1"]);
});

test("a Run the page did not start is live while it runs and settles into its saved reply", async () => {
  const { transport, controller } = await open();
  startSystemRun(transport, "run_a");
  await flush();
  assert.equal(controller.getState().activeRun, "run_a");
  assert.equal(rows(controller).length, 1);
  saveReply(transport, "run_a");
  transport.emit(changed("assistant"));
  transport.emit(ended("run_a"));
  await flush();
  assert.deepEqual(rows(controller), []);
  assert.equal(controller.getState().activeRun, null);
});

test("a terminal event that arrives before the page adopted the Run is not undone by the snapshot that adopts it", async () => {
  const { transport, controller } = await open();
  transport.messages.push({ id: "run_a:1", role: "assistant", content: "reply run_a", run_id: "run_a" });
  transport.running = "run_a";
  transport.hold = true;                                   // the last look the stream asked for reads the Run still running, and its answer is slow
  transport.emit(changed("assistant"));
  await flush();
  transport.running = null;
  transport.emit(ended("run_a"));                          // nothing is adopted yet: the terminal names a Run the page does not hold
  await flush();
  transport.hold = false;
  for (const release of transport.held.splice(0)) release();
  await flush();
  assert.deepEqual(rows(controller), []);
  assert.equal(controller.getState().activeRun, null);
});

test("a terminal that settles one Run does not end the Run adopted behind it", async () => {
  const { transport, controller } = await open();
  startSystemRun(transport, "run_a");
  await flush();
  saveReply(transport, "run_a");
  transport.emit(changed("assistant"));
  transport.emit(ended("run_a"));
  startSystemRun(transport, "run_b");                      // run.created arrives while run_a's end is still being settled
  await flush();
  assert.equal(controller.getState().activeRun, "run_b");
  assert.equal(rows(controller).length, 1);
  saveReply(transport, "run_b");
  transport.emit(changed("assistant"));
  transport.emit(ended("run_b"));
  await flush();
  assert.deepEqual(rows(controller), []);
  assert.equal(controller.getState().activeRun, null);
});
