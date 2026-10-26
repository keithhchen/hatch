import assert from "node:assert/strict";
import test from "node:test";
import { ChatTimeline, groupTimelineEntries } from "../src/domain/timeline.js";
import { RuntimeEventReducer } from "../src/domain/runtime-events.js";
import { creatorInitials, refineCreatorIdentity, resolveCreatorIdentity } from "../src/domain/creator-identity.js";

const reducer = new RuntimeEventReducer();
const delta = (kind, fields) => ({ type: "assistant.delta", run_id: "run", delta: { kind, ...fields } });

test("text deltas are returned for the reveal policy, never applied directly", () => {
  const timeline = new ChatTimeline();
  const outcome = reducer.reduce(timeline, delta("text", { content: "Hi" }), "run");
  assert.equal(outcome.kind, "text");
  assert.equal(outcome.content, "Hi");
  assert.deepEqual(timeline.snapshot(), []);
});

test("run events for another run are ignored; session events are not run-gated", () => {
  const timeline = new ChatTimeline();
  assert.equal(reducer.reduce(timeline, { type: "tool_call.delta", run_id: "other", tool_call_id: "c" }, "run").kind, "ignored");
  assert.equal(reducer.reduce(timeline, { type: "tool_call.delta", run_id: "run", tool_call_id: "c" }, null).kind, "ignored");
  assert.equal(reducer.reduce(timeline, { type: "session.error", error: { code: "x" } }, null).kind, "session_error");
  assert.equal(reducer.reduce(timeline, { type: "session.ready", conversation_id: "conv" }, null).kind, "ready");
  assert.equal(reducer.reduce(timeline, { type: "session.compacted" }, null).kind, "compacted");
});

test("thinking, tools, skills and skill runs land in one ordered activity group", () => {
  const timeline = new ChatTimeline();
  reducer.reduce(timeline, delta("thinking_start", { contentIndex: 0 }), "run");
  reducer.reduce(timeline, delta("thinking_delta", { contentIndex: 0, delta: "plan" }), "run");
  reducer.reduce(timeline, delta("thinking_end", { contentIndex: 0, content: "plan" }), "run");
  reducer.reduce(timeline, { type: "skill.activated", run_id: "run", name: "brief", status: "activated", path: "skills/brief", reason: "match" }, "run");
  reducer.reduce(timeline, { type: "skill.run", run_id: "run", skill_run_id: "sr1", name: "brief", status: "running" }, "run");
  reducer.reduce(timeline, { type: "skill.run", run_id: "run", skill_run_id: "sr1", name: "brief", status: "completed" }, "run");
  reducer.reduce(timeline, { type: "tool_call.delta", run_id: "run", tool_call_id: "c", name: "web_search", status: "completed" }, "run");
  const kinds = timeline.snapshot().map(entry => [entry.kind, entry.status ?? null]);
  assert.deepEqual(kinds, [["thinking", null], ["skill", "activated"], ["skill_run", "completed"], ["tool", "completed"]]);
  assert.equal(groupTimelineEntries(timeline.snapshot()).length, 1);
});

test("redundant tool status deltas are ignored; other status updates the timeline", () => {
  const timeline = new ChatTimeline();
  assert.equal(reducer.reduce(timeline, delta("status", { content: "Calling tool web.search." }), "run").kind, "ignored");
  const outcome = reducer.reduce(timeline, delta("status", { content: "Reading sources" }), "run");
  assert.deepEqual(outcome.status, { text: "Reading sources" });
  assert.equal(timeline.snapshot()[0].kind, "status");
});

test("approvals project onto their tool; denials carry the Runtime reason", () => {
  const timeline = new ChatTimeline();
  const request = { type: "approval.request", run_id: "run", tool_call_id: "c", name: "file_write", arguments: { path: "a" } };
  assert.equal(reducer.reduce(timeline, request, "run").kind, "approval_request");
  assert.equal(timeline.snapshot()[0].content.approval, "ask");
  reducer.reduce(timeline, { ...request, type: "approval.result", status: "denied", reason: "No" }, "run");
  assert.equal(timeline.snapshot()[0].status, "failed");
  assert.deepEqual(timeline.snapshot()[0].content.error, { message: "No" });
});

