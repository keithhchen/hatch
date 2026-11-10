import { failures } from "../errors/failures.js";
import type { ConversationRepository, ConversationRunRecord, ToolCallOutcome } from "../conversationRepository.js";
import type { ToolRequest, ToolResult } from "../protocol.js";
import type { StopRelay } from "./stopRelay.js";
import { RunFenced } from "./runFence.js";

/** The side of the client tool broker that outside callers reach: results in, cancellation out. */
export interface ToolSession {
  handleResult(result: ToolResult): Promise<boolean>;
  cancelRun(runId: string, reason: string): Promise<number>;
  pendingRequests(): ToolRequest[];
}

/** Aborting with this means "another instance continues this Run": the Run keeps its state. */
export class RunHandoff extends Error {
  constructor(message = "Run handed off") {
    super(message);
    this.name = "RunHandoff";
  }
}

export type RunControl = {
  signal: AbortSignal;
  /** The executor registers where local-tool results for this Run arrive. */
  toolSession(session: ToolSession): void;
};

/** Executes a Run from the last user message until it is terminal or handed off. */
export interface RunExecutor {
  execute(run: ConversationRunRecord, control: RunControl): Promise<void>;
}

export type ResumeDecision = "restart" | { interrupt: string };

/** What to do with a Run whose executor disappeared. */
export interface ResumePolicy {
  decide(run: ConversationRunRecord): Promise<ResumeDecision>;
}

export type SupervisorOptions = {
  executorId: string;
  leaseMs: number;
  sweepMs: number;
  /** How often answers stored by another instance are handed to the calls waiting here. */
  toolPollMs?: number;
  /** Called once a Run has completed, for work that follows a reply, such as compaction. */
  afterReply?: (run: ConversationRunRecord) => void;
  /** Tells the instance that executes a Run it was stopped, so it does not wait for its next lease renewal. */
  stops?: StopRelay;
};

const outcomeOf = (result: ToolResult): ToolCallOutcome => result.status === "ok"
  ? { status: "ok", result: result.result }
  : { status: "error", error: result.error };

type Owned = { conversationId: string; controller: AbortController; session?: ToolSession; done: Promise<void> };

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * Owns Runs for as long as they last, whichever client started them. A Run is
 * kept alive by a renewed lease; when its owner disappears another instance
 * claims the lapsed lease and continues according to the ResumePolicy.
 */
export class RunSupervisor {
  private readonly owned = new Map<string, Owned>();
  private timers: NodeJS.Timeout[] = [];
  private unsubscribe?: () => Promise<void>;

  constructor(
    private readonly repository: Pick<ConversationRepository, "renewLease" | "claimOrphanedRuns" | "getRun" | "transitionRun" | "listToolCalls" | "answerToolCall">,
    private readonly executor: RunExecutor,
    private readonly policy: ResumePolicy,
    private readonly options: SupervisorOptions
  ) {}

  get executorId(): string { return this.options.executorId; }

  async start(): Promise<void> {
    if (this.timers.length) return;
    this.timers = [
      setInterval(() => void this.renewLeases(), Math.max(1, Math.floor(this.options.leaseMs / 3))),
      setInterval(() => void this.sweep(), this.options.sweepMs),
      setInterval(() => void this.relayToolResults(), this.options.toolPollMs ?? 250)
    ];
    for (const timer of this.timers) timer.unref();
    this.unsubscribe = await this.options.stops?.subscribe((runId) => void this.stopLocally(runId, "The Run stopped")).catch(() => undefined);
  }

  /** Ends this instance's execution of a Run; its state is recorded by whoever stopped it. */
  private async stopLocally(runId: string, reason: string): Promise<void> {
    const owned = this.owned.get(runId);
    if (!owned || owned.controller.signal.aborted) return;
    owned.controller.abort(new Error(reason));
    await owned.session?.cancelRun(runId, reason).catch(() => undefined);
  }

  /** Takes responsibility for a Run this process just started, continued or claimed. */
  adopt(run: ConversationRunRecord, onSettled?: () => void): void {
    if (this.owned.has(run.id)) return;
    const controller = new AbortController();
    const owned: Owned = { conversationId: run.conversationId, controller, done: Promise.resolve() };
    this.owned.set(run.id, owned);
    owned.done = this.drive(run, owned).finally(() => { this.owned.delete(run.id); onSettled?.(); });
  }

