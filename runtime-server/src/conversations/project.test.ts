import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ConversationError, page, publicEvent } from "./conversation.js";
import { projectMessages } from "./project.js";

const user = (text: string, extra: object = {}) => ({ role: "user", content: text, timestamp: 1000, ...extra }) as AgentMessage;
const assistant = (content: unknown[]) => ({ role: "assistant", content, timestamp: 2000, stopReason: "stop" }) as unknown as AgentMessage;
const text = (value: string) => ({ type: "text", text: value });
const toolResult = (details?: object) => ({ role: "toolResult", toolCallId: "c", toolName: "x", content: [text("secret tool output")], details, timestamp: 3000 }) as unknown as AgentMessage;

test("projection keeps what the user said and the final reply of each turn only", () => {
  const history = [
    user("Research Alice"),
    assistant([{ type: "thinking", thinking: "private reasoning" }, text("Let me search."), { type: "toolCall", id: "c", name: "web_search", arguments: {} }]),
    toolResult(),
    assistant([text("Here is what I found.")]),
    user("Now shorter", { origin: { kind: "expert", itemId: "item-2", text: "Now shorter" } }),
    user("context injected by the host", { origin: { kind: "system", itemId: "sys" } }),
    assistant([text("Short version.")]),
  ];
  const messages = projectMessages(history);
  assert.deepEqual(messages.map(m => [m.id, m.role, m.text]), [
    ["m1", "user", "Research Alice"],
    ["m4", "assistant", "Here is what I found."],
    ["item-2", "user", "Now shorter"],
    ["m7", "assistant", "Short version."],
  ]);
  assert.ok(!JSON.stringify(messages).match(/private reasoning|secret tool output|web_search|injected/));
});

test("steps of a running turn are never shown; the final reply appears once and keeps its id", () => {
  const history = [user("Go"), assistant([text("Working on it"), { type: "toolCall", id: "c", name: "write", arguments: {} }]), toolResult()];
  assert.deepEqual(projectMessages(history).map(m => m.role), ["user"]);
  const done = [...history, assistant([text("Done.")])];
  assert.deepEqual(projectMessages(done).map(m => m.id), ["m1", "m4"]);
  assert.deepEqual(projectMessages([...done, user("Again")]).map(m => m.id), ["m1", "m4", "m5"]);
});

test("questions the worker asked belong to its reply, even with no text beside them", () => {
  const ask = { type: "askuser", questions: [{ question: "Who is this for?", options: [{ content: "Creators" }, { content: "Buyers" }] }, { question: "Which channel?", options: [] }] };
  const withText = projectMessages([user("Start"), assistant([text("Two questions."), { type: "toolCall", id: "c", name: "askuser", arguments: {} }]), toolResult(ask)]);
  assert.equal(withText[1]!.text, "Two questions.\n\n1. Who is this for? (Creators / Buyers)\n2. Which channel?");
  const bare = projectMessages([user("Start"), assistant([{ type: "toolCall", id: "c", name: "askuser", arguments: {} }]), toolResult(ask)]);
  assert.equal(bare[1]!.text, "1. Who is this for? (Creators / Buyers)\n2. Which channel?");
  assert.equal(bare[1]!.id, "m2");
});

test("user images are listed by name and block content is read as text", () => {
  const [message] = projectMessages([user("", { content: [text("Look"), { type: "image", data: "hatch-file:input/a.png", mimeType: "image/png" }], origin: { kind: "expert", itemId: "i", text: "Look", images: ["input/a.png"] } })]);
  assert.deepEqual(message!.attachments, [{ type: "image", name: "a.png" }]);
  assert.equal(projectMessages([user("", { content: [text("Plain "), text("blocks")] })])[0]!.text, "Plain blocks");
  assert.equal(projectMessages([assistant([])]).length, 0);
});

test("page: latest messages without a cursor, the ones after it with one, unknown cursor rejected", () => {
  const all = ["a", "b", "c", "d", "e"].map(id => ({ id }));
  assert.deepEqual(page(all).map(m => m.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(page(all, undefined, 2).map(m => m.id), ["d", "e"]);
  assert.deepEqual(page(all, "b").map(m => m.id), ["c", "d", "e"]);
  assert.deepEqual(page(all, "b", 2).map(m => m.id), ["c", "d"]);
  assert.deepEqual(page(all, "e"), []);
  assert.throws(() => page(all, "zzz"), (error: unknown) => error instanceof ConversationError && error.status === 400 && error.code === "unknown_cursor");
});

test("public events drop internal ids and voice relays", () => {
  assert.deepEqual(publicEvent({ sessionId: "s", type: "delta", text: "hi" }), { type: "delta", text: "hi" });
  assert.deepEqual(publicEvent({ accountId: "a", type: "state" }), { type: "state" });
  assert.equal(publicEvent({ sessionId: "s", type: "voice.delta", text: "hi" }), undefined);
});
