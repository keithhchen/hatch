import { failures } from "../errors/failures.js";
import type { ConversationRepository, ConversationRunRecord, ToolCallOutcome } from "../conversationRepository.js";
import type { ToolRequest, ToolResult } from "../protocol.js";
import type { StopRelay } from "./stopRelay.js";
import { RunFenced } from "./runFence.js";
import type { RunTerminators } from "./runTerminator.js";
import { currentContext, newRequestId, runInContext } from "../observability/context.js";
import { log } from "../observability/log.js";
import { reported } from "../observability/reported.js";

/** The side of the client tool broker that outside callers reach: results in, cancellation out. */
export interface ToolSession {
  handleResult(result: ToolResult): Promise<boolean>;
  cancelRun(runId: string, reason: string): Promise<number>;
  pendingRequests(): ToolRequest[];
}

/** Aborting with this means "this instance stops executing the Run": whoever sweeps its lapsed lease ends it as interrupted. */
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
  /** The executor hears each message that joins this Run; resolves to the way to stop hearing. */
  onSteer(listener: () => void): () => void;
};

/** Executes a Run from the last user message until it is terminal or this instance lets go of it. */
export interface RunExecutor {
  execute(run: ConversationRunRecord, control: RunControl): Promise<void>;
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
  /** Tells the instance that executes a Run a message joined it, so it cuts the model call in flight without waiting for it to end. */
  steers?: StopRelay;
};

const outcomeOf = (result: ToolResult): ToolCallOutcome => result.status === "ok"
  ? { status: "ok", result: result.result }
  : { status: "error", error: result.error };

type Owned = { conversationId: string; controller: AbortController; session?: ToolSession; wake?: () => void; done: Promise<void> };

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** A rejection handler that reports the failure with its context, then yields what the caller continues with. */
const logged = <T>(event: string, fallback: T, fields: Record<string, unknown> = {}) => (error: unknown): T => {
  reported(event, fields)(error);
  return fallback;
};

/**
 * Owns Runs for as long as they last, whichever client started them. A Run is
 * kept alive by a renewed lease; when its owner disappears another instance
 * claims the lapsed lease and ends the Run as interrupted. A Run is never resumed.
 */
export class RunSupervisor {
  private readonly owned = new Map<string, Owned>();
  private timers: NodeJS.Timeout[] = [];
  private sweepTimer?: NodeJS.Timeout;
  private unsubscribe?: () => Promise<void>;
  private unsubscribeSteers?: () => Promise<void>;

  constructor(
    private readonly repository: Pick<ConversationRepository, "renewLease" | "claimOrphanedRuns" | "getRun" | "listToolCalls" | "answerToolCall">,
    private readonly executor: RunExecutor,
    /** Settles what an orphaned Run left open in the transcript, before it ends interrupted. */
    private readonly settleOrphan: (run: ConversationRunRecord) => Promise<void>,
    private readonly options: SupervisorOptions,
    /** Every end of a Run that is not the executor's own goes through these: a stop from anywhere, a sweep, a thrown executor. */
    private readonly terminators: RunTerminators
  ) {}

  get executorId(): string { return this.options.executorId; }

  async start(): Promise<void> {
    if (this.timers.length) return;
    this.sweepTimer = setInterval(() => void this.sweep(), this.options.sweepMs);
    this.timers = [
      setInterval(() => void this.renewLeases(), Math.max(1, Math.floor(this.options.leaseMs / 3))),
      this.sweepTimer,
      setInterval(() => void this.relayToolResults(), this.options.toolPollMs ?? 250)
    ];
    for (const timer of this.timers) timer.unref();
    this.unsubscribe = await this.options.stops?.subscribe((runId) => void this.stopLocally(runId, "The Run stopped")).catch(logged("run_stop_subscribe_failed", undefined));
    this.unsubscribeSteers = await this.options.steers?.subscribe((runId) => this.owned.get(runId)?.wake?.()).catch(logged("run_steer_subscribe_failed", undefined));
  }

  /** A message joined the Run, on any instance: the one that executes it cuts the model call in flight. */
  steered(runId: string): void {
    const owned = this.owned.get(runId);
    if (owned) owned.wake?.();
    else this.options.steers?.publish(runId);
  }

  /** Ends this instance's execution of a Run; its state is recorded by whoever stopped it. */
  private async stopLocally(runId: string, reason: string): Promise<void> {
    const owned = this.owned.get(runId);
    if (!owned || owned.controller.signal.aborted) return;
    owned.controller.abort(new Error(reason));
    await owned.session?.cancelRun(runId, reason).catch(logged("run_cancel_tools_failed", undefined, { run_id: runId }));
  }