  /** The only way a Run stops early: an explicit stop. */
  async cancel(conversationId: string, runId: string, reason: string): Promise<boolean> {
    const before = await this.repository.getRun(conversationId, runId);
    if (!before || TERMINAL.has(before.status)) return false;
    const owned = this.owned.get(runId);
    owned?.controller.abort(new Error(reason));
    await owned?.session?.cancelRun(runId, reason);
    // Already cancelled when the executor's own state machine recorded it; this covers a Run it does not hold.
    await this.repository.transitionRun(runId, "cancelled", reason);
    // The state is written first: the instance that executes the Run, if not this one, learns of it at once.
    if (!owned) this.options.stops?.publish(runId);
    return true;
  }

  /**
   * From any instance. The answer is recorded first, so the instance that waits for it, or one that takes
   * the Run over, finds it; the instance that holds the call here gets it straight away.
   */
  async deliverToolResult(conversationId: string, runId: string, result: ToolResult): Promise<boolean> {
    const recorded = await this.repository.answerToolCall(conversationId, runId, result.tool_call_id, outcomeOf(result)).catch(() => false);
    // A Run is answered only through its own conversation, never by run id alone.
    const owned = this.owned.get(runId);
    const local = owned?.conversationId === conversationId ? await owned.session?.handleResult(result) ?? false : false;
    return recorded || local;
  }

  owns(runId: string): boolean { return this.owned.has(runId); }

  /** True until every execution in the conversation has settled, even one whose Run was cancelled. */
  holdsConversation(conversationId: string): boolean {
    return [...this.owned.values()].some((owned) => owned.conversationId === conversationId);
  }

  /** Local-tool calls of a Run that wait for a client, so any permitted client can answer them. */
  pendingToolRequests(runId: string): ToolRequest[] { return this.owned.get(runId)?.session?.pendingRequests() ?? []; }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.unsubscribe?.().catch(() => undefined);
    this.unsubscribe = undefined;
    const running = [...this.owned.values()];
    for (const owned of running) owned.controller.abort(new RunHandoff("Runtime shutting down"));
    await Promise.allSettled(running.map((owned) => owned.done));
  }

  /** Claims lapsed Runs; exposed so a starting instance does not wait for the first timer. */
  async sweep(): Promise<void> {
    const claimed = await this.repository.claimOrphanedRuns(this.options.executorId, this.options.leaseMs).catch(() => []);
    for (const run of claimed) {
      const decision = await this.policy.decide(run).catch((error): ResumeDecision => ({ interrupt: String(error) }));
      if (decision === "restart") this.adopt(run);
      else await this.repository.transitionRun(run.id, "interrupted", decision.interrupt).catch(() => undefined);
    }
  }

  /** Answers another instance recorded reach the calls this instance's Runs are waiting for. */
  private async relayToolResults(): Promise<void> {
    for (const [runId, owned] of this.owned) {
      const waiting = owned.session?.pendingRequests() ?? [];
      if (!waiting.length) continue;
      const answered = (await this.repository.listToolCalls(runId).catch(() => [])).filter((call) => call.outcome && waiting.some((request) => request.tool_call_id === call.toolCallId));
      for (const call of answered) {
        const result = call.outcome!.status === "ok"
          ? { type: "tool_call.result" as const, run_id: runId, tool_call_id: call.toolCallId, status: "ok" as const, result: call.outcome!.result }
          : { type: "tool_call.result" as const, run_id: runId, tool_call_id: call.toolCallId, status: "error" as const, error: (call.outcome as { error: { code: string; message: string } }).error };
        await owned.session!.handleResult(result).catch(() => false);
      }
    }
  }

  private async renewLeases(): Promise<void> {
    for (const [runId, owned] of this.owned) {
      const held = await this.repository.renewLease(runId, this.options.executorId, this.options.leaseMs).catch(() => true);
      if (!held) owned.controller.abort(new RunHandoff("Run lease lost"));
    }
  }

  private async drive(first: ConversationRunRecord, owned: Owned): Promise<void> {
    let run = first;
    const control: RunControl = { signal: owned.controller.signal, toolSession: (session) => { owned.session = session; } };
    try {
      for (;;) {
        await this.executor.execute(run, control);
        const latest = await this.repository.getRun(run.conversationId, run.id);
        if (latest?.status === "completed") this.options.afterReply?.(latest);
        if (!latest || TERMINAL.has(latest.status) || owned.controller.signal.aborted) return;
        // A message joined after the executor's last claim: the Run is not over.
        if (latest.consumedCount < latest.steeredCount) { run = latest; continue; }
        await this.repository.transitionRun(run.id, "failed", "The Run ended without a result");
        return;
      }
    } catch (error) {
      // A fenced executor no longer holds the Run: whoever does, or whoever stopped it, decides its state.
      if (owned.controller.signal.reason instanceof RunHandoff || error instanceof RunFenced) return;
      await this.repository.transitionRun(run.id, "failed", failures.translate(error, { run: run.id, conversation: run.conversationId }).message).catch(() => undefined);
    }
  }
}
