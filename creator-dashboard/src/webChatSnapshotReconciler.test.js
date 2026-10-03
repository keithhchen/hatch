import assert from "node:assert/strict";
import test from "node:test";
import { WebChatSnapshotReconciler } from "./webChatSnapshotReconciler.js";

function message(overrides = {}) {
  return {
    id: "message-1",
    run_id: "run-1",
    role: "assistant",
    content: "answer",
    timestamp: "2026-10-03T00:00:00.000Z",
    parts: [{ type: "text", start: 0, end: 6 }],
    ...overrides
  };
}

test("an unchanged snapshot preserves the original array and message objects", () => {
  const reconciler = new WebChatSnapshotReconciler();
  const current = [message()];
  const first = reconciler.reconcile("conversation", current, { cursor: 10, messages: [message()] });
  const second = reconciler.reconcile("conversation", first.messages, { cursor: 10, messages: [message()] });

  assert.equal(second.accepted, true);
  assert.equal(second.messages, first.messages);
  assert.equal(second.messages[0], first.messages[0]);
});

test("a canonical snapshot promotes optimistic rows while retaining their DOM keys", () => {
  const reconciler = new WebChatSnapshotReconciler();
  const optimisticUser = {
    id: "optimistic-message",
    renderKey: "run-1-user",
    run_id: "run-1",
    role: "user",
    content: "question",
    timestamp: "2026-10-03T00:00:00.000Z",
    optimistic: false,
    provisional: true
  };
  const streamedAssistant = {
    id: "stream-run-1",
    renderKey: "run-1-assistant",
    run_id: "run-1",
    role: "assistant",
    content: "",
    timestamp: "2026-10-03T00:00:01.000Z",
    transient: true,
    timeline: [{ id: "text-1", kind: "text", content: "answer" }]
  };
  const result = reconciler.reconcile("conversation", [optimisticUser, streamedAssistant], {
    cursor: 20,
    messages: [
      message({ id: "server-user", role: "user", content: "question", parts: undefined }),
      message({ content: "answer", timestamp: "2026-10-03T00:00:02.000Z" })
    ]
  });

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].renderKey, optimisticUser.renderKey);
  assert.equal(result.messages[1].renderKey, streamedAssistant.renderKey);
  assert.equal(result.messages[1].transient, undefined);
  assert.equal(result.messages[1].content, "answer");
});

test("a page snapshot keeps older loaded rows and orders all rows by message time", () => {
  const reconciler = new WebChatSnapshotReconciler();
  const older = message({ id: "older", run_id: "run-old", content: "old", timestamp: "2026-10-02T00:00:00.000Z" });
  const current = message({ id: "current", run_id: "run-current", content: "current", timestamp: "2026-10-03T00:00:00.000Z" });
  const latest = message({ id: "latest", run_id: "run-latest", content: "latest", timestamp: "2026-10-04T00:00:00.000Z" });
  const result = reconciler.reconcile("conversation", [older, current], {
    cursor: 30,
    messages: [current, latest]
  });

  assert.deepEqual(result.messages.map(entry => entry.id), ["older", "current", "latest"]);
  assert.equal(result.messages[0], older);
});

test("a delayed snapshot cannot move the conversation projection behind its cursor", () => {
  const reconciler = new WebChatSnapshotReconciler();
  const initial = [message({ content: "new answer" })];
  const accepted = reconciler.reconcile("conversation", [], { cursor: 40, messages: initial });
  const stale = reconciler.reconcile("conversation", accepted.messages, { cursor: 39, messages: [message({ content: "old answer" })] });

  assert.equal(stale.accepted, false);
  assert.equal(stale.messages, accepted.messages);
  assert.equal(stale.messages[0].content, "new answer");
});

test("changed tool state patches the existing message while preserving its identity", () => {
  const reconciler = new WebChatSnapshotReconciler();
  const current = message({
    renderKey: "run-1-assistant",
    parts: [{ type: "tool_call", tool_call_id: "call-1" }],
    tool_calls: [{ tool_call_id: "call-1", status: "requested", arguments: { query: "docs" } }]
  });
  const result = reconciler.reconcile("conversation", [current], {
    cursor: 12,
    messages: [message({
      parts: [{ type: "tool_call", tool_call_id: "call-1" }],
      tool_calls: [{ tool_call_id: "call-1", status: "completed", arguments: { query: "docs" }, result: { matches: 2 } }]
    })]
  });

  assert.equal(result.messages.length, 1);
  assert.notEqual(result.messages[0], current);
  assert.equal(result.messages[0].renderKey, current.renderKey);
  assert.equal(result.messages[0].tool_calls[0].status, "completed");
});
