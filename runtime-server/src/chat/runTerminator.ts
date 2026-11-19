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
    private readonly hub: Pick<RunEventHub, "advancedToHead">,
    /** Told of every ending that happened (not of one that found the Run already over). */
    private readonly onEnded?: (ended: EndedRun, ending: RunEnding) => void
  ) {}

  async end(runId: string, ending: RunEnding): Promise<EndedRun> {
    const ended = await this.repository.endRun(runId, ending);
    if (ended.ended) try { this.onEnded?.(ended, ending); } catch { /* an observer never changes how a Run ends */ }
    // The ending's rows (the reply, the `turn.state`) were written by the repository: observers are told where the log stands now, after it committed.
    await this.hub.advancedToHead(ended.run.conversationId);
    return ended;
  }
}

/** Who may end a Run: anyone (a stop, from any instance), or only the executor that holds it. */
export type RunTerminators = { external: RunTerminator; executing: RunTerminator };

export const runTerminators = (
  repository: Pick<ConversationRepository, "endRun">,
  hub: Pick<RunEventHub, "advancedToHead">,
  executorId: string,
  onEnded?: (ended: EndedRun, ending: RunEnding) => void
): RunTerminators => ({
  external: new RunTerminator(repository, hub, onEnded),
  executing: new RunTerminator(fenced(repository, executorId, { endRun: 2 }), hub, onEnded)
});
