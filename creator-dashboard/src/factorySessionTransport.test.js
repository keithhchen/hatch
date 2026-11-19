import assert from "node:assert/strict";
import test from "node:test";
import { ConversationController, projectLog, emptyLog, foldLogEvents } from "@hatch/chat";
import { FactoryConnection, FactorySessionTransport, eventsOf } from "./factorySessionTransport.js";

const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const activityOf = name => `Working: ${name}`;
const session = {
  id: "s1", status: "completed", turn: 1,
  messages: [
    { role: "user", content: "read my notes" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "input/a.md" } }] },
    { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "notes" }] },
    { role: "assistant", content: [{ type: "text", text: "Done." }] }
  ]
};
const quietStream = () => ({ close() {} });

test("a session's messages are the log's events: one Run per user message, steps in order, each tool call with its result, positions in order", () => {
  const events = eventsOf(session, activityOf);
  assert.deepEqual(events.map(event => [event.position, event.type]), [[1, "user.message"], [2, "assistant.thinking"], [3, "assistant.text"], [4, "tool.call"], [5, "assistant.text"], [6, "run.state"]]);
  assert.deepEqual(events.map(event => event.run_id), Array(6).fill("run_u0"));
  const tool = events[3];
  assert.deepEqual([tool.name, tool.status, tool.result, tool.activity_message], ["read", "completed", "notes", "Working: read"]);
  const messages = projectLog(foldLogEvents(emptyLog(), events)).messages;
  assert.deepEqual(messages.map(message => message.role), ["user", "assistant"]);
  assert.deepEqual(messages[1].timeline.map(entry => entry.kind), ["thinking", "text", "tool", "text"]);
  assert.equal(messages[1].content, "Looking.\n\nDone.");
});

test("a running session's Run has no end and holds the text so far; a failed one says why", () => {
  const running = eventsOf({ ...session, status: "running", partial: "Hello wor", messages: [session.messages[0]] }, activityOf);
  assert.deepEqual(running.slice(-2).map(event => [event.type, event.status ?? event.content]), [["run.state", "running"], ["assistant.text", "Hello wor"]]);
  const failed = eventsOf({ ...session, status: "failed", error: "boom", errorCode: "upstream" }, activityOf);
  assert.deepEqual(failed.at(-1), { position: failed.length, type: "run.state", run_id: "run_u0", status: "failed", failure: { code: "upstream", message: "boom" } });
});

const connect = () => {
  const transport = new FactorySessionTransport(async () => session, { root: "/r", id: "s1", activityOf, stream: quietStream });
  transport.runId = "run_x";
  const requests = [];
  transport.request = async (path, init) => { requests.push([path, init?.method]); return { ...session, messages: [] }; };
  const frames = [];
  return { transport, requests, frames, connection: new FactoryConnection(transport, "s1", { onOpen() {}, onEvent: frame => frames.push(frame), onClose() {} }) };
};
const types = events => events.map(event => event.type === "assistant.thinking" ? `thinking:${event.phase}` : event.type === "tool.call" ? `tool:${event.status}` : event.type === "run.state" ? `state:${event.status}` : event.type);
const terminals = events => events.filter(event => event.type === "run.state" && event.status !== "running");

test("the workbench's events are the public events of the Run the page sent: a Run is going from its first word, steps keep their call ids", () => {
  const { connection } = connect();
  assert.deepEqual(types(connection.wire({ type: "thinking" })), ["state:running", "thinking:start"]);
  assert.deepEqual(types(connection.wire({ type: "delta", text: "hi" })), ["thinking:end", "assistant.text"]);
  assert.deepEqual(types(connection.wire({ type: "tool", name: "read" })), ["tool:requested"]);
  const [done] = connection.wire({ type: "tool_end", name: "read", isError: false });
  assert.deepEqual([done.status, done.tool_call_id], ["completed", "live-1"]);
  assert.deepEqual(connection.wire({ type: "compacting" }).map(event => event.type), ["compaction.started"]);
  assert.deepEqual(connection.wire({ type: "compacted" }).map(event => event.type), ["compaction.ended"]);
  assert.equal(connection.wire({ type: "delta", text: "x" })[0].run_id, "run_x");
  connection.close();
});

test("a failed Run ends the page once, whichever of `error` and `run_end` comes first; the next Run ends on its own", () => {
  for (const order of [["error", "run_end"], ["run_end", "error"]]) {
    const { connection } = connect();
    const heard = order.flatMap(type => connection.wire(type === "error" ? { type, message: "boom" } : { type, status: "failed", error: { code: "x", message: "m" } }));
    assert.equal(terminals(heard).length, 1, order.join(" then "));
    assert.equal(terminals(heard)[0].status, "failed");
    connection.close();
  }
  const { connection } = connect();
  assert.equal(terminals(connection.wire({ type: "run_end", status: "failed" })).length, 1);
  connection.wire({ type: "delta", text: "next Run" });
  assert.equal(terminals(connection.wire({ type: "run_end", status: "completed" })).length, 1);
});

test("a Run a restart interrupted, or the user stopped, ends with that status and no failure", () => {
  const { connection } = connect();
  const [interrupted] = terminals(connection.wire({ type: "run_end", status: "interrupted" }));
  assert.deepEqual([interrupted.status, interrupted.failure], ["interrupted", undefined]);
  assert.equal(terminals(connect().connection.wire({ type: "run_end", status: "cancelled" }))[0].status, "cancelled");
});

