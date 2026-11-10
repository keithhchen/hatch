import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController } from "../src/application/conversation-controller.js";
import { AttachmentSource, ConversationTransport, RuntimeConnection, ToolExecutor } from "../src/ports/index.js";

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const tick = () => new Promise(resolve => setImmediate(resolve));

/** The POST of a send: its answer (the receipt that names the Run) is released by the test, whenever the server gets to it. */
class PostConnection extends RuntimeConnection {
  constructor(transport) { super(); this.transport = transport; }
  get ready() { return true; }
  close() {} hello() {} toolResult() {} cancel() {}
  send({ runId, clientMessageId }) {
    this.transport.sent = { runId, clientMessageId };
    return new Promise(resolve => { this.transport.answer = run => { this.transport.emit({ type: "message.accepted", run_id: run, client_message_id: clientMessageId, outcome: "started" }); resolve(); }; });
  }
}

/** Unit double of the Studio Assistant: the page lists only the Run in progress; the stream says what the journal recorded. */
class StudioDouble extends ConversationTransport {
  constructor() { super(); this.messages = []; this.running = null; }
  get steerable() { return true; }
  get journal() { return false; }
  get retriesRun() { return true; }
  list() { return Promise.resolve({ conversations: [{ id: "assistant" }] }); }
  snapshot() {
    const body = { conversation: { id: "assistant" }, messages: [...this.messages], cursor: 1, has_more: false, events: [],
      runs: this.running ? [{ id: this.running, status: "running" }] : [] };
    return new Promise(resolve => setImmediate(() => resolve(body)));   // a network read: other work happens meanwhile
  }
  history() { return Promise.resolve({ messages: [], has_more: false }); }
  run(_id, runId) { return Promise.resolve({ id: runId, status: "completed" }); }
  connect(_id, handlers) {
    this.emit = event => handlers.onEvent(event);
    this.handlers = handlers;
    return new PostConnection(this);
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
const rows = controller => controller.getState().messages.filter(message => message.transient);
const RUN = "run_eab00e";

/** The journal of a Run, created to completed: each step is what the server held when the event was told. */
const userRunSteps = transport => [
  () => { transport.running = RUN; transport.messages.push({ id: transport.sent.clientMessageId, role: "user", content: "hi" }); transport.emit(changed("claimed")); },
  () => transport.emit(changed("user")),
  () => transport.emit(changed("claimed")),
  () => { transport.messages.push({ id: `${RUN}:1`, role: "assistant", content: "ok", run_id: RUN }); transport.running = null; transport.emit(changed("assistant")); },
  () => transport.emit({ type: "turn.completed", run_id: RUN, finish_reason: "completed" })
];

// Every place the POST's answer can fall among the five journal events, with the stream arriving all at once or one at a time.
for (const together of [true, false]) {
  for (let answeredAfter = 0; answeredAfter <= 5; answeredAfter += 1) {
    test(`a Run the page started and the server ended at once leaves no live row (answer after event ${answeredAfter}, ${together ? "stream together" : "stream apart"})`, async () => {
      const { transport, controller } = await open();
      controller.setDraft("hi");
      const sending = controller.send();
      await tick();
      const steps = userRunSteps(transport);
      for (let at = 0; at <= steps.length; at += 1) {
        if (at === answeredAfter) transport.answer(RUN);
        if (at < steps.length) steps[at]();
        if (!together) await tick();
      }
      await sending;
      await flush();
      assert.deepEqual(rows(controller), []);
      assert.equal(controller.getState().activeRun, null);
      assert.deepEqual(controller.getState().messages.map(message => message.role), ["user", "assistant"]);
    });
  }
}

test("a system Run that is created, answered and completed within one instant leaves no live row", async () => {
  const { transport, controller } = await open();
  for (const run of ["run_42d89f", "run_42d8a0"]) {
    transport.running = run;
    transport.emit(changed("claimed"));
    transport.emit(changed("user"));
    transport.emit(changed("claimed"));
    transport.messages.push({ id: `${run}:1`, role: "assistant", content: "ok", run_id: run });
    transport.running = null;
    transport.emit(changed("assistant"));
    transport.emit({ type: "turn.completed", run_id: run, finish_reason: "completed" });
  }
  await flush();
  assert.deepEqual(rows(controller), []);
  assert.equal(controller.getState().activeRun, null);
});
