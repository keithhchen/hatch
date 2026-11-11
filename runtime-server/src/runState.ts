import type { PublicFailure } from "./errors/failures.js";
import type { DurableRunStatus, LiveRunStatus, RunEnding, RunReply } from "./conversationRepository.js";
import type { RunStatus, RuntimeStore } from "./store.js";

const allowedTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled", "failed", "interrupted"],
  running: ["waiting_for_tool", "compacting", "completed", "failed", "cancelled", "interrupted"],
  waiting_for_tool: ["running", "compacting", "completed", "failed", "cancelled", "interrupted"],
  compacting: ["running", "completed", "failed", "cancelled", "interrupted"],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: []
};

/** Where a Run's ending is made: `ended` is false when it was already over, or kept open for a message that joined it. */
export type RunEnds = (ending: RunEnding) => Promise<{ ended: boolean; status: DurableRunStatus }>;

/** For a Run with no durable record, such as an evaluation: its end is a line in the transcript. */
export const transcriptEnds = (store: Pick<RuntimeStore, "append">, conversationId: string, runId: string, from: () => RunStatus): RunEnds =>
  async (ending) => {
    await store.append({
      type: "turn.state", conversation_id: conversationId, run_id: runId, from: from(), to: ending.status,
      ...("failure" in ending ? { reason: ending.failure.message } : {})
    });
    return { ended: true, status: ending.status };
  };

export class RunStateMachine {
  private currentStatus: RunStatus;
  private produced: () => RunReply | undefined = () => undefined;

  constructor(
    readonly runId: string,
    readonly conversationId: string,
    private readonly store: RuntimeStore,
    /** Where the Run ends: the one exit, so an ending is never made twice or half. */
    private readonly ends: RunEnds,
    private readonly onTransition?: (status: LiveRunStatus, reason?: string) => void | Promise<void>,
    /** Where the Run already is when another instance takes it over. */
    initial: RunStatus = "queued"
  ) {
    this.currentStatus = initial;
  }

  get status(): RunStatus {
    return this.currentStatus;
  }

  async queued(): Promise<void> {
    await this.store.append({
      type: "turn.state",
      conversation_id: this.conversationId,
      run_id: this.runId,
      to: "queued"
    });
    await this.onTransition?.("queued");
  }

  async start(): Promise<void> {
    await this.transition("running");
  }

  async waitForTool(): Promise<void> {
    await this.transition("waiting_for_tool");
  }

  async resumeFromTool(): Promise<void> {
    await this.transition("running");
  }

  async compact(reason: string): Promise<void> {
    await this.transition("compacting", reason);
  }

  /** False when the reply was kept but the Run stays open, because a message joined it after the last claim. */
  async complete(reply: RunReply): Promise<boolean> {
    return this.end({ status: "completed", reply });
  }

  /** Where the Run reads what it has produced so far: a Run that does not complete keeps it as its reply. */
  keepsReplyFrom(produced: () => RunReply | undefined): void {
    this.produced = produced;
  }

  async fail(failure: PublicFailure): Promise<void> {
    await this.end({ status: "failed", failure, ...this.kept() });
  }

  async cancel(reason: string): Promise<void> {
    await this.end({ status: "cancelled", failure: { code: "run_cancelled", message: reason }, ...this.kept() });
  }

  async interrupt(reason: string): Promise<void> {
    await this.end({ status: "interrupted", failure: { code: "run_interrupted", message: reason }, ...this.kept() });
  }

  private kept(): { reply?: RunReply } {
    const reply = this.produced();
    return reply ? { reply } : {};
  }

  private async end(ending: RunEnding): Promise<boolean> {
    if (this.currentStatus === ending.status) return true;
    if (!allowedTransitions[this.currentStatus].includes(ending.status)) {
      throw new Error(`Invalid run transition ${this.currentStatus} -> ${ending.status}`);
    }
    const { ended, status } = await this.ends(ending);
    // Whoever ended it first decides what it is: a stop that raced the executor's own ending wins.
    if (ended || ["completed", "failed", "cancelled", "interrupted"].includes(status)) this.currentStatus = status as RunStatus;
    return ended;
  }

  private async transition(next: LiveRunStatus, reason?: string): Promise<void> {
    if (this.currentStatus === next) return;
    const allowed = allowedTransitions[this.currentStatus];
    if (!allowed.includes(next)) {
      throw new Error(`Invalid run transition ${this.currentStatus} -> ${next}`);
    }
    const from = this.currentStatus;
    this.currentStatus = next;
    await this.store.append({
      type: "turn.state",
      conversation_id: this.conversationId,
      run_id: this.runId,
      from,
      to: next,
      reason
    });
    await this.onTransition?.(next, reason);
  }
}
