import assert from "node:assert/strict";
import test from "node:test";
import { groupTimelineEntries, PendingWebSubmission, WebChatTimeline } from "./webChatTimeline.js";

test("Web Chat timeline keeps text, thinking, and tool activity in event order", () => {
  const timeline = new WebChatTimeline();
  timeline.appendText("A");
  timeline.appendText("B");
  timeline.updateThinking("正在查找资料");
  timeline.upsertTool({ type: "tool_call.delta", run_id: "run", tool_call_id: "call", name: "web_search", status: "requested" });
  timeline.updateThinking("正在整理结果");
  timeline.appendText("C");

  assert.deepEqual(timeline.snapshot().map(({ kind, content, status }) => ({ kind, content, status })), [
    { kind: "text", content: "AB", status: undefined },
    { kind: "thinking", content: "正在查找资料", status: undefined },
    { kind: "tool", content: undefined, status: "requested" },
    { kind: "thinking", content: "正在整理结果", status: undefined },
    { kind: "text", content: "C", status: undefined }
  ]);
});

test("Web Chat creates a stable assistant projection before either run type streams", () => {
  assert.deepEqual(WebChatTimeline.streamingAssistantMessage("run-1", "2026-10-03T00:00:00.000Z"), {
    id: "stream-run-1",
    renderKey: "run-1-assistant",
    run_id: "run-1",
    role: "assistant",
    content: "",
    timestamp: "2026-10-03T00:00:00.000Z",
    transient: true,
    timeline: []
  });
});

test("Web Chat tool updates replace the existing timeline item in place", () => {
  const timeline = new WebChatTimeline();
  timeline.updateThinking("准备调用");
  timeline.upsertTool({ type: "tool_call.delta", run_id: "run", tool_call_id: "call", name: "file_search", status: "requested", arguments: { query: "docs" } });
  timeline.updateThinking("等待结果");
  timeline.upsertTool({ type: "tool_call.delta", run_id: "run", tool_call_id: "call", name: "file_search", status: "completed", result: { matches: ["a", "b"] } });

  assert.deepEqual(timeline.snapshot().map(entry => entry.kind), ["thinking", "tool", "thinking"]);
  assert.equal(timeline.snapshot()[1].status, "completed");
  assert.deepEqual(timeline.snapshot()[1].arguments, { query: "docs" });
  assert.deepEqual(timeline.snapshot()[1].result, { matches: ["a", "b"] });
});

test("Web Chat does not duplicate terminal tool events as thinking entries", () => {
  const timeline = new WebChatTimeline();
  timeline.upsertTool({ run_id: "run", tool_call_id: "call", name: "web.search", status: "completed" });
  timeline.updateRuntimeStatus("Tool web.search completed.");

  assert.deepEqual(timeline.snapshot().map(entry => [entry.kind, entry.status]), [["tool", "completed"]]);
});

test("Web Chat does not duplicate tool-start events as thinking entries", () => {
  const timeline = new WebChatTimeline();
  timeline.upsertTool({ run_id: "run", tool_call_id: "call", name: "web.search", status: "requested" });
  timeline.updateRuntimeStatus("Calling tool web.search.");

  assert.deepEqual(timeline.snapshot().map(entry => [entry.kind, entry.status]), [["tool", "requested"]]);
});

test("Web Chat suppresses the compatibility thinking status when typed thinking events are available", () => {
  const timeline = new WebChatTimeline();
  timeline.upsertTool({ run_id: "run", tool_call_id: "call", name: "web.search", status: "completed" });
  timeline.updateRuntimeStatus("Thinking through the product.");

  assert.deepEqual(timeline.snapshot().map(entry => entry.kind), ["tool"]);
});

test("Web Chat thinking deltas update one indexed block and history restores its final content", () => {
  const timeline = new WebChatTimeline();
  timeline.startThinking(4);
  const thinkingId = timeline.snapshot()[0].id;
  timeline.appendThinking(4, "first ");
  timeline.appendThinking(4, "second");
  timeline.finishThinking(4, "first second");

  assert.deepEqual(timeline.snapshot(), [{
    kind: "thinking",
    id: thinkingId,
    contentIndex: 4,
    content: "first second",
    streaming: false
  }]);
  assert.deepEqual(WebChatTimeline.fromHistory({
    run_id: "run",
    role: "assistant",
    content: "Done",
    parts: [
      { type: "thinking", contentIndex: 4, content: "first second" },
      { type: "text", start: 0, end: 4 }
    ]
  }).map(({ kind, contentIndex, content }) => ({ kind, contentIndex, content })), [
    { kind: "thinking", contentIndex: 4, content: "first second" },
    { kind: "text", contentIndex: undefined, content: "Done" }
  ]);
});

test("Web Chat groups only consecutive thinking and tool blocks when a run has multiple blocks", () => {
  const thinking = { kind: "thinking", id: "thinking-1", content: "Reviewing" };
  const tool = { kind: "tool", id: "tool-1", status: "completed" };
  const laterThinking = { kind: "thinking", id: "thinking-2", content: "Summarizing" };
  const text = { kind: "text", id: "text-1", content: "Result" };

  assert.deepEqual(groupTimelineEntries([thinking]), [thinking]);
  assert.deepEqual(groupTimelineEntries([thinking, tool, text, laterThinking]), [
    { kind: "activity_group", id: "activity-group-thinking-1", entries: [thinking, tool] },
    text,
    laterThinking
  ]);
});

test("Web Chat keeps a streamed tool card key when the final snapshot rebuilds its timeline", () => {
  const timeline = new WebChatTimeline();
  timeline.upsertTool({ run_id: "run", tool_call_id: "call", name: "web.search", status: "requested" });
  const streamedToolKey = timeline.snapshot()[0].id;
  timeline.upsertTool({ run_id: "run", tool_call_id: "call", name: "web.search", status: "completed" });
  timeline.updateRuntimeStatus("Tool web.search completed.");

  const canonical = WebChatTimeline.fromHistory({
    run_id: "run",
    role: "assistant",
    content: "Done.",
    parts: [{ type: "tool_call", tool_call_id: "call" }, { type: "text", start: 0, end: 5 }],
    tool_calls: [{ run_id: "run", tool_call_id: "call", name: "web.search", status: "completed" }]
  });

  assert.equal(streamedToolKey, "tool-call");
  assert.equal(canonical.find(entry => entry.kind === "tool").id, streamedToolKey);
});

test("Web Chat restores an optimistic submission payload from its submission record", () => {
  const submission = new PendingWebSubmission({
    conversationId: "conversation",
    runId: "run",
    clientMessageId: "message",
    content: "hello",
    attachments: [],
    imageFiles: []
  });

  assert.equal(submission.optimisticMessage().content, "hello");
  assert.equal(submission.optimisticMessage().id, "optimistic-message");
  assert.equal(submission.optimisticMessage().optimistic, true);
});

test("Web Chat history preserves the stored text and tool-call order", () => {
  const timeline = WebChatTimeline.fromHistory({
    run_id: "run",
    role: "assistant",
    content: "beforeafter",
    parts: [
      { type: "text", start: 0, end: 6 },
      { type: "tool_call", tool_call_id: "call" },
      { type: "text", start: 6, end: 11 }
    ],
    tool_calls: [{ run_id: "run", tool_call_id: "call", name: "web_search", status: "completed", arguments: {}, result: { matches: [] } }]
  });

  assert.deepEqual(timeline.map(entry => entry.kind), ["text", "tool", "text"]);
  assert.equal(timeline[0].content, "before");
  assert.equal(timeline[2].content, "after");
});
