import type { OutboundMessage } from "./protocol.js";
import type { ConversationRepository, EndStatus, RunEnding } from "./conversationRepository.js";
import type { RunEnds } from "./runState.js";

/** An ending for a test to hand `endRun`: a reply for a completed Run, a failure with `reason` for any other. */
export const endingOf = (status: EndStatus, reason: string = status): RunEnding => status === "completed"
  ? { status, reply: { message: { role: "assistant", content: "ok" }, finishReason: "stop" } }
  : { status, failure: { code: `run_${status}`, message: reason } };

/** The `ends` a test's RunStateMachine needs: the repository's own `endRun` for this Run. */
export const endsOf = (repository: Pick<ConversationRepository, "endRun">, runId: string): RunEnds =>
  async (ending) => { const { run, ended } = await repository.endRun(runId, ending); return { ended, status: run.status }; };

/**
 * For tests that observe a Run through a socket: the frames a client now receives (`log.event`) read as the lifecycle frames
 * the tests were written against. Automated tests only; no product path uses this.
 */
export function legacyFrames(text: string): OutboundMessage[] {
  const frame = JSON.parse(text) as Record<string, unknown>;
  if (frame.type !== "log.event") return [frame as unknown as OutboundMessage];
  const e = frame.event as Record<string, unknown>;
  const run_id = e.run_id as string;
  const out: Array<Record<string, unknown>> = [];
  switch (e.type) {
    case "assistant.text": out.push({ type: "assistant.delta", run_id, delta: { kind: "text", content: e.content } }); break;
    case "assistant.thinking":
      out.push({ type: "assistant.delta", run_id, delta: e.phase === "start" ? { kind: "thinking_start", contentIndex: e.index }
        : e.phase === "delta" ? { kind: "thinking_delta", contentIndex: e.index, delta: e.delta } : { kind: "thinking_end", contentIndex: e.index, content: e.content } });
      break;
    case "tool.call": out.push({ ...e, type: "tool_call.delta" }); break;
    case "skill.activated": case "skill.invoked": case "skill.run": out.push(e); break;
    case "run.state": {
      out.push({ type: "turn.state", run_id, status: e.status, ...(e.reason ? { reason: e.reason } : {}) });
      if (e.status === "completed") out.push({ type: "turn.completed", run_id, finish_reason: e.finish_reason ?? "stop" });
      else if (e.failure) out.push({ type: "turn.failed", run_id, error: e.failure });
      break;
    }
    default:
  }
  return [frame as unknown as OutboundMessage, ...(out as unknown as OutboundMessage[])];
}
