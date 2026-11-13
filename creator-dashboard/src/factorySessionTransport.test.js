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
