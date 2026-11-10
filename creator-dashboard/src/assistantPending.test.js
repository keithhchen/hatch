import assert from "node:assert/strict";
import test from "node:test";
import { MessageKeys, unsaved } from "./assistantPending.js";

test("a retry of the same words is sent under the same id, and the next message under a new one", () => {
  let count = 0;
  const keys = new MessageKeys(() => `key-${++count}`);
  const first = keys.keyFor("他对我的影响很大");
  assert.equal(keys.keyFor("他对我的影响很大"), first, "a retry after a failed send is one message");
  keys.sent();
  assert.notEqual(keys.keyFor("他对我的影响很大"), first, "saying it again later is a new message");
  assert.notEqual(keys.keyFor("别的话"), "key-2");
});

test("a line stays on the page until the saved history holds its id", () => {
  const lines = [{ id: "a", text: "一" }, { id: "b", text: "二" }];
  assert.deepEqual(unsaved(lines, [{ id: "x" }]).map(line => line.id), ["a", "b"], "a message waiting for the reply to take it up is not lost");
  assert.deepEqual(unsaved(lines, [{ id: "a" }, { id: "x" }]).map(line => line.id), ["b"]);
  assert.deepEqual(unsaved(lines, [{ id: "a" }, { id: "b" }]), []);
});
