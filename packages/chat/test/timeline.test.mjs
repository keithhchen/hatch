import assert from "node:assert/strict";
import test from "node:test";
import { foldStepOnlyMessages, groupTimelineEntries, PendingSubmission, toolEntry } from "../src/domain/timeline.js";

test("Web Chat puts every thinking or tool block in its own activity modal group", () => {
  const thinking = { kind: "thinking", id: "thinking-1", title: "thinking", content: "Reviewing" };
  const tool = { kind: "tool", id: "tool-1", title: "web search", content: {}, status: "completed" };
  const laterThinking = { kind: "thinking", id: "thinking-2", title: "thinking", content: "Summarizing" };
  const text = { kind: "text", id: "text-1", content: "Result" };

  assert.deepEqual(groupTimelineEntries([thinking]), [
    { kind: "activity_group", id: "activity-group-thinking-1", entries: [thinking] }
  ]);
  assert.deepEqual(groupTimelineEntries([thinking, tool, text, laterThinking]), [
    { kind: "activity_group", id: "activity-group-thinking-1", entries: [thinking, tool] },
    text,
    { kind: "activity_group", id: "activity-group-thinking-2", entries: [laterThinking] }
  ]);
  assert.deepEqual(groupTimelineEntries([thinking, tool, laterThinking], entry => entry === tool), [
    { kind: "activity_group", id: "activity-group-thinking-1", entries: [thinking] },
    tool,
    { kind: "activity_group", id: "activity-group-thinking-2", entries: [laterThinking] }
  ]);
});

test("a tool entry keeps its key and never goes backwards", () => {
  const started = toolEntry({ run_id: "run", tool_call_id: "call", name: "web.search", status: "requested" });
  const done = toolEntry({ run_id: "run", tool_call_id: "call", status: "completed", result: { ok: true } }, started);
  const late = toolEntry({ run_id: "run", tool_call_id: "call", status: "running" }, done);
  assert.equal(started.id, "tool-call");
  assert.deepEqual([done.id, done.status, done.content.name, late.status], ["tool-call", "completed", "web.search", "completed"]);
});

test("Web Chat restores an optimistic submission payload from its submission record", () => {
  const submission = new PendingSubmission({
    conversationId: "conversation",
    runId: "run",
    clientMessageId: "message",
    content: "hello",
    attachments: [],
    files: []
  });

  assert.equal(submission.optimisticMessage().content, "hello");
  assert.equal(submission.optimisticMessage().id, "message");
  assert.equal(submission.optimisticMessage().optimistic, true);
});

test("replies of only steps are one steps row; text and the user break a run", () => {
  const entry = (kind, id) => ({ kind, id, content: kind === "text" ? "words" : {}, status: "completed" });
  const reply = (run, ...kinds) => ({ role: "assistant", run_id: run, timeline: kinds.map((kind, index) => entry(kind, `${run}-${index}`)) });
  const user = { role: "user", run_id: "u", content: "hi" };
  const rows = messages => foldStepOnlyMessages(messages).map(message => message.role === "user" ? "user" : groupTimelineEntries(message.timeline).map(item => item.kind).join("+"));
  assert.deepEqual(rows([user, reply("a", "tool"), reply("b", "tool"), reply("c", "tool", "text")]), ["user", "activity_group+text"], "one steps row, then the answer");
  assert.deepEqual(rows([reply("a", "text", "tool"), reply("b", "tool")]), ["text+activity_group"], "the steps after the text and the next reply's steps are one row");
  assert.deepEqual(rows([reply("t", "text"), reply("b", "tool")]), ["text", "activity_group"], "text ends a stretch: nothing to join");
  assert.deepEqual(rows([reply("a", "tool"), user, reply("b", "tool")]), ["activity_group", "user", "activity_group"], "the user breaks it");
});
