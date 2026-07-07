import type { RunStatus, RuntimeStore } from "./store.js";

const allowedTransitions: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "cancelled", "failed"],
  running: ["waiting_for_tool", "compacting", "completed", "failed", "cancelled"],
  waiting_for_tool: ["running", "compacting", "completed", "failed", "cancelled"],
  compacting: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export class RunStateMachine {
  private currentStatus: RunStatus = "queued";

  constructor(
    readonly runId: string,
    readonly conversationId: string,
    private readonly store: RuntimeStore,
    private readonly onTransition?: (status: RunStatus, reason?: string) => void | Promise<void>
  ) {}

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

  async complete(): Promise<void> {
    await this.transition("completed");
  }

  async fail(reason: string): Promise<void> {
    await this.transition("failed", reason);
  }

  async cancel(reason: string): Promise<void> {
    await this.transition("cancelled", reason);
  }

  private async transition(next: RunStatus, reason?: string): Promise<void> {
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