test("terminal, accepted, tool request and turn state outcomes are classified", () => {
  const timeline = new ChatTimeline();
  assert.deepEqual(reducer.reduce(timeline, { type: "turn.failed", run_id: "run", error: { message: "x" } }, "run"), { kind: "terminal", failed: true, error: { message: "x" } });
  assert.equal(reducer.reduce(timeline, { type: "turn.completed", run_id: "run", finish_reason: "stop" }, "run").finishReason, "stop");
  assert.equal(reducer.reduce(timeline, { type: "message.accepted", run_id: "run" }, "run").kind, "accepted");
  assert.equal(reducer.reduce(timeline, { type: "tool_call.request", run_id: "run", tool_call_id: "c" }, "run").kind, "tool_request");
  assert.equal(reducer.reduce(timeline, { type: "turn.state", run_id: "run", status: "waiting_for_tool" }, "run").state, "waiting_for_tool");
});

test("history projects skill runs and skill events with the same keys as the live stream", () => {
  const live = new ChatTimeline();
  live.upsertSkillRun({ run_id: "run", skill_run_id: "sr1", name: "brief", status: "completed" });
  live.upsertSkill({ run_id: "run", name: "brief", status: "invoked", path: "p", reason: "r", source_tool_call_id: "c" });
  const history = ChatTimeline.fromHistory({
    run_id: "run", role: "assistant", content: "",
    parts: [{ type: "skill_run", skill_run_id: "sr1" }, { type: "skill_event", name: "brief", status: "invoked", reason: "r", source_tool_call_id: "c" }],
    skill_runs: [{ skill_run_id: "sr1", name: "brief", status: "completed" }],
    skill_events: [{ name: "brief", status: "invoked", reason: "r", path: "p", source_tool_call_id: "c" }]
  });
  assert.deepEqual(history.map(entry => entry.id), live.snapshot().map(entry => entry.id));
});

test("creator identity unions the Web and Desktop fallback chains", () => {
  assert.deepEqual(
    (({ productName, creatorName, creatorAvatarUrl }) => ({ productName, creatorName, creatorAvatarUrl }))(resolveCreatorIdentity({})),
    { productName: "Expert Agent", creatorName: "Hatch Expert", creatorAvatarUrl: null });
  const access = { product: { name: "Tutor", brief_spec: { fields: [] } }, creator: { display_name: "Maya", image_url: "m.png" } };
  const identity = resolveCreatorIdentity({ access });
  assert.equal(identity.productName, "Tutor");
  assert.equal(identity.creatorName, "Maya");
  assert.equal(identity.creatorAvatarUrl, "m.png");
  assert.deepEqual(identity.briefSpec, { fields: [] });
  assert.equal(resolveCreatorIdentity({ product: { product_name: "P", creator_name: "Ana", creator_avatar_url: "a.png" } }).creatorAvatarUrl, "a.png");
  assert.equal(creatorInitials("ada lovelace byron"), "AL");
});

test("a Runtime identity refines the current one only when the host binding accepts it", () => {
  const current = resolveCreatorIdentity({ access: { product: { name: "Tutor" }, creator: { name: "Maya", avatar_url: "m.png" } } });
  const message = { creator_agent: { creator: { name: "Maya R" }, product: { name: "Tutor Pro" } } };
  assert.equal(refineCreatorIdentity(current, message, () => false), current);
  assert.equal(refineCreatorIdentity(current, { creator_agent: {} }, () => true), current);
  const refined = refineCreatorIdentity(current, message, () => true);
  assert.equal(refined.productName, "Tutor Pro");
  assert.equal(refined.creatorAvatarUrl, "m.png");
});
