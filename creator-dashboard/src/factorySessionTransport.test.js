import assert from "node:assert/strict";
import test from "node:test";
import { FactoryConnection, FactorySessionTransport, messagesOf } from "./factorySessionTransport.js";
import { wireEventsOf } from "./studioAssistantTransport.js";

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

test("a session's messages are the shared chat's: one Run per user message, steps in order, each tool call with its result", () => {
  const messages = messagesOf(session, activityOf);
  assert.deepEqual(messages.map(message => [message.id, message.role, message.run_id]), [["u0", "user", "run_u0"], ["a1", "assistant", "run_u0"], ["a3", "assistant", "run_u0"]]);
  const reply = messages[1];
  assert.equal(reply.content, "Looking.");
  assert.deepEqual(reply.parts.map(part => part.type), ["thinking", "text", "tool_call"]);
  assert.deepEqual(reply.tool_calls.map(call => [call.name, call.status, call.result, call.activity_message]), [["read", "completed", "notes", "Working: read"]]);
});

test("the workbench's events are the wire events of the Run the page sent", () => {
  const transport = new FactorySessionTransport(async () => session, { root: "/r", id: "s1", activityOf, stream: () => ({ close() {} }) });
  transport.runId = "run_x";
  const connection = new FactoryConnection(transport, "s1", { onOpen() {}, onEvent() {}, onClose() {} });
  const kinds = events => events.map(event => event.type === "assistant.delta" ? event.delta.kind : event.type === "tool_call.delta" ? `tool:${event.status}` : event.type);
  assert.deepEqual(kinds(connection.wire({ type: "thinking" })), ["thinking_start"]);
  assert.deepEqual(kinds(connection.wire({ type: "delta", text: "hi" })), ["thinking_end", "text"]);
  assert.deepEqual(kinds(connection.wire({ type: "tool", name: "read" })), ["tool:requested"]);
  assert.deepEqual(kinds(connection.wire({ type: "tool_end", name: "read", isError: false })), ["tool:completed"]);
  assert.deepEqual(connection.wire({ type: "message_end" }).map(event => event.type), ["conversation.changed"]);
  assert.deepEqual(connection.wire({ type: "compacting" }), [{ type: "conversation.compaction", active: true }]);
  assert.equal(connection.wire({ type: "delta", text: "x" })[0].run_id, "run_x");
  connection.close();
});

test("the Assistant's compaction events lock and unlock the page, and its own user message names itself", () => {
  assert.deepEqual(wireEventsOf({ type: "compaction_start", compaction_id: "c" }), [{ type: "conversation.compaction", active: true }]);
  assert.deepEqual(wireEventsOf({ type: "compaction_end", compaction_id: "c", aborted: true }), [{ type: "conversation.compaction", active: false }]);
  assert.deepEqual(wireEventsOf({ type: "message", message_id: "m1" }), [{ type: "conversation.changed", committed: "user", message_id: "m1" }]);
});

test("a reload reads only the messages after the ones the page holds, and all of them when the server's copy changed", async () => {
  const urls = [];
  const replies = [
    { id: "s1", status: "running", messagesFrom: 0, messages: [{ role: "user", content: "a", timestamp: 1 }] },
    { id: "s1", status: "completed", messagesFrom: 1, messages: [{ role: "assistant", content: [{ type: "text", text: "b" }], timestamp: 2 }] },
    { id: "s1", status: "completed", messagesFrom: 0, messages: [{ role: "user", content: "fresh", timestamp: 9 }] }
  ];
  const transport = new FactorySessionTransport(async url => { urls.push(url); return replies.shift(); }, { root: "/r", id: "s1", activityOf, stream: () => ({ close() {} }) });
  await transport.reload();
  const session = await transport.reload();
  assert.deepEqual(urls, ["/r/sessions/s1", "/r/sessions/s1?after=1&tail=1"]);
  assert.deepEqual(session.messages.map(message => message.timestamp), [1, 2]);
  assert.equal(session.status, "completed");
  await transport.reload();
  assert.equal(urls[2], "/r/sessions/s1?after=2&tail=2");
  assert.deepEqual(transport.getSession().messages.map(message => message.timestamp), [9]);
});

const connect = () => {
  const transport = new FactorySessionTransport(async () => session, { root: "/r", id: "s1", activityOf, stream: () => ({ close() {} }) });
  transport.runId = "run_x";
  const requests = [];
  transport.request = async (path, init) => { requests.push([path, init?.method]); return {}; };
  return { transport, requests, connection: new FactoryConnection(transport, "s1", { onOpen() {}, onEvent() {}, onClose() {} }) };
};
const terminals = events => events.filter(event => event.type === "turn.completed" || event.type === "turn.failed");

test("a failed Run ends the page once, whichever of `error` and `run_end` comes first", () => {
  for (const order of [["error", "run_end"], ["run_end", "error"]]) {
    const { connection } = connect();
    const heard = order.flatMap(type => connection.wire(type === "error" ? { type, message: "boom" } : { type, status: "failed", error: { code: "x", message: "m" } }));
    assert.equal(terminals(heard).length, 1, order.join(" then "));
    connection.close();
  }
  const { connection } = connect();
  assert.equal(terminals(connection.wire({ type: "run_end", status: "failed" })).length, 1);
  connection.wire({ type: "delta", text: "next Run" });
  assert.equal(terminals(connection.wire({ type: "run_end", status: "completed" })).length, 1, "the next Run ends on its own");
  connection.close();
});

test("a Run a restart interrupted shows no stop and no error; the Expert's own Stop ends it quietly", () => {
  const { connection } = connect();
  const heard = connection.wire({ type: "run_end", status: "interrupted" });
  assert.deepEqual(terminals(heard), []);
  assert.deepEqual(heard.map(event => event.type), ["conversation.changed"], "a read says where the session is");
  const stopped = connect();
  stopped.connection.cancel();
  assert.deepEqual(terminals(stopped.connection.wire({ type: "run_end", status: "interrupted" })).map(event => event.error.code), ["run_cancelled"]);
  assert.equal(stopped.requests[0][0], "/r/sessions/s1/stop");
});

test("a reload mid-Run reads the text so far, and each live delta says where it sits so a gap or a replay joins exactly", async () => {
  const { transport, connection } = connect();
  transport.request = async () => ({ id: "s1", status: "running", partial: "Hello wor", messages: [{ role: "user", content: "hi", timestamp: 1 }] });
  const page = await transport.snapshot();
  assert.deepEqual(page.runs.map(run => [run.status, run.partial_output]), [["running", "Hello wor"]]);
  assert.equal(connection.wire({ type: "delta", text: "ld", offset: 9 })[0].delta.offset, 9);
  assert.equal("offset" in connection.wire({ type: "delta", text: "ld" })[0].delta, false, "a server that sends none is still read");
  transport.request = async () => ({ id: "s1", status: "completed", partial: "", messages: [] });
});
