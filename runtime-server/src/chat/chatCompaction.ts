import {
  nextWindow, SUMMARY_PREFIX, SUMMARY_SUFFIX,
  type CompactionCheckpoint, type CompactionPhase, type CompactionReason, type CompactionTrigger, type RuntimeCompactionMessage
} from "../compaction.js";
import { BackgroundCompactor, CompactionAborted, newCompactionId, type CompactionOutcome, type CompactionStrategy } from "../compactionStrategy.js";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import type { ConversationMessage, OutboundMessage } from "../protocol.js";
import type { RunStateMachine } from "../runState.js";
import type { RuntimeStore } from "../store.js";
import type { RunEventHub } from "./runEventHub.js";

/** What the rest of the system learns about a compaction: its id, and how it ended. */
export type CompactionNotice = {
  conversationId: string;
  runId?: string;
  compactionId: string;
  state: "started" | "completed" | "aborted";
  /** A failed summary left only a bounded tail: this is the one case the user is told. */
  degraded?: boolean;
  droppedMessages?: number;
};

/** A Run's own compaction: before its turn, between its tool steps, after a provider overflow. */
export interface TurnCompaction {
  ifNeeded(messages: RuntimeCompactionMessage[], phase: "pre_turn" | "mid_turn"): Promise<CompactionCheckpoint | undefined>;
  manual(messages: RuntimeCompactionMessage[]): Promise<CompactionCheckpoint | undefined>;
  /** Bounded: undefined once the attempts for this Run are used up. */
  recoverFromOverflow(messages: RuntimeCompactionMessage[]): Promise<CompactionCheckpoint | undefined>;
}

export interface RunCompactions {
  forRun(run: { run: ConversationRunRecord; conversation: ConversationRecord; state: RunStateMachine; publish: (message: OutboundMessage) => void; signal: AbortSignal }): TurnCompaction;
}

type Repository = Pick<ConversationRepository, "appendEvent" | "beginCompaction" | "requestCompactionPreempt" | "compactionStopped" | "runningCompaction" | "endCompaction" | "commitCompaction">;

type Request = { trigger: CompactionTrigger; phase: CompactionPhase; reason: CompactionReason; force?: boolean; tailScale?: number; turnWaiting?: boolean };

const messageOf = (outcome: Exclude<CompactionOutcome<RuntimeCompactionMessage>, { kind: "none" }>): string =>
  outcome.kind === "summarized" ? `${SUMMARY_PREFIX}${outcome.summary}${SUMMARY_SUFFIX}`
    : outcome.kind === "degraded" ? outcome.messages[0]?.content ?? "" : "Old tool results were pruned.";

/**
 * Chat's compaction, one strategy for every moment it can happen. After a reply it runs in the background
 * and a new message preempts it, on any instance; otherwise it runs inside the Run that needs room.
 */
export class ChatCompaction implements RunCompactions {
  private readonly background = new BackgroundCompactor<string>();
  private readonly listeners = new Set<(notice: CompactionNotice) => void>();

  constructor(private readonly deps: {
    repository: Repository;
    store: Pick<RuntimeStore, "readConversation" | "readCompactionState" | "lastActivityAt">;
    hub: RunEventHub;
    /** Built on first use: its policy needs the model's window. */
    strategy: () => CompactionStrategy<RuntimeCompactionMessage>;
    executorId: string;
    now?: () => number;
    /** How often a running background compaction checks whether a new message asked it to stop. */
    stopPollMs?: number;
    /** The longest a new message waits for a compaction another instance runs. */
    preemptWaitMs?: number;
  }) {}