  /** Takes responsibility for a Run this process just started. */
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
    await this.terminators.external.end(runId, { status: "cancelled", failure: { code: "run_cancelled", message: reason } });
    // The state is written first: the instance that executes the Run, if not this one, learns of it at once.
    if (!owned) this.options.stops?.publish(runId);
    return true;
  }

  /**
   * From any instance. The answer is recorded first, so the instance that waits for it, or one that takes
   * the Run over, finds it; the instance that holds the call here gets it straight away.
   */
  async deliverToolResult(conversationId: string, runId: string, result: ToolResult): Promise<boolean> {
    // A storage failure is an internal error for the caller, not "no such tool call".
    const recorded = await this.repository.answerToolCall(conversationId, runId, result.tool_call_id, outcomeOf(result)).catch((error) => {
      reported("tool_result_record_failed", { run_id: runId, tool_call_id: result.tool_call_id })(error);
      throw error;
    });
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

  /**
   * Lets the Runs held here finish. Leases keep being renewed, but no lapsed Run of another instance is
   * claimed any more; a Run that starts meanwhile is waited for too.
   */
  async drain(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    while (this.owned.size) await Promise.allSettled([...this.owned.values()].map((owned) => owned.done));
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.unsubscribe?.().catch(logged("run_stop_unsubscribe_failed", undefined));
    this.unsubscribe = undefined;
    await this.unsubscribeSteers?.().catch(logged("run_steer_unsubscribe_failed", undefined));
    this.unsubscribeSteers = undefined;
    const running = [...this.owned.values()];
    for (const owned of running) owned.controller.abort(new RunHandoff("Runtime shutting down"));
    await Promise.allSettled(running.map((owned) => owned.done));
  }

  /** Ends the Runs whose owner is gone as interrupted; exposed so a starting instance does not wait for the first timer. */
  async sweep(): Promise<void> {
    const claimed = await this.repository.claimOrphanedRuns(this.options.executorId, this.options.leaseMs).catch(logged("run_sweep_failed", []));
    for (const run of claimed) {
      try {
        await this.settleOrphan(run);
        await this.terminators.executing.end(run.id, { status: "interrupted", failure: { code: "run_interrupted", message: "The Runtime restarted while this Run was in progress. Send the message again to continue." } });
      } catch (error) { log.error("run_interrupt_unrecorded", { run_id: run.id, conversation_id: run.conversationId, error }); }
    }
  }

  /** Answers another instance recorded reach the calls this instance's Runs are waiting for. */
  private async relayToolResults(): Promise<void> {
    for (const [runId, owned] of this.owned) {
      const waiting = owned.session?.pendingRequests() ?? [];
      if (!waiting.length) continue;
      const answered = (await this.repository.listToolCalls(runId).catch(logged("tool_calls_read_failed", [], { run_id: runId }))).filter((call) => call.outcome && waiting.some((request) => request.tool_call_id === call.toolCallId));
      for (const call of answered) {
        const result = call.outcome!.status === "ok"
          ? { type: "tool_call.result" as const, run_id: runId, tool_call_id: call.toolCallId, status: "ok" as const, result: call.outcome!.result }
          : { type: "tool_call.result" as const, run_id: runId, tool_call_id: call.toolCallId, status: "error" as const, error: (call.outcome as { error: { code: string; message: string } }).error };
        try { await owned.session!.handleResult(result); } catch (error) { await this.fail({ id: runId, conversationId: owned.conversationId }, error); }
      }
    }
  }

  private async renewLeases(): Promise<void> {
    for (const [runId, owned] of this.owned) {
      const held = await this.repository.renewLease(runId, this.options.executorId, this.options.leaseMs).catch(logged("lease_renew_failed", true, { run_id: runId }));
      if (!held) owned.controller.abort(new RunHandoff("Run lease lost"));
    }
  }

  /** A Run is driven in its own context: the request that started it when there is one, a fresh id otherwise. */
  private drive(first: ConversationRunRecord, owned: Owned): Promise<void> {
    return runInContext({ request_id: currentContext()?.request_id ?? newRequestId(), conversation_id: first.conversationId, run_id: first.id }, () => this.driveRun(first, owned));
  }

  private async driveRun(first: ConversationRunRecord, owned: Owned): Promise<void> {
    let run = first;
    const control: RunControl = { signal: owned.controller.signal, toolSession: (session) => { owned.session = session; },
      onSteer: (listener) => { owned.wake = listener; return () => { if (owned.wake === listener) owned.wake = undefined; }; } };
    try {
      for (;;) {
        await this.executor.execute(run, control);
        const latest = await this.repository.getRun(run.conversationId, run.id);
        if (latest?.status === "completed") this.options.afterReply?.(latest);
        if (!latest || TERMINAL.has(latest.status) || owned.controller.signal.aborted) return;
        // A message joined after the executor's last claim: the Run is not over.
        if (latest.consumedCount < latest.steeredCount) { run = latest; continue; }
        await this.terminators.executing.end(run.id, { status: "failed", failure: failures.translate(new Error("The Run ended without a result"), { run: run.id, conversation: run.conversationId }) });
        return;
      }
    } catch (error) {
      // A fenced executor no longer holds the Run: whoever does, or whoever stopped it, decides its state.
      if (owned.controller.signal.reason instanceof RunHandoff || error instanceof RunFenced) return;
      await this.fail(run, error);
    }
  }

  /** The Run cannot go on: say why, with its context, and record it failed through the Run's one exit. */
  private async fail(run: Pick<ConversationRunRecord, "id" | "conversationId">, error: unknown): Promise<void> {
    log.error("run_failed", { run_id: run.id, conversation_id: run.conversationId, error });
    await this.terminators.executing.end(run.id, { status: "failed", failure: failures.translate(error, { run: run.id, conversation: run.conversationId }) })
      .catch(logged("run_failure_unrecorded", undefined, { run_id: run.id, conversation_id: run.conversationId }));
  }
}