test("a reload reads the session whole; a later session of the stream (a gap) reads it whole again, by a reset", async () => {
  const { transport, connection, frames } = connect();
  transport.request = async () => ({ id: "s1", status: "running", partial: "Hello wor", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  const page = await transport.log("s1", { turns: 20 });
  assert.deepEqual(page.events.slice(-2).map(event => [event.type, event.content ?? event.status]), [["run.state", "running"], ["assistant.text", "Hello wor"]]);
  assert.equal(page.head, page.events.length);
  assert.deepEqual(await transport.log("s1", { after: page.head }), { events: [], head: page.head, has_more: false });
  connection.deliver({ type: "assistant.text", run_id: transport.runId, content: "ld" });
  assert.equal(frames.at(-1).event.position, page.head + 1, "the stream goes on from where the read ended");
  connection.hello([], page.head);
  assert.deepEqual(frames.map(frame => frame.type), ["log.event", "session.ready"], "the first session of a read just starts");
  connection.hello([], page.head + 1);
  assert.equal(frames.at(-1).type, "log.reset");
  await transport.log("s1", { turns: 20 });
  connection.hello([], 1);
  assert.equal(frames.at(-1).type, "session.ready", "a fresh read starts again");
});

test("a reload reads only the messages after the ones the page holds, and all of them when the server's copy changed", async () => {
  const urls = [];
  const replies = [
    { id: "s1", status: "running", messagesFrom: 0, messages: [{ role: "user", content: "a", timestamp: 1 }] },
    { id: "s1", status: "completed", messagesFrom: 1, messages: [{ role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 2 }] },
    { id: "s1", status: "completed", messagesFrom: 0, messages: [{ role: "user", content: "fresh", timestamp: 9 }] }
  ];
  const transport = new FactorySessionTransport(async url => { urls.push(url); return replies.shift(); }, { root: "/r", id: "s1", activityOf, stream: quietStream });
  await transport.reload();
  const read = await transport.reload();
  assert.deepEqual(urls, ["/r/sessions/s1", "/r/sessions/s1?after=1&tail=1"]);
  assert.deepEqual(read.messages.map(message => message.timestamp), [1, 2]);
  assert.equal(read.status, "completed");
  await transport.reload();
  assert.equal(urls[2], "/r/sessions/s1?after=2&tail=2");
  assert.deepEqual(transport.getSession().messages.map(message => message.timestamp), [9]);
});

class FakeSource {
  constructor() { FakeSource.last = this; setImmediate(() => this.onopen?.()); }
  emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  close() {}
}

test("a message sent in the workbench chat: optimistic, then the log's from the stream, one Run until it ends, and the composer free again", async () => {
  const requests = [];
  const transport = new FactorySessionTransport(async (path, init) => { requests.push([init?.method ?? "GET", path]); return { id: "s1", status: "idle", messages: [], files: [] }; }, { root: "/r", id: "s1", activityOf, stream: () => new FakeSource() });
  const controller = new ConversationController({ transport, attachments: { limit: 0, accepts: () => false, prepareAll: async () => [] }, tools: { localTools: [], prepareRun: async () => {}, cancel() {} }, pollMs: 60_000, reconnectAttempts: 0 });
  controller.open("s1");
  await flush();
  assert.equal(controller.state.connection, "open");
  controller.setDraft("write the plan");
  await controller.send();
  await flush();
  const rows = () => controller.state.messages.map(message => message.role === "user" ? `user:${message.content}` : `assistant:${message.content}${message.transient ? "*" : ""}`);
  assert.deepEqual(rows(), ["user:write the plan", "assistant:*"]);
  assert.ok(requests.some(([method, path]) => method === "POST" && path === "/r/sessions/s1/message"));
  assert.equal(controller.state.draft, "");
  const stream = FakeSource.last;
  stream.emit({ type: "message" });
  stream.emit({ type: "delta", text: "Drafting" });
  stream.emit({ type: "tool", name: "write" });
  stream.emit({ type: "tool_end", name: "write", isError: false });
  stream.emit({ type: "delta", text: "Done." });
  assert.deepEqual(rows(), ["user:write the plan", "assistant:Drafting\n\nDone.*"]);
  assert.equal(controller.state.activeRun !== null, true);
  stream.emit({ type: "message_end" });
  stream.emit({ type: "run_end", status: "completed" });
  assert.equal(controller.state.activeRun, null);
  assert.deepEqual(rows(), ["user:write the plan", "assistant:Drafting\n\nDone."]);
  assert.equal(controller.state.error, null);
  controller.dispose();
});

test("a failed Run in the workbench chat is an error once, and the composer is free", async () => {
  const transport = new FactorySessionTransport(async () => ({ id: "s1", status: "idle", messages: [], files: [] }), { root: "/r", id: "s1", activityOf, stream: () => new FakeSource() });
  const controller = new ConversationController({ transport, attachments: { limit: 0, accepts: () => false, prepareAll: async () => [] }, tools: { localTools: [], prepareRun: async () => {}, cancel() {} }, pollMs: 60_000, reconnectAttempts: 0, describeError: error => error.message });
  controller.open("s1");
  await flush();
  controller.setDraft("go");
  await controller.send();
  await flush();
  const stream = FakeSource.last;
  stream.emit({ type: "message" });
  stream.emit({ type: "error", message: "boom" });
  stream.emit({ type: "run_end", status: "failed", error: { code: "x", message: "m" } });
  assert.equal(controller.state.activeRun, null);
  assert.equal(controller.state.error.message, "boom");
  assert.deepEqual(controller.state.failedRun?.id !== undefined, true);
  controller.dispose();
});
