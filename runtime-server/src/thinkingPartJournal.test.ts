import assert from "node:assert/strict";
import test from "node:test";
import { ThinkingPartJournal } from "./thinkingPartJournal.js";
import type { VisibleConversationPart } from "./store.js";

test("thinking parts retain Pi content indexes, arrival order and final text", () => {
  const parts: VisibleConversationPart[] = [];
  const journal = new ThinkingPartJournal(parts);

  journal.accept({ kind: "thinking_start", contentIndex: 3 });
  journal.accept({ kind: "thinking_start", contentIndex: 8 });
  journal.accept({ kind: "thinking_delta", contentIndex: 3, delta: "first " });
  journal.accept({ kind: "thinking_delta", contentIndex: 8, delta: "second" });
  journal.accept({ kind: "thinking_end", contentIndex: 3, content: "first thought" });
  journal.accept({ kind: "thinking_end", contentIndex: 8, content: "second thought" });

  assert.deepEqual(parts, [
    { type: "thinking", contentIndex: 3, content: "first thought" },
    { type: "thinking", contentIndex: 8, content: "second thought" }
  ]);
});

test("thinking journal rejects malformed Pi lifecycle order", () => {
  const journal = new ThinkingPartJournal([]);

  assert.throws(
    () => journal.accept({ kind: "thinking_delta", contentIndex: 3, delta: "before start" }),
    /Thinking event arrived before start for content index 3/
  );
  journal.accept({ kind: "thinking_start", contentIndex: 3 });
  assert.throws(
    () => journal.accept({ kind: "thinking_start", contentIndex: 3 }),
    /Thinking content index 3 started more than once/
  );
});