  /** The channel layer's single notice per compaction hangs off this: one `started` per compaction id. */
  onCompaction(listener: (notice: CompactionNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** After a reply, in the background. A new message ends it first. */
  afterReply(run: Pick<ConversationRunRecord, "id" | "conversationId">): void {
    this.background.schedule(run.conversationId, (signal) => this.inBackground(run, signal));
  }

  /** A new message aborts this conversation's compaction, wherever it runs, and waits for it to end. */
  async preempt(conversationId: string): Promise<void> {
    await this.background.preempt(conversationId);
    if (!await this.deps.repository.requestCompactionPreempt(conversationId)) return;
    const until = (this.deps.now ?? Date.now)() + (this.deps.preemptWaitMs ?? 10_000);
    while (await this.deps.repository.runningCompaction(conversationId) && (this.deps.now ?? Date.now)() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async drain(): Promise<void> { await this.background.drain(); }

  forRun({ run, conversation, state, publish, signal }: Parameters<RunCompactions["forRun"]>[0]): TurnCompaction {
    const { store } = this.deps;
    let overflows = 0;
    const compact = async (messages: RuntimeCompactionMessage[], request: Request): Promise<CompactionCheckpoint | undefined> => {
      const strategy = this.deps.strategy();
      // Most turns are small: decide that before touching the store.
      if (!request.force && strategy.tokensOf(messages) < Math.min(strategy.policy.prune, strategy.policy.trigger)) return undefined;
      const now = (this.deps.now ?? Date.now)();
      // Between tool steps the provider has just seen this prefix; before a turn it has not been seen since the last event.
      const cacheTouchedAt = request.phase === "mid_turn" ? now : await store.lastActivityAt(conversation.id);
      const strategyRequest = { now, cacheTouchedAt, signal, force: request.force, turnWaiting: request.turnWaiting, tailScale: request.tailScale, onFailure: request.trigger === "manual" ? "throw" as const : "degrade" as const };
      if (!strategy.wants(messages, strategyRequest)) return undefined;
      const compactionId = newCompactionId();
      await state.compact(request.phase);
      await this.announce({ conversationId: conversation.id, runId: run.id, compactionId, state: "started" }, { phase: request.phase });
      let checkpoint: CompactionCheckpoint | undefined;
      try {
        const outcome = await strategy.compact(messages, strategyRequest);
        if (outcome.kind === "none") return undefined;
        checkpoint = await this.commit(conversation.id, run.id, compactionId, request, outcome);
        if (checkpoint) publish({ type: "session.compacted", run_id: run.id, ...checkpoint } as OutboundMessage);
        return checkpoint;
      } finally {
        // Every `started` ends: `completed` by the commit, otherwise `aborted`.
        if (!checkpoint) await this.announce({ conversationId: conversation.id, runId: run.id, compactionId, state: "aborted" });
        await state.start();
      }
    };
    return {
      ifNeeded: (messages, phase) => compact(messages, { trigger: "auto", phase, reason: "context_limit", turnWaiting: phase === "pre_turn" }),
      manual: (messages) => compact(messages, { trigger: "manual", phase: "standalone_turn", reason: "user_requested", force: true }),
      recoverFromOverflow: async (messages) => {
        if (overflows >= this.deps.strategy().policy.maxOverflowRetries) return undefined;
        overflows += 1;
        // Each attempt keeps half the tail of the one before.
        return compact(messages, { trigger: "auto", phase: "overflow_recovery", reason: "provider_overflow", force: true, tailScale: 0.5 ** overflows });
      }
    };
  }

  private async inBackground(run: Pick<ConversationRunRecord, "id" | "conversationId">, signal: AbortSignal): Promise<void | { again: number }> {
    const { repository, store } = this.deps;
    const strategy = this.deps.strategy();
    const compactionId = newCompactionId();
    const claim = await repository.beginCompaction({ id: compactionId, conversationId: run.conversationId, executorId: this.deps.executorId, leaseMs: strategy.policy.timeoutMs * 2 });
    if (!claim.claimed) return;
    // A new message on any instance marks the claim; this is how this job hears about it.
    const stopped = new AbortController();
    let started = false;
    let committed = false;
    // An interval has no caller to throw to: a failed poll is logged, and the next one asks again.
    const poll = setInterval(() => void repository.compactionStopped(compactionId).then((stop) => { if (stop) stopped.abort(new CompactionAborted()); }, (error) => console.error(JSON.stringify({ event: "compaction_poll_failed", compaction_id: compactionId, error: String(error) }))), this.deps.stopPollMs ?? 300);
    try {
      const now = (this.deps.now ?? Date.now)();
      const messages = await store.readConversation(run.conversationId);
      const cacheTouchedAt = await store.lastActivityAt(run.conversationId);
      const request = { now, cacheTouchedAt, signal: AbortSignal.any([signal, stopped.signal]) };
      if (!strategy.wants(messages, request)) {
        // Large but under the summary trigger: old tool results can go once the provider's cache has expired.
        const waitMs = strategy.policy.cacheTtlMs - (now - (cacheTouchedAt ?? 0)) + 1_000;
        return strategy.tokensOf(messages) >= strategy.policy.prune && waitMs > 0 ? { again: waitMs } : undefined;
      }
      await this.announce({ conversationId: run.conversationId, runId: run.id, compactionId, state: "started" }, { phase: "background" });
      started = true;
      const outcome = await strategy.compact(messages, request);
      if (outcome.kind !== "none") committed = Boolean(await this.commit(run.conversationId, run.id, compactionId, { trigger: "auto", phase: "background", reason: "context_limit" }, outcome, { latestRunId: claim.latestRunId }));
    } catch (error) {
      // Preempted: the history is untouched and the new message proceeds. Anything else is retried after the next reply.
      if (!(error instanceof CompactionAborted)) throw error;
    } finally {
      clearInterval(poll);
      if (started && !committed) await this.announce({ conversationId: run.conversationId, runId: run.id, compactionId, state: "aborted" });
      await repository.endCompaction(compactionId);
    }
  }

  private async commit(
    conversationId: string, runId: string, compactionId: string, request: Request,
    outcome: Exclude<CompactionOutcome<RuntimeCompactionMessage>, { kind: "none" }>, basis?: { latestRunId?: string }
  ): Promise<CompactionCheckpoint | undefined> {
    const stage = outcome.kind === "summarized" ? "summary" as const : outcome.kind === "degraded" ? "degraded" as const : "prune" as const;
    const degraded = outcome.kind === "degraded";
    const checkpoint: CompactionCheckpoint = {
      trigger: request.trigger, phase: request.phase, reason: request.reason,
      message: messageOf(outcome),
      replacement_history: outcome.messages as ConversationMessage[],
      ...nextWindow(await this.deps.store.readCompactionState(conversationId)),
      compaction_id: compactionId, stage,
      ...(degraded ? { degraded: true, dropped_messages: outcome.dropped } : {})
    };
    const committed = await this.deps.repository.commitCompaction({
      conversationId, compactionId, ...(basis ? { basis } : {}),
      event: { type: "conversation.compacted", conversation_id: conversationId, run_id: runId, ...checkpoint },
      journal: { compaction_id: compactionId, phase: request.phase, stage, tokens_before: outcome.tokensBefore, tokens_after: outcome.tokensAfter, ...(degraded ? { degraded: true, dropped_messages: outcome.dropped } : {}) }
    });
    if (!committed) return undefined;
    await this.announce({ conversationId, runId, compactionId, state: "completed", ...(degraded ? { degraded: true, droppedMessages: outcome.dropped } : {}) });
    return checkpoint;
  }

  /** Live to observers and listeners; `started` and `aborted` are also durable (`completed` is journaled by the commit), so a channel that was down still sees the id. */
  private async announce(notice: CompactionNotice, detail: { phase?: CompactionPhase } = {}): Promise<void> {
    if (notice.state !== "completed") {
      await this.deps.repository.appendEvent({ conversationId: notice.conversationId, ...(notice.runId ? { runId: notice.runId } : {}), type: `compaction.${notice.state}`, payload: { compaction_id: notice.compactionId, ...detail } });
    }
    this.deps.hub.publish(notice.conversationId, {
      type: `compaction.${notice.state}`, compaction_id: notice.compactionId, ...(notice.runId ? { run_id: notice.runId } : {}),
      ...(notice.degraded ? { degraded: true, dropped_messages: notice.droppedMessages } : {})
    });
    // A listener never stops a compaction; its failure is logged, not hidden.
    for (const listener of [...this.listeners]) { try { listener(notice); } catch (error) { console.error(JSON.stringify({ event: "compaction_listener_failed", compaction_id: notice.compactionId, error: String(error) })); } }
  }
}
