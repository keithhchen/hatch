import assert from "node:assert/strict";
import test from "node:test";
import { convertToLlm, serializeConversation, type AgentMessage } from "@earendil-works/pi-agent-core";
import { forSummary } from "./piCompaction.js";

const record = (n: number, text: string): AgentMessage => ({
  role: "toolResult", toolCallId: `call_${n}`, toolName: "read_file", content: [{ type: "text", text }], isError: false, timestamp: n
} as AgentMessage);

test("the summarizer reads a tool result whole: a fact at the end of a long file reaches the summary", () => {
  const long = `${"essay paragraph ".repeat(1_000)}GPA 3.92, TOEFL 108`;
  const text = serializeConversation(convertToLlm(forSummary([record(1, long)], 1_000_000)));
  assert.ok(text.includes("GPA 3.92, TOEFL 108"), "the end of the file is there");
  assert.ok(text.includes("[Tool result: read_file]"), "it says what it is");
  // Pi's own path keeps 2,000 characters: the fact is lost.
  assert.ok(!serializeConversation(convertToLlm([record(1, long)])).includes("GPA 3.92"));
});

test("when the messages would not fit the summary model, every result is shortened by the same share and says so", () => {
  const messages = [record(1, "a".repeat(40_000)), record(2, "b".repeat(40_000))];
  const text = serializeConversation(convertToLlm(forSummary(messages, 5_000)));
  const kept = (letter: string) => text.match(new RegExp(`${letter}{100,}`))![0].length;
  assert.ok(kept("a") < 40_000 && kept("a") === kept("b"), `kept ${kept("a")} and ${kept("b")}`);
  assert.ok(text.length < 25_000, `${text.length} characters`);
  assert.match(text, /more characters left out to fit the summary/);
});

test("other messages pass through unchanged", () => {
  const user = { role: "user", content: "write the report", timestamp: 1 } as AgentMessage;
  assert.equal(forSummary([user], 10)[0], user);
});

test("a fixed budget never goes past what the model's window allows", async () => {
  const { withinWindow } = await import("./compaction.js");
  const { policyFor } = await import("./compactionStrategy.js");
  const report = { trigger: 750_000, prune: 600_000, tail: 80_000, hard: 950_000 };
  const small = withinWindow(policyFor(262_144), report);
  assert.ok(small.trigger < 262_144 && small.hard < 262_144 && small.prune < 262_144, JSON.stringify(small));
  assert.deepEqual(withinWindow(policyFor(1_048_576), report), { ...policyFor(1_048_576), ...report });
});
