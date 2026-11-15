import assert from "node:assert/strict";
import test from "node:test";
import { messagesFrom, publicSession } from "./server.js";

const messages = [{ role: "user", timestamp: 1 }, { role: "assistant", timestamp: 2 }, { role: "user", timestamp: 3 }] as never;
const from = (query: string) => messagesFrom(messages, new URLSearchParams(query));

test("a read starts after the messages the client holds when its last one still matches", () => {
  assert.equal(from("after=2&tail=2"), 2);
  assert.equal(from("after=3&tail=3"), 3, "nothing new: an empty page");
});

test("a read starts from the start when the client holds nothing or its copy no longer matches", () => {
  assert.equal(from(""), 0);
  assert.equal(from("after=2&tail=9"), 0, "history was rewritten under it");
  assert.equal(from("after=5&tail=3"), 0, "it holds more than the server has");
  assert.equal(from("after=-1&tail=1"), 0);
});

test("the session the page reads carries none of the models' working context", () => {
  const shown = publicSession({ id: "s", context: [1], scribeContext: [2], messageKeys: [], queue: [], messages: [] } as never);
  assert.deepEqual(Object.keys(shown).sort(), ["id", "messages"]);
});
