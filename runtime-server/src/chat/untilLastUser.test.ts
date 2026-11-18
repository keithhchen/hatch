import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationMessage } from "../protocol.js";
import { untilLastUser } from "./modelTurn.js";

const user = (content: string): ConversationMessage => ({ role: "user", content });
const call: ConversationMessage = { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }] };

test("the context ends with the latest user message: a partial reply, a tool call without a result, and a result are left out", () => {
  const history = [user("a"), { role: "assistant", content: "done" } as ConversationMessage, user("b"), call, { role: "assistant", content: "half" } as ConversationMessage];
  assert.deepEqual(untilLastUser(history), history.slice(0, 3));
  assert.deepEqual(untilLastUser([user("a"), call, { role: "tool", content: null, tool_call_id: "c", tool_name: "t", tool_content: [] } as ConversationMessage]), [user("a")]);
});

test("bad history never throws: nothing to trim when it already ends with a user message or has none; a compaction summary counts as the user message it is", () => {
  assert.deepEqual(untilLastUser([]), []);
  const onlyAssistant = [{ role: "assistant", content: "x" } as ConversationMessage];
  assert.deepEqual(untilLastUser(onlyAssistant), onlyAssistant);
  assert.deepEqual(untilLastUser([user("a")]), [user("a")]);
  const compacted = [user("<summary of earlier turns>"), { role: "assistant", content: "half" } as ConversationMessage];
  assert.deepEqual(untilLastUser(compacted), [user("<summary of earlier turns>")]);
});
