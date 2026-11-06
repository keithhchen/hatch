import assert from "node:assert/strict";
import test from "node:test";
import { latestThinkingText } from "../src/domain/activity.js";

test("thinking preview follows the latest text and stays within fifty grapheme characters", () => {
  assert.equal(latestThinkingText("前面的 thinking 文本 abcdefghijklmnopqrstu"), "前面的 thinking 文本 abcdefghijklmnopqrstu");
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(latestThinkingText("123456789012345678901"))].length, 21);
  assert.equal([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(latestThinkingText("x".repeat(60)))].length, 50);
});

test("thinking preview does not split grapheme characters and normalizes whitespace", () => {
  assert.equal(latestThinkingText("  先思考\n👩‍💻正在规划  "), "先思考 👩‍💻正在规划");
});

test("thinking preview rejects invalid character limits", () => {
  assert.throws(() => latestThinkingText("thinking", 1), RangeError);
});

test("approval state comes from this client's decision, else a recorded denial", async () => {
  const { approvalDecision } = await import("../src/domain/activity.js");
  const tool = (toolCallId, error) => ({ kind: "tool", content: { toolCallId, error } });
  assert.equal(approvalDecision(tool("a"), { a: "pending" }), "pending");
  assert.equal(approvalDecision(tool("b", { code: "approval_denied" })), "denied");
  assert.equal(approvalDecision(tool("c", { code: "browser_approval_unavailable" })), null);
  assert.equal(approvalDecision({ kind: "thinking", content: "x" }, { a: "allowed" }), null);
});
