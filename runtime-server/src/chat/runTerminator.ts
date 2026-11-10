import type { ConversationRepository, EndedRun, RunEnding } from "../conversationRepository.js";
import type { RunEventHub } from "./runEventHub.js";
import { fenced } from "./runFence.js";

/**
 * The one exit from a Run, whatever ends it: the executor finishing, a failure, a stop, a sweep that gives up on
 * an orphan, a supervisor that finds the executor threw, a message refused at admission. The repository makes the
 * ending one transaction; only after it commits do observers hear of it, so no client is told of an end that did not happen.
 */
export class RunTerminator {
  constructor(
    private readonly repository: Pick<ConversationRepository, "endRun">,
    private readonly hub: Pick<RunEventHub, "publish">
  ) {}

  async end(runId: string, ending: RunEnding): Promise<EndedRun> {
    const ended = await this.repository.endRun(runId, ending);
    if (ended.ended) this.announce(ended.run.conversationId, runId, ending);
    return ended;
  }

  /** What every transport carries of an end: the failure when there is one, then the terminal state. */
  private announce(conversationId: string, runId: string, ending: RunEnding): void {
    if ("failure" in ending) this.hub.publish(conversationId, { type: "turn.failed", run_id: runId, error: ending.failure });
    this.hub.publish(conversationId, { type: "turn.state", run_id: runId, status: ending.status, ...("failure" in ending ? { reason: ending.failure.message } : {}) });
  }
}

/** Who may end a Run: anyone (a stop, from any instance), or only the executor that holds it. */
export type RunTerminators = { external: RunTerminator; executing: RunTerminator };

export const runTerminators = (
  repository: Pick<ConversationRepository, "endRun">,
  hub: Pick<RunEventHub, "publish">,
  executorId: string
): RunTerminators => ({
  external: new RunTerminator(repository, hub),
  executing: new RunTerminator(fenced(repository, executorId, { endRun: 2 }), hub)
});
