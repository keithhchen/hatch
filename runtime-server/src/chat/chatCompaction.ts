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
import { log } from "../observability/log.js";
import type { UsageSink } from "../usage/usage.js";

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
  forRun(run: { run: ConversationRunRecord; conversation: ConversationRecord; state: RunStateMachine; publish: (message: OutboundMessage) => void; signal: AbortSignal; usage?: UsageSink }): TurnCompaction;
}

type Repository = Pick<ConversationRepository, "appendEvent" | "beginCompaction" | "renewCompaction" | "runningCompaction" | "endCompaction" | "commitCompaction">;

/** How long past the summary's timeout a compaction claim lives without a renewal. */
const LEASE_MARGIN_MS = 10_000;

type Request = { trigger: CompactionTrigger; phase: CompactionPhase; reason: CompactionReason; force?: boolean; tailScale?: number; turnWaiting?: boolean };

const messageOf = (outcome: Exclude<CompactionOutcome<RuntimeCompactionMessage>, { kind: "none" }>): string =>
  outcome.kind === "summarized" ? `${SUMMARY_PREFIX}${outcome.summary}${SUMMARY_SUFFIX}`
    : outcome.kind === "degraded" ? outcome.messages[0]?.content ?? "" : "Old tool results were pruned.";

/**
 * Chat's compaction, one strategy for every moment it can happen. After a reply it runs in the background
 * and a new message waits for it, on any instance; otherwise it runs inside the Run that needs room.
 */
export class ChatCompaction implements RunCompactions {
  private readonly background = new BackgroundCompactor<string>();
  private readonly listeners = new Set<(notice: CompactionNotice) => void>();
  /** Who pays for a conversation's compaction after a reply: whoever paid for its latest Run. */
  private readonly sinks = new Map<string, UsageSink>();

  constructor(private readonly deps: {
    repository: Repository;
    store: Pick<RuntimeStore, "readConversation" | "readCompactionState" | "lastActivityAt">;
    hub: RunEventHub;
    /** Built when a conversation needs it: its policy needs the window of the model that conversation runs on, which the database may change. */
    strategy: (conversationId: string) => Promise<CompactionStrategy<RuntimeCompactionMessage>>;
    executorId: string;
    now?: () => number;
    /** How often a message waiting for another instance's compaction looks again. */
    waitPollMs?: number;
    /** How long past the summary's timeout a claim lives unrenewed. */
    leaseMarginMs?: number;
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

  /**
   * A new message waits for this conversation's compaction to finish, wherever it runs, and then runs on the compacted history.
   * The compaction ends by its own result, timeout or lease: a compactor that crashed stops blocking when its lease expires,
   * and whatever it commits late is refused because a Run has begun since.
   */
  async waitForCompaction(conversationId: string): Promise<void> {
    await this.background.settle(conversationId);
    while (await this.deps.repository.runningCompaction(conversationId)) await new Promise((resolve) => setTimeout(resolve, this.deps.waitPollMs ?? 50));
  }

  async drain(): Promise<void> { await this.background.drain(); }

  forRun({ run, conversation, state, publish, signal, usage }: Parameters<RunCompactions["forRun"]>[0]): TurnCompaction {
    const { store } = this.deps;
    if (usage) this.sinks.set(conversation.id, usage);
    let overflows = 0;
    const compact = async (messages: RuntimeCompactionMessage[], request: Request): Promise<CompactionCheckpoint | undefined> => {
      const strategy = await this.deps.strategy(conversation.id);
      // Most turns are small: decide that before touching the store.
      if (!request.force && strategy.tokensOf(messages) < Math.min(strategy.policy.prune, strategy.policy.trigger)) return undefined;
      const now = (this.deps.now ?? Date.now)();
      // Between tool steps the provider has just seen this prefix; before a turn it has not been seen since the last event.
      const cacheTouchedAt = request.phase === "mid_turn" ? now : await store.lastActivityAt(conversation.id);
      const strategyRequest = { now, cacheTouchedAt, signal, force: request.force, turnWaiting: request.turnWaiting, tailScale: request.tailScale, onFailure: request.trigger === "manual" ? "throw" as const : "degrade" as const, usage };
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
        if (overflows >= (await this.deps.strategy(conversation.id)).policy.maxOverflowRetries) return undefined;
        overflows += 1;
        // Each attempt keeps half the tail of the one before.
        return compact(messages, { trigger: "auto", phase: "overflow_recovery", reason: "provider_overflow", force: true, tailScale: 0.5 ** overflows });
      }
    };
  }

  private async inBackground(run: Pick<ConversationRunRecord, "id" | "conversationId">, signal: AbortSignal): Promise<void | { again: number }> {
    const { repository, store } = this.deps;
    const strategy = await this.deps.strategy(run.conversationId);
    const compactionId = newCompactionId();
    // The lease outlasts the summary's own timeout by a margin; while this process is alive it keeps renewing, so a slow
    // compaction is never taken for a dead one and run twice, and a dead one frees the conversation within one lease.
    const leaseMs = strategy.policy.timeoutMs + (this.deps.leaseMarginMs ?? LEASE_MARGIN_MS);
    const claim = await repository.beginCompaction({ id: compactionId, conversationId: run.conversationId, executorId: this.deps.executorId, leaseMs });
    if (!claim.claimed) return;
    const heartbeat = setInterval(() => void repository.renewCompaction(compactionId, leaseMs).catch((error) => log.error("compaction_renew_failed", { compaction_id: compactionId, error: String(error) })), Math.max(10, Math.floor(leaseMs / 3)));
    let started = false;
    let committed = false;
    try {
      const now = (this.deps.now ?? Date.now)();
      const messages = await store.readConversation(run.conversationId);
      const cacheTouchedAt = await store.lastActivityAt(run.conversationId);
      const request = { now, cacheTouchedAt, signal, usage: this.sinks.get(run.conversationId) };
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
      // Stopped (shutdown): the history is untouched. Anything else is retried after the next reply.
      if (!(error instanceof CompactionAborted)) throw error;
    } finally {
      clearInterval(heartbeat);
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
    for (const listener of [...this.listeners]) { try { listener(notice); } catch (error) { log.error("compaction_listener_failed", { compaction_id: notice.compactionId, error: String(error) }); } }
  }
}
