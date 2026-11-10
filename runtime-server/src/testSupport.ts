import type { ConversationRepository, EndStatus, RunEnding } from "./conversationRepository.js";
import type { RunEnds } from "./runState.js";

/** An ending for a test to hand `endRun`: a reply for a completed Run, a failure with `reason` for any other. */
export const endingOf = (status: EndStatus, reason: string = status): RunEnding => status === "completed"
  ? { status, reply: { message: { role: "assistant", content: "ok" }, finishReason: "stop", visibleParts: [] } }
  : { status, failure: { code: `run_${status}`, message: reason } };

/** The `ends` a test's RunStateMachine needs: the repository's own `endRun` for this Run. */
export const endsOf = (repository: Pick<ConversationRepository, "endRun">, runId: string): RunEnds =>
  async (ending) => { const { run, ended } = await repository.endRun(runId, ending); return { ended, status: run.status }; };
