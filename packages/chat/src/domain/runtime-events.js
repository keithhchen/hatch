import { ChatTimeline } from "./timeline.js";

/**
 * Reducer over protocol 0.8 Runtime wire events (union of Web and Desktop).
 * It applies timeline-shaped events to a ChatTimeline and classifies the rest
 * into an outcome the application layer acts on. Text deltas are returned,
 * not applied, so a host text-reveal policy can pace them.
 *
 * Outcome kinds: text, timeline, tool_request, approval_request, turn_state,
 * compacted, accepted, ready, terminal, session_error, ignored.
 */
const replying = Object.freeze({ key: "agentReplying" });
const outcome = (kind, fields = {}) => Object.freeze({ kind, ...fields });
const IGNORED = outcome("ignored");

const deltaHandlers = Object.freeze({
  text: (_timeline, delta) => outcome("text", { content: delta.content ?? "", status: replying }),
  thinking_start: (timeline, delta) => (timeline.startThinking(delta.contentIndex), outcome("timeline", { status: replying })),
  thinking_delta: (timeline, delta) => (timeline.appendThinking(delta.contentIndex, delta.delta), outcome("timeline", { status: replying })),
  thinking_end: (timeline, delta) => (timeline.finishThinking(delta.contentIndex, delta.content), outcome("timeline")),
  status: (timeline, delta) => {
    if (!delta.content || ChatTimeline.isRedundantToolStatus(delta.content)) return IGNORED;
    timeline.updateRuntimeStatus(delta.content);
    return outcome("timeline", { status: { text: delta.content } });
  }
});

/** Approval frames are projected onto their tool entry. */
export function toolEventFromApproval(event) {
  const denied = event.type === "approval.result" && event.status === "denied";
  return {
    ...event,
    type: "tool_call.delta",
    locality: "client",
    approval: "ask",
    status: denied ? "failed" : "requested",
    ...(denied ? { error: event.reason ? { message: event.reason } : { code: "approval_denied" } } : {})
  };
}

const runHandlers = Object.freeze({
  "assistant.delta": (timeline, event) => deltaHandlers[event.delta?.kind]?.(timeline, event.delta) ?? IGNORED,
  "tool_call.delta": (timeline, event) => (timeline.upsertTool(event), outcome("timeline")),
  "tool_call.request": (_timeline, event) => outcome("tool_request", { request: event }),
  "approval.request": (timeline, event) => (timeline.upsertTool(toolEventFromApproval(event)), outcome("approval_request", { request: event })),
  "approval.result": (timeline, event) => (timeline.upsertTool(toolEventFromApproval(event)), outcome("timeline")),
  "skill.activated": (timeline, event) => (timeline.upsertSkill(event), outcome("timeline")),
  "skill.invoked": (timeline, event) => (timeline.upsertSkill(event), outcome("timeline")),
  "skill.run": (timeline, event) => (timeline.upsertSkillRun(event), outcome("timeline")),
  "turn.state": (_timeline, event) => outcome("turn_state", { state: event.status }),
  "message.accepted": (_timeline, event) => outcome("accepted", { receipt: event }),
  "turn.completed": (_timeline, event) => outcome("terminal", { failed: false, finishReason: event.finish_reason }),
  "turn.failed": (_timeline, event) => outcome("terminal", { failed: true, error: event.error })
});

const sessionHandlers = Object.freeze({
  "session.ready": (_timeline, event) => outcome("ready", { session: event }),
  "session.error": (_timeline, event) => outcome("session_error", { error: event.error }),
  "session.compacted": (_timeline, event) => outcome("compacted", { compaction: event })
});

export class RuntimeEventReducer {
  /**
   * @param {ChatTimeline} timeline live timeline of the active run
   * @param {object} event Runtime wire event
   * @param {string|null} activeRunId only events of this run touch the timeline
   */
  reduce(timeline, event, activeRunId) {
    const session = sessionHandlers[event?.type];
    if (session) return session(timeline, event);
    const run = runHandlers[event?.type];
    if (!run || !activeRunId || event.run_id !== activeRunId) return IGNORED;
    return run(timeline, event);
  }
}
