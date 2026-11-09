import path from "node:path";
import { Pool, type QueryResultRow } from "pg";
import type { PostgresQueryExecutor } from "./postgresStore.js";
import type { PostgresStore, PostgresTransactionClient } from "./postgresStore.js";
import { LocalRuntimeAuthority, localRuntimeAuthority, type RunStatus, type StoreEvent, type SubmissionReceipt } from "./store.js";
import type { ToolRequest } from "./protocol.js";
import type { ConversationMessage } from "./protocol.js";
import { normalizeBriefSnapshot, type BriefSnapshot } from "./brief.js";
import { ledgerEntry, steeredPayload, type ClaimedMessage, type LedgerEntry } from "./chat/messageLedger.js";

export const DEFAULT_RUN_LEASE_MS = 30_000;

/**
 * This control-plane view shares its commit authority with RuntimeStore:
 * one append-only local log, or one PostgreSQL connection transaction.
 * A submission commits its canonical transcript and control facts together.
 *
 * ConversationRepository is the small durable control-plane for those
 * questions. It owns immutable conversation binding, run identity, one active
 * run per conversation, and the cursor journal used to reconcile a client
 * after reconnecting. Tool invocations are intentionally not replayed from
 * this journal.
 */

export type ConversationStatus = "active" | "archived";
export type DurableRunStatus = RunStatus | "interrupted";

export type ConversationBinding = {
  ownerAccountId: string;
  creatorId: string;
  agentId: string;
  productId: string;
  corpusDigest: string;
};

export type ConversationRecord = ConversationBinding & {
  /** Private storage key. The server scopes it to the authenticated binding. */
  id: string;
  /** Opaque public ID returned to the Desktop. */
  publicId: string;
  productIdAtCreation: string;
  title?: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Immutable consumer answers captured when this Task was created. */
  briefSnapshot?: BriefSnapshot;
};

export type ConversationRunRecord = {
  id: string;
  conversationId: string;
  clientMessageId: string;
  /** Hash of the exact user content + structured attachments for idempotency. */
  inputDigest?: string;
  status: DurableRunStatus;
  corpusDigest: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  interruptedReason?: string;
  /** Opaque, Runtime-generated connection owner. Never supplied by Desktop. */
  executorId?: string;
  /** Renewed by the owning instance; another instance takes the Run over once it lapses. */
  executorLeaseExpiresAt?: string;
  /** User messages that joined this Run, and how many of them the Run has claimed. */
  steeredCount: number;
  consumedCount: number;
  /** Assistant text produced so far, saved periodically so a snapshot is never blank. */
  partialOutput?: string;
};

export type ToolCallOutcome =
  | { status: "ok"; result: Record<string, unknown> }
  | { status: "error"; error: { code: string; message: string } };

/**
 * A local-tool call a Run waits for. The record is the durable fact: any
 * instance can answer it, any instance can read the answer, and a Runtime that
 * restarts finds it again. It outlives neither its `expiresAt` nor its answer.
 */
export type ToolCallRecord = {
  runId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  approval: "none" | "auto" | "ask";
  scope?: ToolRequest["scope"];
  skillRunId?: string;
  requestedAt: string;
  expiresAt: string;
  outcome?: ToolCallOutcome;
  answeredAt?: string;
};

/** The one compaction running in a conversation, whichever instance runs it. */
export type CompactionClaim = {
  id: string;
  conversationId: string;
  executorId: string;
  leaseExpiresAt: string;
  /** A new message asked it to stop. */
  preempted: boolean;
  endedAt?: string;
};

type CompactedEvent = Extract<StoreEvent, { type: "conversation.compacted" }>;

/** `basis` makes the commit conditional: it fails if a Run started after the compaction began. */
export type CommitCompactionInput = {
  conversationId: string;
  compactionId: string;
  basis?: { latestRunId?: string };
  event: Omit<CompactedEvent, "timestamp">;
  /** The journal entry that tells observers, and the channel layer, this compaction completed. */
  journal: Record<string, unknown>;
};

export type ConversationJournalEvent = {
  /** Monotonically increasing within one repository. */
  cursor: number;
  conversationId: string;
  runId?: string;
  type: "conversation.created" | "conversation.updated" | "run.created" | "run.state" | "message.created" | "message.consumed" | "compaction.started" | "compaction.completed" | "compaction.aborted";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type ConversationSnapshot = {
  conversation: ConversationRecord;
  runs: ConversationRunRecord[];
  events: ConversationJournalEvent[];
  cursor: number;
};

export type ConversationListPage = {
  conversations: ConversationRecord[];
  nextCursor?: string;
};

export type ConversationJournalPage = {
  events: ConversationJournalEvent[];
  runs: ConversationRunRecord[];
  cursor: number;
  has_more: boolean;
  through_cursor: number;
};

export type CreateConversationInput = ConversationBinding & {
  id: string;
  publicId: string;
  title?: string;
  clientRequestId?: string;
  briefSnapshot?: BriefSnapshot;
};

export type CreateRunInput = {
  id: string;
  conversationId: string;
  clientMessageId: string;
  /** Runtime-computed; never supplied as trusted client authority. */
  inputDigest: string;
  corpusDigest: string;
  executorId?: string;
  executorLeaseExpiresAt?: string;
};

export type AcceptSubmissionInput = {
  binding: ConversationBinding;
  run: CreateRunInput;
  canonicalUser: ConversationMessage;
};
/**
 * Work that must commit with the accepted message, or not at all, such as binding the message's assets. It runs only for a
 * message that is new, inside the transaction that accepts it (`tx`), and a failure refuses the message.
 */
export type AlsoCommit = (tx?: PostgresQueryExecutor) => Promise<void>;
/** `created`: a new Run started. `steered`: the message joined the active Run. Neither: an idempotent replay. */
export type AcceptedSubmission = { created: boolean; steered?: boolean; run: ConversationRunRecord; receipt: SubmissionReceipt };

export function submissionEvents(input: AcceptSubmissionInput, timestamp: string): StoreEvent[] {
  if (input.canonicalUser.role !== "user") throw new Error("Submission must contain a canonical user message");
  return [{
    type: "conversation.model_message", conversation_id: input.run.conversationId,
    run_id: input.run.id, client_message_id: input.run.clientMessageId,
    message: structuredClone(input.canonicalUser), timestamp
  }, {
    type: "turn.state", conversation_id: input.run.conversationId,
    run_id: input.run.id, to: "queued", timestamp
  }];
}

export type UpdateConversationInput = {
  title?: string | null;
  status?: ConversationStatus;
  /** Optimistic concurrency token supplied by the client. */
  expectedVersion?: number;
};

export class ConversationRepositoryError extends Error {
  constructor(
    readonly code: "conversation_not_found" | "conversation_binding_mismatch" | "conversation_archived" | "conversation_busy" | "version_conflict" | "run_not_found" | "run_id_conflict" | "client_message_conflict" | "submission_not_accepted" | "steer_pending",
    message: string,
    readonly existingRun?: ConversationRunRecord
  ) {
    super(message);
    this.name = "ConversationRepositoryError";
  }
}

export interface ConversationRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createConversation(input: CreateConversationInput): Promise<{ conversation: ConversationRecord; created: boolean }>;
  getConversation(id: string): Promise<ConversationRecord | undefined>;
  /** Immutable createdAt DESC, id DESC order; cursors never track activity. */
  listConversations(binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">, options?: {
    status?: ConversationStatus;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationListPage>;
  updateConversation(id: string, input: UpdateConversationInput): Promise<ConversationRecord>;
  createRun(input: CreateRunInput): Promise<{ run: ConversationRunRecord; created: boolean }>;
  acceptSubmission(input: AcceptSubmissionInput, alsoCommit?: AlsoCommit): Promise<AcceptedSubmission>;
  getRun(conversationId: string, runId: string): Promise<ConversationRunRecord | undefined>;
  /** A Run by its id alone, for callers that know no conversation, such as the channel layer. */
  findRun(runId: string): Promise<ConversationRunRecord | undefined>;
  /** The journal cursor of the Run's newest `run.state` event: it names one stage of the Run, such as one compaction. */
  latestRunStateCursor(runId: string): Promise<number | undefined>;
  /** Lookup used to acknowledge a transport retry without starting tools again. */
  getRunByClientMessageId(conversationId: string, clientMessageId: string): Promise<ConversationRunRecord | undefined>;
  listRuns(conversationId: string): Promise<ConversationRunRecord[]>;
  /** Messages the owner has sent to this Agent across all conversations; failed runs are not counted. */
  countSentMessages(binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">): Promise<number>;
  transitionRun(runId: string, status: DurableRunStatus, reason?: string): Promise<ConversationRunRecord>;
  appendEvent(input: Omit<ConversationJournalEvent, "cursor" | "createdAt"> & { createdAt?: string }): Promise<ConversationJournalEvent>;
  snapshot(conversationId: string, afterCursor?: number): Promise<ConversationSnapshot>;
  /**
   * Capture high water before projections; call before reading history. Include
   * requested runs, the active run, and the latest run only if interrupted.
   */
  recoverySnapshot(conversationId: string, runIds: string[]): Promise<ConversationSnapshot>;
  /**
   * Replay (afterCursor, throughCursor], retaining through_cursor across pages.
   * Throw RangeError unless afterCursor <= throughCursor <= current high water.
   */
  journalPage(conversationId: string, afterCursor: number, throughCursor?: number, limit?: number): Promise<ConversationJournalPage>;
  /** Whether this client key was already accepted, so a retry needs no asset work. */
  hasAcceptedMessage(conversationId: string, clientMessageId: string): Promise<boolean>;
  /** The conversation's one active Run, if any. */
  getActiveRun(conversationId: string): Promise<ConversationRunRecord | undefined>;
  /**
   * Hands the Run its steered messages exactly once, in arrival order. Claiming and appending them to the
   * transcript is one transaction: a crash between the two can neither lose a message nor repeat it.
   */
  claimSteeredMessages(runId: string): Promise<ClaimedMessage[]>;
  /** Records a local-tool call before the client is asked, so the Run can wait across a restart. Idempotent. */
  requestToolCall(call: Omit<ToolCallRecord, "outcome" | "answeredAt">): Promise<void>;
  /** Stores a client's answer once. False when the call is unknown, already answered, or expired. */
  answerToolCall(runId: string, toolCallId: string, outcome: ToolCallOutcome): Promise<boolean>;
  listToolCalls(runId: string): Promise<ToolCallRecord[]>;
  /**
   * Takes the conversation's compaction claim. Not granted while a Run is active or another claim is live;
   * `latestRunId` is the Run the compaction's history ends with.
   */
  beginCompaction(input: { id: string; conversationId: string; executorId: string; leaseMs: number }): Promise<{ claimed: boolean; latestRunId?: string }>;
  /** Asks the running compaction to stop. False when none is running. */
  requestCompactionPreempt(conversationId: string): Promise<boolean>;
  /** True when the claim was preempted or has ended: the job must stop. */
  compactionStopped(compactionId: string): Promise<boolean>;
  runningCompaction(conversationId: string): Promise<CompactionClaim | undefined>;
  endCompaction(compactionId: string): Promise<void>;
  /** Appends the transcript checkpoint and the journal entry together, and ends the claim. False when stale. */
  commitCompaction(input: CommitCompactionInput): Promise<boolean>;
  savePartialOutput(runId: string, text: string): Promise<void>;
  /** Atomically takes over active Runs whose owner's lease lapsed. */
  claimOrphanedRuns(executorId: string, leaseMs: number): Promise<ConversationRunRecord[]>;
  /** False when the lease is no longer this executor's. */
  renewLease(runId: string, executorId: string, leaseMs: number): Promise<boolean>;
}

const ACTIVE_RUN_STATUSES = new Set<DurableRunStatus>([
  "queued",
  "running",
  "waiting_for_tool",
  "compacting"
]);

const TERMINAL_RUN_STATUSES = new Set<DurableRunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

function isActiveRun(status: DurableRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

function journalPageLimit(afterCursor: number, throughCursor: number | undefined, limit: number): number {
  for (const cursor of [afterCursor, throughCursor]) {
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      throw new RangeError("Journal cursors must be non-negative safe integers");
    }
  }
  if (!Number.isFinite(limit) || limit < 1) throw new RangeError("Journal limit must be positive and finite");
  return Math.min(500, Math.floor(limit));
}

function compareRuns(left: ConversationRunRecord, right: ConversationRunRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function journalThroughCursor(after: number, through: number | undefined, watermark: number): number {
  const upper = through ?? watermark;
  if (upper < after || upper > watermark) {
    throw new RangeError("Journal through_cursor must be between after_cursor and the current watermark");
  }
  return upper;
}

function now(): string {
  return new Date().toISOString();
}

function publicConversationEvent(conversation: ConversationRecord): Record<string, unknown> {
  return {
    id: conversation.publicId,
    creator_id: conversation.creatorId,
    agent_id: conversation.agentId,
    product_id_at_creation: conversation.productIdAtCreation,
    title: conversation.title,
    status: conversation.status,
    version: conversation.version,
    ...(conversation.briefSnapshot ? { brief_snapshot: conversation.briefSnapshot } : {})
  };
}

function publicRunEvent(run: ConversationRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    client_message_id: run.clientMessageId,
    ...(run.inputDigest ? { input_digest: run.inputDigest } : {}),
    status: run.status,
    corpus_digest: run.corpusDigest,
    ...(run.interruptedReason ? { reason: run.interruptedReason } : {})
  };
}

/**
 * Test and process-local implementation. It is also the state engine used by
 * FileConversationRepository, so the local fallback has identical locking and
 * idempotency semantics to production Postgres.
 */
export class InMemoryConversationRepository implements ConversationRepository {
  protected conversations = new Map<string, ConversationRecord>();
  protected runs = new Map<string, ConversationRunRecord>();
  protected events: ConversationJournalEvent[] = [];
  protected conversationRequests = new Map<string, string>();
  protected toolCalls = new Map<string, ToolCallRecord>();
  protected compactions = new Map<string, CompactionClaim>();
  protected nextCursor = 1;

  private pendingStoreEvents: StoreEvent[] = [];
  constructor(readonly localAuthority = new LocalRuntimeAuthority()) {}

  async initialize(): Promise<void> {
    await this.readReady();
  }

  async close(): Promise<void> {
    await this.localAuthority.close();
  }

  async createConversation(input: CreateConversationInput): Promise<{ conversation: ConversationRecord; created: boolean }> {
    return this.write(async () => {
      const briefSnapshot = input.briefSnapshot ? normalizeBriefSnapshot(input.briefSnapshot) : undefined;
      const normalizedInput = briefSnapshot ? { ...input, briefSnapshot } : input;
      const requestKey = input.clientRequestId ? conversationRequestKey(input, input.clientRequestId) : undefined;
      if (requestKey) {
        const existingId = this.conversationRequests.get(requestKey);
        if (existingId) {
          const existing = this.conversations.get(existingId);
          if (existing) {
            assertSameConversationBinding(existing, normalizedInput);
            return { conversation: cloneConversation(existing), created: false };
          }
        }
      }

      const existing = this.conversations.get(input.id);
      if (existing) {
        assertSameConversationBinding(existing, normalizedInput);
        return { conversation: cloneConversation(existing), created: false };
      }

      const createdAt = now();
      const conversation: ConversationRecord = {
        id: input.id,
        publicId: input.publicId,
        ownerAccountId: input.ownerAccountId,
        creatorId: input.creatorId,
        agentId: input.agentId,
        productId: input.productId,
        corpusDigest: input.corpusDigest,
        productIdAtCreation: input.productId,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        status: "active",
        createdAt,
        updatedAt: createdAt,
        version: 1,
        ...(briefSnapshot ? { briefSnapshot: structuredClone(briefSnapshot) } : {})
      };
      this.conversations.set(conversation.id, conversation);
      if (requestKey) this.conversationRequests.set(requestKey, conversation.id);
      this.appendEventUnsafe({
        conversationId: conversation.id,
        type: "conversation.created",
        payload: publicConversationEvent(conversation)
      });
      return { conversation: cloneConversation(conversation), created: true };
    });
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    await this.readReady();
    const conversation = this.conversations.get(id);
    return conversation ? cloneConversation(conversation) : undefined;
  }

  async listConversations(
    binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">,
    options: { status?: ConversationStatus; cursor?: string; limit?: number } = {}
  ): Promise<ConversationListPage> {
    await this.readReady();
    const limit = boundedLimit(options.limit);
    const cursor = decodeListCursor(options.cursor);
    const matching = [...this.conversations.values()]
      .filter((conversation) => (
        conversation.ownerAccountId === binding.ownerAccountId
        && conversation.creatorId === binding.creatorId
        && conversation.agentId === binding.agentId
        && (options.status === undefined || conversation.status === options.status)
      ))
      .sort(compareConversationNewestFirst)
      .filter((conversation) => !cursor || compareConversationPosition(conversation, cursor) < 0);
    const page = matching.slice(0, limit).map(cloneConversation);
    const last = page.at(-1);
    return {
      conversations: page,
      ...(matching.length > page.length && last ? { nextCursor: encodeListCursor(last) } : {})
    };
  }

  async updateConversation(id: string, input: UpdateConversationInput): Promise<ConversationRecord> {
    return this.write(async () => {
      const current = this.conversations.get(id);
      if (!current) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${id} was not found`);
      if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
        throw new ConversationRepositoryError("version_conflict", `Conversation ${current.publicId} has version ${current.version}`);
      }
      const title = input.title === null ? undefined : input.title?.trim();
      const changed = (input.title !== undefined && title !== current.title)
        || (input.status !== undefined && input.status !== current.status);
      if (!changed) return cloneConversation(current);
      const updated: ConversationRecord = {
        ...current,
        ...(input.title !== undefined ? (title ? { title } : {}) : {}),
        ...(input.title === null ? { title: undefined } : {}),
        ...(input.status ? { status: input.status } : {}),
        updatedAt: now(),
        version: current.version + 1
      };
      this.conversations.set(id, updated);
      this.appendEventUnsafe({
        conversationId: id,
        type: "conversation.updated",
        payload: publicConversationEvent(updated)
      });
      return cloneConversation(updated);
    });
  }

  async createRun(input: CreateRunInput): Promise<{ run: ConversationRunRecord; created: boolean }> {
    return this.write(() => this.createRunUnsafe(input));
  }

  async acceptSubmission(input: AcceptSubmissionInput, alsoCommit?: AlsoCommit): Promise<AcceptedSubmission> {
    input = structuredClone(input);
    return this.write(async () => {
      const conversation = this.conversations.get(input.run.conversationId);
      if (!conversation) throw new ConversationRepositoryError("conversation_not_found", "Conversation was not found");
      assertSameConversationBinding(conversation, input.binding);
      const key = input.run.clientMessageId;
      const steeredBefore = this.ledger(input.run.conversationId).find((entry) => entry.clientMessageId === key && entry.steered);
      if (steeredBefore) return this.replaySteered(steeredBefore, input);
      const existing = [...this.runs.values()].find((row) => row.conversationId === input.run.conversationId && row.clientMessageId === input.run.clientMessageId);
      if (existing) {
        assertSameRunInput(existing, input.run);
        const user = this.localAuthority.events.find((event) => event.type === "conversation.model_message"
          && event.conversation_id === existing.conversationId && event.run_id === existing.id
          && event.client_message_id === existing.clientMessageId && event.message.role === "user");
        if (!user) throw new ConversationRepositoryError("submission_not_accepted", "Historical run has no accepted submission; submit explicitly with a new client_message_id", existing);
        return { created: false, steered: false, run: cloneRun(existing), receipt: { run_id: existing.id, client_message_id: existing.clientMessageId, accepted_at: user.timestamp } };
      }
      const active = [...this.runs.values()].find((row) => row.conversationId === input.run.conversationId && isActiveRun(row.status));
      if (active) {
        await alsoCommit?.();
        const run = { ...active, steeredCount: active.steeredCount + 1 };
        this.runs.set(run.id, run);
        const event = this.appendEventUnsafe({ conversationId: run.conversationId, runId: run.id, type: "message.created",
          payload: steeredPayload(key, input.run.inputDigest, input.canonicalUser) });
        return { created: false, steered: true, run: cloneRun(run), receipt: { run_id: run.id, client_message_id: key, accepted_at: event.createdAt } };
      }
      await alsoCommit?.();
      const { run } = await this.createRunUnsafe(input.run);
      this.pendingStoreEvents = submissionEvents(input, run.createdAt);
      this.appendEventUnsafe({ conversationId: run.conversationId, runId: run.id, type: "message.created",
        payload: { role: "user", client_message_id: run.clientMessageId, input_digest: input.run.inputDigest }, createdAt: run.createdAt });
      return { created: true, steered: false, run, receipt: { run_id: run.id, client_message_id: run.clientMessageId, accepted_at: run.createdAt } };
    });
  }

  private ledger(conversationId: string): LedgerEntry[] {
    return [...this.localAuthority.journal, ...this.events]
      .filter((event) => event.conversationId === conversationId)
      .flatMap((event) => ledgerEntry(event) ?? []);
  }

  private replaySteered(entry: LedgerEntry, input: AcceptSubmissionInput): AcceptedSubmission {
    if (entry.digest !== input.run.inputDigest) {
      throw new ConversationRepositoryError("client_message_conflict", `client_message_id ${entry.clientMessageId} was already used with different user input`);
    }
    const run = this.runs.get(entry.runId!)!;
    return { created: false, steered: false, run: cloneRun(run), receipt: { run_id: run.id, client_message_id: entry.clientMessageId, accepted_at: entry.acceptedAt } };
  }

  async hasAcceptedMessage(conversationId: string, clientMessageId: string): Promise<boolean> {
    await this.readReady();
    return [...this.runs.values()].some((run) => run.conversationId === conversationId && run.clientMessageId === clientMessageId)
      || this.ledger(conversationId).some((entry) => entry.clientMessageId === clientMessageId);
  }

  async getActiveRun(conversationId: string): Promise<ConversationRunRecord | undefined> {
    await this.readReady();
    const run = [...this.runs.values()].find((row) => row.conversationId === conversationId && isActiveRun(row.status));
    return run ? cloneRun(run) : undefined;
  }

  async claimSteeredMessages(runId: string): Promise<ClaimedMessage[]> {
    return this.write(async () => {
      const run = this.runs.get(runId);
      if (!run || run.consumedCount >= run.steeredCount) return [];
      const steered = this.ledger(run.conversationId).filter((entry) => entry.runId === runId && entry.steered)
        .slice(run.consumedCount, run.steeredCount);
      this.runs.set(runId, { ...run, consumedCount: run.steeredCount });
      for (const entry of steered) {
        this.appendEventUnsafe({ conversationId: run.conversationId, runId, type: "message.consumed", payload: { client_message_id: entry.clientMessageId } });
        // The transcript append commits with the claim: the commit log is one transaction.
        this.pendingStoreEvents.push({ type: "conversation.model_message", conversation_id: run.conversationId, run_id: runId,
          client_message_id: entry.clientMessageId, message: entry.message!, timestamp: now() });
      }
      return steered.map((entry) => ({ clientMessageId: entry.clientMessageId, message: entry.message! }));
    });
  }

  async requestToolCall(call: Omit<ToolCallRecord, "outcome" | "answeredAt">): Promise<void> {
    await this.write(async () => {
      const key = `${call.runId}\n${call.toolCallId}`;
      if (!this.toolCalls.has(key)) this.toolCalls.set(key, structuredClone(call));
    });
  }

  async answerToolCall(runId: string, toolCallId: string, outcome: ToolCallOutcome): Promise<boolean> {
    return this.write(async () => {
      const key = `${runId}\n${toolCallId}`;
      const call = this.toolCalls.get(key);
      if (!call || call.outcome || Date.parse(call.expiresAt) <= Date.now()) return false;
      this.toolCalls.set(key, { ...call, outcome: structuredClone(outcome), answeredAt: now() });
      return true;
    });
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    await this.readReady();
    return [...this.toolCalls.values()].filter((call) => call.runId === runId).map((call) => structuredClone(call));
  }

  async beginCompaction(input: { id: string; conversationId: string; executorId: string; leaseMs: number }): Promise<{ claimed: boolean; latestRunId?: string }> {
    return this.write(async () => {
      const runs = [...this.runs.values()].filter((run) => run.conversationId === input.conversationId).sort(compareRuns);
      if (runs.some((run) => isActiveRun(run.status))) return { claimed: false };
      const running = [...this.compactions.values()].find((claim) => claim.conversationId === input.conversationId && !claim.endedAt);
      if (running && Date.parse(running.leaseExpiresAt) > Date.now()) return { claimed: false };
      if (running) this.compactions.set(running.id, { ...running, endedAt: now() });
      this.compactions.set(input.id, { id: input.id, conversationId: input.conversationId, executorId: input.executorId,
        leaseExpiresAt: new Date(Date.now() + input.leaseMs).toISOString(), preempted: false });
      return { claimed: true, ...(runs.at(-1) ? { latestRunId: runs.at(-1)!.id } : {}) };
    });
  }

  async requestCompactionPreempt(conversationId: string): Promise<boolean> {
    return this.write(async () => {
      const running = [...this.compactions.values()].find((claim) => claim.conversationId === conversationId && !claim.endedAt);
      if (!running) return false;
      this.compactions.set(running.id, { ...running, preempted: true });
      return true;
    });
  }

  async compactionStopped(compactionId: string): Promise<boolean> {
    await this.readReady();
    const claim = this.compactions.get(compactionId);
    return !claim || claim.preempted || claim.endedAt !== undefined;
  }

  async runningCompaction(conversationId: string): Promise<CompactionClaim | undefined> {
    await this.readReady();
    const running = [...this.compactions.values()].find((claim) => claim.conversationId === conversationId && !claim.endedAt && Date.parse(claim.leaseExpiresAt) > Date.now());
    return running ? { ...running } : undefined;
  }

  async endCompaction(compactionId: string): Promise<void> {
    await this.write(async () => {
      const claim = this.compactions.get(compactionId);
      if (claim && !claim.endedAt) this.compactions.set(compactionId, { ...claim, endedAt: now() });
    });
  }

  async commitCompaction(input: CommitCompactionInput): Promise<boolean> {
    return this.write(async () => {
      if (input.basis) {
        const runs = [...this.runs.values()].filter((run) => run.conversationId === input.conversationId).sort(compareRuns);
        if (runs.some((run) => isActiveRun(run.status)) || runs.at(-1)?.id !== input.basis.latestRunId) return false;
      }
      this.pendingStoreEvents.push({ ...input.event, timestamp: now() });
      this.appendEventUnsafe({ conversationId: input.conversationId, type: "compaction.completed", payload: input.journal });
      const claim = this.compactions.get(input.compactionId);
      if (claim && !claim.endedAt) this.compactions.set(claim.id, { ...claim, endedAt: now() });
      return true;
    });
  }

  async savePartialOutput(runId: string, text: string): Promise<void> {
    await this.write(async () => {
      const run = this.runs.get(runId);
      if (run && isActiveRun(run.status)) this.runs.set(runId, { ...run, partialOutput: text });
    });
  }

  async claimOrphanedRuns(executorId: string, leaseMs: number): Promise<ConversationRunRecord[]> {
    return this.write(async () => {
      const claimed: ConversationRunRecord[] = [];
      for (const run of this.runs.values()) {
        if (!isActiveRun(run.status) || run.executorId === executorId) continue;
        if (run.executorLeaseExpiresAt && Date.parse(run.executorLeaseExpiresAt) > Date.now()) continue;
        const next = { ...run, executorId, executorLeaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() };
        this.runs.set(run.id, next);
        claimed.push(cloneRun(next));
      }
      return claimed;
    });
  }

  async renewLease(runId: string, executorId: string, leaseMs: number): Promise<boolean> {
    return this.write(async () => {
      const run = this.runs.get(runId);
      if (!run || run.executorId !== executorId || !isActiveRun(run.status)) return false;
      this.runs.set(runId, { ...run, executorLeaseExpiresAt: new Date(Date.now() + leaseMs).toISOString() });
      return true;
    });
  }

  private async createRunUnsafe(input: CreateRunInput): Promise<{ run: ConversationRunRecord; created: boolean }> {
      const conversation = this.conversations.get(input.conversationId);
      if (!conversation) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${input.conversationId} was not found`);
      if (conversation.status === "archived") {
        throw new ConversationRepositoryError("conversation_archived", `Conversation ${conversation.publicId} is archived`);
      }
      const sameMessage = [...this.runs.values()].find((run) => (
        run.conversationId === input.conversationId && run.clientMessageId === input.clientMessageId
      ));
      if (sameMessage) {
        assertSameRunInput(sameMessage, input);
        return { run: cloneRun(sameMessage), created: false };
      }
      const existingById = this.runs.get(input.id);
      if (existingById) {
        if (existingById.conversationId !== input.conversationId || existingById.clientMessageId !== input.clientMessageId) {
          throw new ConversationRepositoryError("run_id_conflict", `Run ${input.id} already belongs to another message`);
        }
        assertSameRunInput(existingById, input);
        return { run: cloneRun(existingById), created: false };
      }
      const active = [...this.runs.values()].find((run) => run.conversationId === input.conversationId && isActiveRun(run.status));
      if (active) {
        throw new ConversationRepositoryError(
          "conversation_busy",
          `Conversation ${conversation.publicId} already has an active run: ${active.id}`,
          cloneRun(active)
        );
      }
      const run: ConversationRunRecord = {
        id: input.id,
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        inputDigest: input.inputDigest,
        status: "queued",
        corpusDigest: input.corpusDigest,
        createdAt: now(),
        steeredCount: 0,
        consumedCount: 0,
        ...(input.executorId ? { executorId: input.executorId } : {}),
        executorLeaseExpiresAt: input.executorLeaseExpiresAt ?? new Date(Date.now() + DEFAULT_RUN_LEASE_MS).toISOString()
      };
      this.runs.set(run.id, run);
      this.appendEventUnsafe({
        conversationId: run.conversationId,
        runId: run.id,
        type: "run.created",
        payload: publicRunEvent(run)
      });
      return { run: cloneRun(run), created: true };
  }

  async getRun(conversationId: string, runId: string): Promise<ConversationRunRecord | undefined> {
    await this.readReady();
    const run = this.runs.get(runId);
    return run?.conversationId === conversationId ? cloneRun(run) : undefined;
  }

  async findRun(runId: string): Promise<ConversationRunRecord | undefined> {
    await this.readReady();
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  async latestRunStateCursor(runId: string): Promise<number | undefined> {
    await this.readReady();
    return this.events.filter((event) => event.runId === runId && event.type === "run.state").at(-1)?.cursor;
  }

  async getRunByClientMessageId(conversationId: string, clientMessageId: string): Promise<ConversationRunRecord | undefined> {
    await this.readReady();
    const run = [...this.runs.values()].find((candidate) => (
      candidate.conversationId === conversationId && candidate.clientMessageId === clientMessageId
    ));
    return run ? cloneRun(run) : undefined;
  }

  async countSentMessages(binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">): Promise<number> {
    await this.readReady();
    return [...this.runs.values()].filter((run) => {
      const conversation = this.conversations.get(run.conversationId);
      return run.status !== "failed"
        && conversation?.ownerAccountId === binding.ownerAccountId
        && conversation.creatorId === binding.creatorId
        && conversation.agentId === binding.agentId;
    }).length;
  }

  async listRuns(conversationId: string): Promise<ConversationRunRecord[]> {
    await this.readReady();
    return [...this.runs.values()]
      .filter((run) => run.conversationId === conversationId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(cloneRun);
  }

  async transitionRun(runId: string, status: DurableRunStatus, reason?: string): Promise<ConversationRunRecord> {
    return this.write(async () => {
      const current = this.runs.get(runId);
      if (!current) throw new ConversationRepositoryError("run_not_found", `Run ${runId} was not found`);
      if (current.status === status) return cloneRun(current);
      if (TERMINAL_RUN_STATUSES.has(current.status)) return cloneRun(current);
      assertNoUnclaimedSteer(current, status);
      const timestamp = now();
      const updated: ConversationRunRecord = {
        ...current,
        status,
        ...(status === "running" && !current.startedAt ? { startedAt: timestamp } : {}),
        ...(TERMINAL_RUN_STATUSES.has(status) ? { completedAt: timestamp } : {}),
        ...(status === "interrupted" && reason ? { interruptedReason: reason } : {})
      };
      this.runs.set(runId, updated);
      this.appendEventUnsafe({
        conversationId: updated.conversationId,
        runId: updated.id,
        type: "run.state",
        payload: { ...publicRunEvent(updated), ...(reason ? { reason } : {}) }
      });
      return cloneRun(updated);
    });
  }

  async appendEvent(input: Omit<ConversationJournalEvent, "cursor" | "createdAt"> & { createdAt?: string }): Promise<ConversationJournalEvent> {
    return this.write(async () => this.appendEventUnsafe(input));
  }

  async snapshot(conversationId: string, afterCursor = 0): Promise<ConversationSnapshot> {
    await this.readReady();
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${conversationId} was not found`);
    const allEvents = this.events.filter((event) => event.conversationId === conversationId);
    const events = allEvents.filter((event) => event.cursor > afterCursor).map(cloneEvent);
    return {
      conversation: cloneConversation(conversation),
      runs: [...this.runs.values()]
        .filter((run) => run.conversationId === conversationId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .map(cloneRun),
      events,
      cursor: allEvents.at(-1)?.cursor ?? afterCursor
    };
  }

  async recoverySnapshot(conversationId: string, runIds: string[]): Promise<ConversationSnapshot> {
    await this.readReady();
    const cursor = this.latestCursor(conversationId);
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${conversationId} was not found`);
    const selected = new Map<string, ConversationRunRecord>();
    for (const id of runIds) {
      const run = this.runs.get(id);
      if (run?.conversationId === conversationId) selected.set(id, run);
    }
    let latest: ConversationRunRecord | undefined;
    for (const run of this.runs.values()) {
      if (run.conversationId !== conversationId) continue;
      if (isActiveRun(run.status)) selected.set(run.id, run);
      if (!latest || compareRuns(run, latest) > 0) latest = run;
    }
    if (latest?.status === "interrupted") selected.set(latest.id, latest);
    return { conversation: cloneConversation(conversation), runs: [...selected.values()].sort(compareRuns).map(cloneRun), cursor, events: [] };
  }

  async journalPage(conversationId: string, afterCursor: number, throughCursor?: number, limit = 100): Promise<ConversationJournalPage> {
    const pageLimit = journalPageLimit(afterCursor, throughCursor, limit);
    await this.readReady();
    if (!this.conversations.has(conversationId)) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${conversationId} was not found`);
    const through = journalThroughCursor(afterCursor, throughCursor, this.latestCursor(conversationId));
    const events: ConversationJournalEvent[] = [];
    let hasMore = false;
    for (const event of this.events) {
      if (event.cursor > through) break;
      if (event.conversationId !== conversationId || event.cursor <= afterCursor) continue;
      if (events.length === pageLimit) { hasMore = true; break; }
      events.push(cloneEvent(event));
    }
    const runs: ConversationRunRecord[] = [];
    for (const id of new Set(events.flatMap((event) => event.runId ? [event.runId] : []))) {
      const run = this.runs.get(id);
      if (run?.conversationId === conversationId) runs.push(cloneRun(run));
    }
    return { events, runs: runs.sort(compareRuns), cursor: events.at(-1)?.cursor ?? afterCursor, has_more: hasMore, through_cursor: through };
  }

  private latestCursor(conversationId: string): number {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const event = this.events[index]!;
      if (event.conversationId === conversationId) return event.cursor;
    }
    return 0;
  }

  private async readReady(): Promise<void> {
    await this.localAuthority.ready();
    // A read that lands while a write is staging must not replace the staged maps: that write would lose its changes.
    if (this.writing === 0) this.loadAuthority();
  }

  private writing = 0;

  private loadAuthority(): void {
    this.conversations = this.localAuthority.conversations;
    this.runs = this.localAuthority.runs;
    // Runs committed before steering existed carry no counters.
    for (const run of this.runs.values()) { run.steeredCount ??= 0; run.consumedCount ??= 0; }
    this.conversationRequests = this.localAuthority.requests;
    this.toolCalls = this.localAuthority.toolCalls;
    this.compactions = this.localAuthority.compactions;
    this.events = this.localAuthority.journal;
    this.nextCursor = (this.events.at(-1)?.cursor ?? 0) + 1;
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    return this.localAuthority.transact(async () => {
      this.writing += 1;
      this.loadAuthority();
      const beforeConversations = this.conversations;
      const beforeRuns = this.runs;
      const beforeRequests = this.conversationRequests;
      const beforeToolCalls = this.toolCalls;
      const beforeCompactions = this.compactions;
      // Stage control changes; history is not copied or rewritten per event.
      this.conversations = new Map(beforeConversations);
      this.runs = new Map(beforeRuns);
      this.conversationRequests = new Map(beforeRequests);
      this.toolCalls = new Map(beforeToolCalls);
      this.compactions = new Map(beforeCompactions);
      this.events = [];
      this.pendingStoreEvents = [];
      try {
        const result = await operation();
        const conversations = [...this.conversations.values()].filter((row) => beforeConversations.get(row.id) !== row);
        const runs = [...this.runs.values()].filter((row) => beforeRuns.get(row.id) !== row);
        const requests = [...this.conversationRequests].filter(([key, value]) => beforeRequests.get(key) !== value);
        const toolCalls = [...this.toolCalls.entries()].filter(([key, row]) => beforeToolCalls.get(key) !== row).map(([, row]) => row);
        const compactions = [...this.compactions.values()].filter((row) => beforeCompactions.get(row.id) !== row);
        const journal = this.events;
        const events = this.pendingStoreEvents;
        return { result, ...(conversations.length || runs.length || requests.length || journal.length || events.length || toolCalls.length || compactions.length ? {
          commit: { kind: events.length ? "accept" as const : "control" as const, conversations, runs, requests, journal, events, toolCalls, compactions }
        } : {}) };
      } finally {
        this.loadAuthority();
        this.pendingStoreEvents = [];
        this.writing -= 1;
      }
    });
  }

  private appendEventUnsafe(input: Omit<ConversationJournalEvent, "cursor" | "createdAt"> & { createdAt?: string }): ConversationJournalEvent {
    const createdAt = input.createdAt ?? now();
    const event: ConversationJournalEvent = {
      cursor: this.nextCursor++,
      conversationId: input.conversationId,
      ...(input.runId ? { runId: input.runId } : {}),
      type: input.type,
      payload: structuredClone(input.payload),
      createdAt
    };
    this.events.push(event);
    // Track activity independently of the immutable Library creation order.
    // Metadata `version` remains an optimistic-concurrency token for explicit
    // title/archive edits rather than changing for every streamed event.
    if (event.type !== "conversation.created") {
      const conversation = this.conversations.get(event.conversationId);
      if (conversation) {
        this.conversations.set(event.conversationId, { ...conversation, updatedAt: createdAt });
      }
    }
    return cloneEvent(event);
  }
}

/** File and transcript views share the same append-only commit authority. */
export class FileConversationRepository extends InMemoryConversationRepository {
  constructor(root = process.env.HATCH_RUNTIME_DATA_DIR ?? path.resolve(".hatch-runtime")) {
    super(localRuntimeAuthority(root));
  }
}

/**
 * Postgres backend. The partial unique index is the cross-process source of
 * truth for competing Run creation; the in-memory map in the WebSocket server
 * is only an optimisation for fast feedback. V1 recovery is intentionally
 * single-executor-process per repository; cross-process reclaim needs an
 * explicit renewable lease protocol rather than a startup sweep.
 */
export const POSTGRES_CONVERSATION_REPOSITORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_conversations (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  corpus_digest TEXT NOT NULL,
  product_id_at_creation TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  version INTEGER NOT NULL,
  client_request_id TEXT,
  brief_snapshot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, creator_id, agent_id, client_request_id)
);
ALTER TABLE hatch_conversations ADD COLUMN IF NOT EXISTS brief_snapshot JSONB;
CREATE INDEX IF NOT EXISTS hatch_conversations_library_created_idx
  ON hatch_conversations (owner_account_id, creator_id, agent_id, created_at DESC, id COLLATE "C" DESC);
DROP INDEX IF EXISTS hatch_conversations_library_idx;

CREATE TABLE IF NOT EXISTS hatch_conversation_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hatch_conversations(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_tool', 'compacting', 'completed', 'failed', 'cancelled', 'interrupted')),
  corpus_digest TEXT NOT NULL,
  executor_id TEXT,
  executor_lease_expires_at TIMESTAMPTZ,
  interrupted_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (conversation_id, client_message_id)
);
-- Existing repositories predate input_digest. Preserve their historical Runs
-- as nullable records: new Runs always write a digest, and legacy Runs remain
-- replayable rather than becoming unreadable during a rolling upgrade.
ALTER TABLE hatch_conversation_runs ADD COLUMN IF NOT EXISTS input_digest TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS hatch_conversation_one_active_run_idx
  ON hatch_conversation_runs (conversation_id)
  WHERE status IN ('queued', 'running', 'waiting_for_tool', 'compacting');
CREATE INDEX IF NOT EXISTS hatch_conversation_runs_conversation_idx
  ON hatch_conversation_runs (conversation_id, created_at ASC, id ASC);
ALTER TABLE hatch_conversation_runs ADD COLUMN IF NOT EXISTS steered_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hatch_conversation_runs ADD COLUMN IF NOT EXISTS consumed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hatch_conversation_runs ADD COLUMN IF NOT EXISTS partial_output TEXT;

CREATE TABLE IF NOT EXISTS hatch_conversation_journal (
  cursor BIGSERIAL PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hatch_conversations(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES hatch_conversation_runs(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hatch_conversation_journal_cursor_idx
  ON hatch_conversation_journal (conversation_id, cursor ASC);
-- Message-level idempotency: the database, not the caller, guarantees one user message per client key.
CREATE TABLE IF NOT EXISTS hatch_run_tool_calls (
  run_id TEXT NOT NULL REFERENCES hatch_conversation_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments JSONB NOT NULL,
  approval TEXT NOT NULL,
  scope TEXT,
  skill_run_id TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  outcome JSONB,
  answered_at TIMESTAMPTZ,
  PRIMARY KEY (run_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS hatch_conversation_compactions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES hatch_conversations(id) ON DELETE CASCADE,
  executor_id TEXT NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  preempted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ
);
-- Single flight across instances: the database allows one running compaction per conversation.
CREATE UNIQUE INDEX IF NOT EXISTS hatch_conversation_one_compaction_idx
  ON hatch_conversation_compactions (conversation_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hatch_conversation_user_message_key_idx
  ON hatch_conversation_journal (conversation_id, (payload->>'client_message_id'))
  WHERE event_type = 'message.created' AND payload->>'role' = 'user';
`;

export type PostgresConversationRepositoryOptions = {
  connectionString?: string;
  databaseUrl?: string;
  pool?: PostgresQueryExecutor;
  maxConnections?: number;
  environment?: NodeJS.ProcessEnv;
};

export class PostgresConversationRepository implements ConversationRepository {
  readonly pool: PostgresQueryExecutor;
  private readonly ownsPool: boolean;
  private schemaPromise: Promise<void> | undefined;
  private submissionStore?: PostgresStore;
  private transactional = false;

  bindSubmissionStore(store: PostgresStore): void {
    if (store.pool !== this.pool) throw new Error("Submission store and repository must share the same Postgres pool");
    this.submissionStore = store;
  }

  /** Only called inside a pinned-client transaction after both schemas are initialized. */
  static inTransaction(client: PostgresQueryExecutor): PostgresConversationRepository {
    const repository = new PostgresConversationRepository(client);
    repository.schemaPromise = Promise.resolve();
    repository.transactional = true;
    return repository;
  }

  async acceptSubmission(input: AcceptSubmissionInput, alsoCommit?: AlsoCommit): Promise<AcceptedSubmission> {
    if (!this.submissionStore) throw new Error("Atomic submission store is not configured");
    await this.initialize();
    // Steer-or-start: join the active Run, or start one. Losing the race to start
    // means a Run now exists, so the next pass steers it.
    for (let attempt = 0; ; attempt++) {
      const joined = await this.steerOrReplay(input, alsoCommit);
      if (joined) return joined;
      try {
        return await this.submissionStore.acceptSubmission(input, alsoCommit);
      } catch (error) {
        // Inside the submission transaction a unique violation (the single-active-run index) surfaces as run_id_conflict.
        const retry = error instanceof ConversationRepositoryError ? error.code === "conversation_busy" || error.code === "run_id_conflict" : isUniqueViolation(error);
        if (!retry || attempt >= 3) throw error;
      }
    }
  }

  /** One transaction under the conversation row lock; undefined means no Run is active to join. */
  private async steerOrReplay(input: AcceptSubmissionInput, alsoCommit?: AlsoCommit): Promise<AcceptedSubmission | undefined> {
    // Nothing to join and no earlier steer under this key: starting is the submission store's one transaction.
    const probe = await this.pool.query<{ joinable: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM hatch_conversation_runs WHERE conversation_id = $1 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting'))
        OR EXISTS (SELECT 1 FROM hatch_conversation_journal WHERE conversation_id = $1 AND event_type = 'message.created'
          AND payload->>'role' = 'user' AND payload->>'client_message_id' = $2 AND payload->>'steered' = 'true') AS joinable
    `, [input.run.conversationId, input.run.clientMessageId]);
    if (!probe.rows[0]?.joinable) return undefined;
    return this.inTransaction(async (repository) => {
      await repository.pool.query("SELECT id FROM hatch_conversations WHERE id = $1 FOR UPDATE", [input.run.conversationId]);
      const conversation = await repository.getConversation(input.run.conversationId);
      if (!conversation) throw new ConversationRepositoryError("conversation_not_found", "Conversation was not found");
      assertConversationBinding(conversation, input.binding);
      const key = input.run.clientMessageId;
      const prior = await repository.pool.query<JournalRow>(`
        SELECT * FROM hatch_conversation_journal
        WHERE conversation_id = $1 AND event_type = 'message.created' AND payload->>'role' = 'user' AND payload->>'client_message_id' = $2
      `, [input.run.conversationId, key]);
      const entry = prior.rows[0] ? ledgerEntry(eventFromRow(prior.rows[0])) : undefined;
      if (entry?.steered) {
        if (entry.digest !== input.run.inputDigest) {
          throw new ConversationRepositoryError("client_message_conflict", `client_message_id ${key} was already used with different user input`);
        }
        const run = await repository.getRun(input.run.conversationId, entry.runId!);
        return { created: false, steered: false, run: run!, receipt: { run_id: entry.runId!, client_message_id: key, accepted_at: entry.acceptedAt } };
      }
      if (entry) return undefined;
      const active = await repository.pool.query<RunRow>(`
        UPDATE hatch_conversation_runs SET steered_count = steered_count + 1
        WHERE conversation_id = $1 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
        RETURNING *
      `, [input.run.conversationId]);
      if (!active.rows[0]) return undefined;
      await alsoCommit?.(repository.pool);
      const run = runFromRow(active.rows[0]);
      const event = await repository.appendEvent({ conversationId: run.conversationId, runId: run.id, type: "message.created",
        payload: steeredPayload(key, input.run.inputDigest, input.canonicalUser) });
      return { created: false, steered: true, run, receipt: { run_id: run.id, client_message_id: key, accepted_at: event.createdAt } };
    });
  }

  private async inTransaction<T>(body: (repository: PostgresConversationRepository) => Promise<T>): Promise<T> {
    const pool = this.pool as PostgresQueryExecutor & { connect?: () => Promise<PostgresTransactionClient> };
    if (!pool.connect) throw new Error("Atomic steering requires a pinned Postgres connection");
    const client = await pool.connect();
    let failure: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await body(PostgresConversationRepository.inTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      try { await client.query("ROLLBACK"); } catch { /* an unacknowledged COMMIT is resolved by the unique ledger key on retry */ }
      throw error;
    } finally {
      client.release(failure);
    }
  }

  async hasAcceptedMessage(conversationId: string, clientMessageId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query<{ accepted: boolean }>(`
      SELECT EXISTS (SELECT 1 FROM hatch_conversation_runs WHERE conversation_id = $1 AND client_message_id = $2)
        OR EXISTS (SELECT 1 FROM hatch_conversation_journal WHERE conversation_id = $1 AND event_type = 'message.created'
          AND payload->>'role' = 'user' AND payload->>'client_message_id' = $2) AS accepted
    `, [conversationId, clientMessageId]);
    return result.rows[0]?.accepted === true;
  }

  async getActiveRun(conversationId: string): Promise<ConversationRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs
      WHERE conversation_id = $1 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
    `, [conversationId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async claimSteeredMessages(runId: string): Promise<ClaimedMessage[]> {
    await this.initialize();
    return this.inTransaction(async (repository) => {
      await repository.lockConversationOfRun(runId);
      const locked = await repository.pool.query<RunRow>("SELECT * FROM hatch_conversation_runs WHERE id = $1 FOR UPDATE", [runId]);
      const run = locked.rows[0] ? runFromRow(locked.rows[0]) : undefined;
      if (!run || run.consumedCount >= run.steeredCount) return [];
      const rows = await repository.pool.query<JournalRow>(`
        SELECT * FROM hatch_conversation_journal
        WHERE run_id = $1 AND event_type = 'message.created' AND payload->>'steered' = 'true'
        ORDER BY cursor ASC OFFSET $2 LIMIT $3
      `, [runId, run.consumedCount, run.steeredCount - run.consumedCount]);
      await repository.pool.query("UPDATE hatch_conversation_runs SET consumed_count = steered_count WHERE id = $1", [runId]);
      const claimed: ClaimedMessage[] = [];
      for (const row of rows.rows) {
        const entry = ledgerEntry(eventFromRow(row))!;
        await repository.appendEvent({ conversationId: run.conversationId, runId, type: "message.consumed", payload: { client_message_id: entry.clientMessageId } });
        // Same transaction as the claim above: a crash can neither lose the message nor append it twice.
        await this.requireSubmissionStore().appendOn(repository.pool, { type: "conversation.model_message", conversation_id: run.conversationId,
          run_id: runId, client_message_id: entry.clientMessageId, message: entry.message!, timestamp: new Date().toISOString() });
        claimed.push({ clientMessageId: entry.clientMessageId, message: entry.message! });
      }
      return claimed;
    });
  }

  private requireSubmissionStore(): PostgresStore {
    if (!this.submissionStore) throw new Error("Atomic submission store is not configured");
    return this.submissionStore;
  }

  async requestToolCall(call: Omit<ToolCallRecord, "outcome" | "answeredAt">): Promise<void> {
    await this.initialize();
    await this.pool.query(`
      INSERT INTO hatch_run_tool_calls (run_id, tool_call_id, name, arguments, approval, scope, skill_run_id, requested_at, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::timestamptz, $9::timestamptz)
      ON CONFLICT (run_id, tool_call_id) DO NOTHING
    `, [call.runId, call.toolCallId, call.name, JSON.stringify(call.arguments), call.approval, call.scope ?? null, call.skillRunId ?? null, call.requestedAt, call.expiresAt]);
  }

  async answerToolCall(runId: string, toolCallId: string, outcome: ToolCallOutcome): Promise<boolean> {
    await this.initialize();
    // The first answer wins and an expired call takes none: both are decided by this one statement.
    const result = await this.pool.query(`
      UPDATE hatch_run_tool_calls SET outcome = $3::jsonb, answered_at = now()
      WHERE run_id = $1 AND tool_call_id = $2 AND outcome IS NULL AND expires_at > now()
      RETURNING tool_call_id
    `, [runId, toolCallId, JSON.stringify(outcome)]);
    return result.rows.length > 0;
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    await this.initialize();
    const result = await this.pool.query<ToolCallRow>("SELECT * FROM hatch_run_tool_calls WHERE run_id = $1 ORDER BY requested_at, tool_call_id", [runId]);
    return result.rows.map((row) => ({
      runId: row.run_id, toolCallId: row.tool_call_id, name: row.name, arguments: row.arguments, approval: row.approval as ToolCallRecord["approval"],
      ...(row.scope ? { scope: row.scope as ToolCallRecord["scope"] } : {}), ...(row.skill_run_id ? { skillRunId: row.skill_run_id } : {}),
      requestedAt: new Date(row.requested_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString(),
      ...(row.outcome ? { outcome: row.outcome, answeredAt: new Date(row.answered_at!).toISOString() } : {})
    }));
  }

  async beginCompaction(input: { id: string; conversationId: string; executorId: string; leaseMs: number }): Promise<{ claimed: boolean; latestRunId?: string }> {
    await this.initialize();
    return this.inTransaction(async (repository) => {
      // The same lock a submission takes: either the Run starts first and there is nothing to compact now, or this claim does.
      await repository.pool.query("SELECT id FROM hatch_conversations WHERE id = $1 FOR UPDATE", [input.conversationId]);
      const runs = await repository.pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [input.conversationId]);
      if (runs.rows[0] && isActiveRun(runs.rows[0].status as DurableRunStatus)) return { claimed: false };
      await repository.pool.query("UPDATE hatch_conversation_compactions SET ended_at = now() WHERE conversation_id = $1 AND ended_at IS NULL AND lease_expires_at < now()", [input.conversationId]);
      const inserted = await repository.pool.query(`
        INSERT INTO hatch_conversation_compactions (id, conversation_id, executor_id, lease_expires_at)
        VALUES ($1, $2, $3, now() + ($4 * interval '1 millisecond')) ON CONFLICT DO NOTHING RETURNING id
      `, [input.id, input.conversationId, input.executorId, input.leaseMs]);
      return inserted.rows.length ? { claimed: true, ...(runs.rows[0] ? { latestRunId: runs.rows[0].id } : {}) } : { claimed: false };
    });
  }

  async requestCompactionPreempt(conversationId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query("UPDATE hatch_conversation_compactions SET preempted = true WHERE conversation_id = $1 AND ended_at IS NULL RETURNING id", [conversationId]);
    return result.rows.length > 0;
  }

  async compactionStopped(compactionId: string): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query<{ stopped: boolean }>("SELECT preempted OR ended_at IS NOT NULL AS stopped FROM hatch_conversation_compactions WHERE id = $1", [compactionId]);
    return result.rows[0]?.stopped ?? true;
  }

  async runningCompaction(conversationId: string): Promise<CompactionClaim | undefined> {
    await this.initialize();
    const result = await this.pool.query<CompactionRow>("SELECT * FROM hatch_conversation_compactions WHERE conversation_id = $1 AND ended_at IS NULL AND lease_expires_at > now()", [conversationId]);
    const row = result.rows[0];
    return row ? { id: row.id, conversationId: row.conversation_id, executorId: row.executor_id, leaseExpiresAt: new Date(row.lease_expires_at).toISOString(), preempted: row.preempted } : undefined;
  }

  async endCompaction(compactionId: string): Promise<void> {
    await this.initialize();
    await this.pool.query("UPDATE hatch_conversation_compactions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL", [compactionId]);
  }

  async commitCompaction(input: CommitCompactionInput): Promise<boolean> {
    await this.initialize();
    const store = this.requireSubmissionStore();
    return this.inTransaction(async (repository) => {
      await repository.pool.query("SELECT id FROM hatch_conversations WHERE id = $1 FOR UPDATE", [input.conversationId]);
      if (input.basis) {
        const latest = await repository.pool.query<{ id: string; status: string }>(
          "SELECT id, status FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1", [input.conversationId]);
        const row = latest.rows[0];
        if ((row && isActiveRun(row.status as DurableRunStatus)) || row?.id !== input.basis.latestRunId) return false;
      }
      await store.appendOn(repository.pool, { ...input.event, timestamp: new Date().toISOString() } as StoreEvent);
      await repository.appendEvent({ conversationId: input.conversationId, type: "compaction.completed", payload: input.journal });
      await repository.pool.query("UPDATE hatch_conversation_compactions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL", [input.compactionId]);
      return true;
    });
  }

  async savePartialOutput(runId: string, text: string): Promise<void> {
    await this.initialize();
    await this.pool.query(`
      UPDATE hatch_conversation_runs SET partial_output = $2
      WHERE id = $1 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
    `, [runId, text]);
  }

  async claimOrphanedRuns(executorId: string, leaseMs: number): Promise<ConversationRunRecord[]> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      UPDATE hatch_conversation_runs SET executor_id = $1, executor_lease_expires_at = now() + ($2 * interval '1 millisecond')
      WHERE id IN (
        SELECT id FROM hatch_conversation_runs
        WHERE status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
          AND executor_id IS DISTINCT FROM $1
          AND (executor_lease_expires_at IS NULL OR executor_lease_expires_at < now())
        FOR UPDATE SKIP LOCKED)
      RETURNING *
    `, [executorId, leaseMs]);
    return result.rows.map(runFromRow);
  }

  async renewLease(runId: string, executorId: string, leaseMs: number): Promise<boolean> {
    await this.initialize();
    const result = await this.pool.query(`
      UPDATE hatch_conversation_runs SET executor_lease_expires_at = now() + ($3 * interval '1 millisecond')
      WHERE id = $1 AND executor_id = $2 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
      RETURNING id
    `, [runId, executorId, leaseMs]);
    return result.rows.length > 0;
  }

  constructor(connectionString?: string);
  constructor(options?: PostgresConversationRepositoryOptions);
  constructor(pool: PostgresQueryExecutor);
  constructor(input: string | PostgresConversationRepositoryOptions | PostgresQueryExecutor = {}) {
    if (typeof input === "string") {
      this.pool = new Pool({ connectionString: input });
      this.ownsPool = true;
      return;
    }
    if (isQueryExecutor(input)) {
      this.pool = input;
      this.ownsPool = false;
      return;
    }
    if (input.pool) {
      this.pool = input.pool;
      this.ownsPool = false;
      return;
    }
    const environment = input.environment ?? process.env;
    const connectionString = input.connectionString
      ?? input.databaseUrl
      ?? environment.HATCH_RUNTIME_DATABASE_URL
      ?? environment.HATCH_REGISTRY_DATABASE_URL
      ?? environment.DATABASE_URL;
    if (!connectionString) throw new Error("Postgres conversation repository requires a database connection string");
    this.pool = new Pool({
      connectionString,
      ...(input.maxConnections === undefined ? {} : { max: input.maxConnections })
    });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA).then(() => undefined);
    }
    await this.schemaPromise;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }

  async createConversation(input: CreateConversationInput): Promise<{ conversation: ConversationRecord; created: boolean }> {
    await this.initialize();
    const briefSnapshot = input.briefSnapshot ? normalizeBriefSnapshot(input.briefSnapshot) : undefined;
    const normalizedInput = briefSnapshot ? { ...input, briefSnapshot } : input;
    if (input.clientRequestId) {
      const existing = await this.pool.query<ConversationRow>(`
        SELECT * FROM hatch_conversations
        WHERE owner_account_id = $1 AND creator_id = $2 AND agent_id = $3 AND client_request_id = $4
      `, [input.ownerAccountId, input.creatorId, input.agentId, input.clientRequestId]);
      if (existing.rows[0]) {
        const conversation = conversationFromRow(existing.rows[0]);
        assertSameConversationBinding(conversation, normalizedInput);
        return { conversation, created: false };
      }
    }
    const alreadyById = await this.getConversation(input.id);
    if (alreadyById) {
      assertSameConversationBinding(alreadyById, normalizedInput);
      return { conversation: alreadyById, created: false };
    }
    try {
      const result = await this.pool.query<ConversationRow>(`
        INSERT INTO hatch_conversations (
          id, public_id, owner_account_id, creator_id, agent_id, product_id, corpus_digest,
          product_id_at_creation, title, status, version, client_request_id, brief_snapshot
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 1, $10, $11::jsonb)
        RETURNING *
      `, [
        input.id, input.publicId, input.ownerAccountId, input.creatorId, input.agentId, input.productId,
        input.corpusDigest, input.productId, input.title?.trim() || null, input.clientRequestId ?? null,
        briefSnapshot ? JSON.stringify(briefSnapshot) : null
      ]);
      const conversation = conversationFromRow(requireRow(result.rows[0], "Conversation insert returned no row"));
      await this.appendEvent({
        conversationId: conversation.id,
        type: "conversation.created",
        payload: publicConversationEvent(conversation)
      });
      return { conversation, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (input.clientRequestId) {
        const existing = await this.pool.query<ConversationRow>(`
          SELECT * FROM hatch_conversations
          WHERE owner_account_id = $1 AND creator_id = $2 AND agent_id = $3 AND client_request_id = $4
        `, [input.ownerAccountId, input.creatorId, input.agentId, input.clientRequestId]);
        if (existing.rows[0]) {
          const conversation = conversationFromRow(existing.rows[0]);
          assertSameConversationBinding(conversation, normalizedInput);
          return { conversation, created: false };
        }
      }
      const byId = await this.getConversation(input.id);
      if (byId) {
        assertSameConversationBinding(byId, normalizedInput);
        return { conversation: byId, created: false };
      }
      throw error;
    }
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<ConversationRow>("SELECT * FROM hatch_conversations WHERE id = $1", [id]);
    return result.rows[0] ? conversationFromRow(result.rows[0]) : undefined;
  }

  async listConversations(
    binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">,
    options: { status?: ConversationStatus; cursor?: string; limit?: number } = {}
  ): Promise<ConversationListPage> {
    await this.initialize();
    const limit = boundedLimit(options.limit);
    const cursor = decodeListCursor(options.cursor);
    const values: unknown[] = [binding.ownerAccountId, binding.creatorId, binding.agentId, options.status ?? null];
    let pagination = "";
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      pagination = ' AND (created_at, id COLLATE "C") < ($5::timestamptz, $6::text COLLATE "C")';
    }
    values.push(limit + 1);
    const result = await this.pool.query<ConversationRow & { list_created_at: string }>(`
      SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS list_created_at
      FROM hatch_conversations
      WHERE owner_account_id = $1 AND creator_id = $2 AND agent_id = $3
        AND ($4::text IS NULL OR status = $4)${pagination}
      ORDER BY created_at DESC, id COLLATE "C" DESC
      LIMIT $${values.length}
    `, values);
    const rows = result.rows.map(conversationFromRow);
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit);
    const last = result.rows[conversations.length - 1];
    // pg parses timestamptz into millisecond Dates. Keep the exact database
    // timestamp for the cursor so rows within one millisecond are not skipped.
    return { conversations, ...(hasMore && last ? {
      nextCursor: encodeListCursor({ createdAt: last.list_created_at, id: last.id })
    } : {}) };
  }

  async updateConversation(id: string, input: UpdateConversationInput): Promise<ConversationRecord> {
    await this.initialize();
    const current = await this.getConversation(id);
    if (!current) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${id} was not found`);
    if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
      throw new ConversationRepositoryError("version_conflict", `Conversation ${current.publicId} has version ${current.version}`);
    }
    const nextTitle = input.title === undefined ? current.title : input.title?.trim() || undefined;
    const nextStatus = input.status ?? current.status;
    if (nextTitle === current.title && nextStatus === current.status) return current;
    const result = await this.pool.query<ConversationRow>(`
      UPDATE hatch_conversations
      SET title = $2, status = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $4
      RETURNING *
    `, [id, nextTitle ?? null, nextStatus, current.version]);
    if (!result.rows[0]) throw new ConversationRepositoryError("version_conflict", `Conversation ${current.publicId} changed concurrently`);
    const updated = conversationFromRow(result.rows[0]);
    await this.appendEvent({ conversationId: id, type: "conversation.updated", payload: publicConversationEvent(updated) });
    return updated;
  }

  async createRun(input: CreateRunInput): Promise<{ run: ConversationRunRecord; created: boolean }> {
    await this.initialize();
    const conversation = await this.getConversation(input.conversationId);
    if (!conversation) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${input.conversationId} was not found`);
    if (conversation.status === "archived") throw new ConversationRepositoryError("conversation_archived", `Conversation ${conversation.publicId} is archived`);
    const existing = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs WHERE conversation_id = $1 AND client_message_id = $2
    `, [input.conversationId, input.clientMessageId]);
    if (existing.rows[0]) {
      const run = runFromRow(existing.rows[0]);
      assertSameRunInput(run, input);
      return { run, created: false };
    }
    try {
      const result = await this.pool.query<RunRow>(`
        INSERT INTO hatch_conversation_runs (
          id, conversation_id, client_message_id, input_digest, status, corpus_digest, executor_id, executor_lease_expires_at
        ) VALUES ($1, $2, $3, $4, 'queued', $5, $6, COALESCE($7::timestamptz, now() + ($8 * interval '1 millisecond')))
        RETURNING *
      `, [
        input.id, input.conversationId, input.clientMessageId, input.inputDigest, input.corpusDigest,
        input.executorId ?? null, input.executorLeaseExpiresAt ?? null, DEFAULT_RUN_LEASE_MS
      ]);
      const run = runFromRow(requireRow(result.rows[0], "Run insert returned no row"));
      await this.appendEvent({ conversationId: run.conversationId, runId: run.id, type: "run.created", payload: publicRunEvent(run) });
      return { run, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (this.transactional) throw new ConversationRepositoryError("run_id_conflict", "Run ID is already in use");
      const duplicate = await this.pool.query<RunRow>(`
        SELECT * FROM hatch_conversation_runs WHERE conversation_id = $1 AND client_message_id = $2
      `, [input.conversationId, input.clientMessageId]);
      if (duplicate.rows[0]) {
        const run = runFromRow(duplicate.rows[0]);
        assertSameRunInput(run, input);
        return { run, created: false };
      }
      const active = await this.pool.query<RunRow>(`
        SELECT * FROM hatch_conversation_runs
        WHERE conversation_id = $1 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
        LIMIT 1
      `, [input.conversationId]);
      if (active.rows[0]) {
        const activeRun = runFromRow(active.rows[0]);
        throw new ConversationRepositoryError("conversation_busy", `Conversation ${conversation.publicId} already has an active run: ${activeRun.id}`, activeRun);
      }
      throw error;
    }
  }

  async getRun(conversationId: string, runId: string): Promise<ConversationRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs WHERE conversation_id = $1 AND id = $2
    `, [conversationId, runId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async findRun(runId: string): Promise<ConversationRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<RunRow>("SELECT * FROM hatch_conversation_runs WHERE id = $1", [runId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async latestRunStateCursor(runId: string): Promise<number | undefined> {
    await this.initialize();
    const result = await this.pool.query<{ cursor: string }>(`
      SELECT j.cursor FROM hatch_conversation_runs r JOIN hatch_conversation_journal j ON j.conversation_id = r.conversation_id
      WHERE r.id = $1 AND j.run_id = $1 AND j.event_type = 'run.state' ORDER BY j.cursor DESC LIMIT 1
    `, [runId]);
    return result.rows[0] ? Number(result.rows[0].cursor) : undefined;
  }

  async getRunByClientMessageId(conversationId: string, clientMessageId: string): Promise<ConversationRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs
      WHERE conversation_id = $1 AND client_message_id = $2
    `, [conversationId, clientMessageId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async countSentMessages(binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">): Promise<number> {
    await this.initialize();
    const result = await this.pool.query<{ count: string }>(`
      SELECT count(*) AS count
      FROM hatch_conversation_runs AS r
      JOIN hatch_conversations AS c ON c.id = r.conversation_id
      WHERE c.owner_account_id = $1 AND c.creator_id = $2 AND c.agent_id = $3 AND r.status <> 'failed'
    `, [binding.ownerAccountId, binding.creatorId, binding.agentId]);
    return Number(result.rows[0]?.count ?? 0);
  }

  async listRuns(conversationId: string): Promise<ConversationRunRecord[]> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC
    `, [conversationId]);
    return result.rows.map(runFromRow);
  }

  /**
   * The one lock order for everything that touches a Run next to its conversation: conversation row first, then Run row.
   * A steer, a claim and a Run-end transition therefore serialize instead of deadlocking.
   */
  private async lockConversationOfRun(runId: string): Promise<void> {
    await this.pool.query("SELECT c.id FROM hatch_conversations c WHERE c.id = (SELECT conversation_id FROM hatch_conversation_runs WHERE id = $1) FOR UPDATE", [runId]);
  }

  async transitionRun(runId: string, status: DurableRunStatus, reason?: string): Promise<ConversationRunRecord> {
    await this.initialize();
    return this.inTransaction(async (repository) => {
      await repository.lockConversationOfRun(runId);
      const currentResult = await repository.pool.query<RunRow>("SELECT * FROM hatch_conversation_runs WHERE id = $1 FOR UPDATE", [runId]);
      const currentRow = currentResult.rows[0];
      if (!currentRow) throw new ConversationRepositoryError("run_not_found", `Run ${runId} was not found`);
      const current = runFromRow(currentRow);
      if (current.status === status || TERMINAL_RUN_STATUSES.has(current.status)) return current;
      assertNoUnclaimedSteer(current, status);
      const result = await repository.pool.query<RunRow>(`
        UPDATE hatch_conversation_runs
        SET status = $2,
            started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
            completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled', 'interrupted') THEN now() ELSE completed_at END,
            interrupted_reason = CASE WHEN $2 = 'interrupted' THEN $3 ELSE interrupted_reason END
        WHERE id = $1
        RETURNING *
      `, [runId, status, reason ?? null]);
      const updated = runFromRow(result.rows[0]!);
      await repository.appendEvent({
        conversationId: updated.conversationId,
        runId: updated.id,
        type: "run.state",
        payload: { ...publicRunEvent(updated), ...(reason ? { reason } : {}) }
      });
      return updated;
    });
  }

  async appendEvent(input: Omit<ConversationJournalEvent, "cursor" | "createdAt"> & { createdAt?: string }): Promise<ConversationJournalEvent> {
    await this.initialize();
    const result = await this.pool.query<JournalRow>(`
      INSERT INTO hatch_conversation_journal (conversation_id, run_id, event_type, payload, created_at)
      VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, now()))
      RETURNING cursor, conversation_id, run_id, event_type, payload, created_at
    `, [input.conversationId, input.runId ?? null, input.type, JSON.stringify(input.payload), input.createdAt ?? null]);
    const event = eventFromRow(requireRow(result.rows[0], "Journal insert returned no row"));
    if (event.type !== "conversation.created") {
      await this.pool.query(
        "UPDATE hatch_conversations SET updated_at = $2::timestamptz WHERE id = $1",
        [event.conversationId, event.createdAt]
      );
    }
    return event;
  }

  async snapshot(conversationId: string, afterCursor = 0): Promise<ConversationSnapshot> {
    await this.initialize();
    const conversation = await this.getConversation(conversationId);
    if (!conversation) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${conversationId} was not found`);
    const [runs, journal] = await Promise.all([
      this.listRuns(conversationId),
      this.pool.query<JournalRow>(`
        SELECT cursor, conversation_id, run_id, event_type, payload, created_at
        FROM hatch_conversation_journal
        WHERE conversation_id = $1 AND cursor > $2
        ORDER BY cursor ASC
      `, [conversationId, afterCursor])
    ]);
    const events = journal.rows.map(eventFromRow);
    const cursor = events.at(-1)?.cursor ?? await this.latestCursor(conversationId, afterCursor);
    return { conversation, runs, events, cursor };
  }

  private async latestCursor(conversationId: string, fallback: number): Promise<number> {
    const result = await this.pool.query<{ cursor: string | number }>(`
      SELECT cursor FROM hatch_conversation_journal
      WHERE conversation_id = $1 ORDER BY cursor DESC LIMIT 1
    `, [conversationId]);
    return result.rows[0] ? Number(result.rows[0].cursor) : fallback;
  }

  async recoverySnapshot(conversationId: string, runIds: string[]): Promise<ConversationSnapshot> {
    await this.initialize();
    const cursor = await this.latestCursor(conversationId, 0);
    const conversation = await this.getConversation(conversationId);
    if (!conversation) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${conversationId} was not found`);
    const [requested, active, latest] = await Promise.all([
      this.runsByIds(conversationId, runIds),
      this.pool.query<RunRow>(`
        SELECT * FROM hatch_conversation_runs
        WHERE conversation_id = $1 AND status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
        LIMIT 1
      `, [conversationId]),
      this.pool.query<RunRow>(`
        SELECT * FROM hatch_conversation_runs
        WHERE conversation_id = $1
        ORDER BY created_at DESC, id DESC LIMIT 1
      `, [conversationId])
    ]);
    const runs = new Map(requested.map((run) => [run.id, run]));
    for (const row of active.rows) runs.set(row.id, runFromRow(row));
    if (latest.rows[0]?.status === "interrupted") runs.set(latest.rows[0].id, runFromRow(latest.rows[0]));
    return { conversation, runs: [...runs.values()].sort(compareRuns), cursor, events: [] };
  }

  async journalPage(conversationId: string, afterCursor: number, throughCursor?: number, limit = 100): Promise<ConversationJournalPage> {
    const pageLimit = journalPageLimit(afterCursor, throughCursor, limit);
    await this.initialize();
    const watermark = await this.latestCursor(conversationId, 0);
    if (!await this.getConversation(conversationId)) throw new ConversationRepositoryError("conversation_not_found", `Conversation ${conversationId} was not found`);
    const through = journalThroughCursor(afterCursor, throughCursor, watermark);
    const journal = await this.pool.query<JournalRow>(`
      SELECT cursor, conversation_id, run_id, event_type, payload, created_at
      FROM hatch_conversation_journal
      WHERE conversation_id = $1 AND cursor > $2 AND cursor <= $3
      ORDER BY cursor ASC LIMIT $4
    `, [conversationId, afterCursor, through, pageLimit + 1]);
    const events = journal.rows.slice(0, pageLimit).map(eventFromRow);
    const runs = await this.runsByIds(conversationId, events.flatMap((event) => event.runId ? [event.runId] : []));
    return { events, runs, cursor: events.at(-1)?.cursor ?? afterCursor, has_more: journal.rows.length > pageLimit, through_cursor: through };
  }

  private async runsByIds(conversationId: string, runIds: string[]): Promise<ConversationRunRecord[]> {
    const ids = [...new Set(runIds)];
    if (!ids.length) return [];
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs
      WHERE conversation_id = $1 AND id = ANY($2::text[])
      ORDER BY created_at ASC, id ASC LIMIT $3
    `, [conversationId, ids, ids.length]);
    return result.rows.map(runFromRow);
  }
}

type ConversationRow = QueryResultRow & {
  id: string;
  public_id: string;
  owner_account_id: string;
  creator_id: string;
  agent_id: string;
  product_id: string;
  corpus_digest: string;
  product_id_at_creation: string;
  title: string | null;
  status: ConversationStatus;
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
  brief_snapshot: BriefSnapshot | string | null;
};

type ToolCallRow = QueryResultRow & {
  run_id: string; tool_call_id: string; name: string; arguments: Record<string, unknown>; approval: string;
  scope: string | null; skill_run_id: string | null; requested_at: Date | string; expires_at: Date | string;
  outcome: ToolCallOutcome | null; answered_at: Date | string | null;
};

type CompactionRow = QueryResultRow & {
  id: string; conversation_id: string; executor_id: string; lease_expires_at: Date | string; preempted: boolean;
};

type RunRow = QueryResultRow & {
  id: string;
  conversation_id: string;
  client_message_id: string;
  input_digest: string | null;
  status: DurableRunStatus;
  corpus_digest: string;
  executor_id: string | null;
  executor_lease_expires_at: string | Date | null;
  interrupted_reason: string | null;
  created_at: string | Date;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  steered_count: number;
  consumed_count: number;
  partial_output: string | null;
};

type JournalRow = QueryResultRow & {
  cursor: string | number;
  conversation_id: string;
  run_id: string | null;
  event_type: ConversationJournalEvent["type"];
  payload: Record<string, unknown> | string;
  created_at: string | Date;
};

function conversationFromRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    publicId: row.public_id,
    ownerAccountId: row.owner_account_id,
    creatorId: row.creator_id,
    agentId: row.agent_id,
    productId: row.product_id,
    corpusDigest: row.corpus_digest,
    productIdAtCreation: row.product_id_at_creation,
    ...(row.title ? { title: row.title } : {}),
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: Number(row.version),
    ...(row.brief_snapshot ? { briefSnapshot: parseBriefSnapshot(row.brief_snapshot) } : {})
  };
}

function runFromRow(row: RunRow): ConversationRunRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    clientMessageId: row.client_message_id,
    ...(row.input_digest ? { inputDigest: row.input_digest } : {}),
    status: row.status,
    corpusDigest: row.corpus_digest,
    createdAt: iso(row.created_at),
    ...(row.started_at ? { startedAt: iso(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
    ...(row.interrupted_reason ? { interruptedReason: row.interrupted_reason } : {}),
    ...(row.executor_id ? { executorId: row.executor_id } : {}),
    ...(row.executor_lease_expires_at ? { executorLeaseExpiresAt: iso(row.executor_lease_expires_at) } : {}),
    steeredCount: Number(row.steered_count ?? 0),
    consumedCount: Number(row.consumed_count ?? 0),
    ...(row.partial_output ? { partialOutput: row.partial_output } : {})
  };
}

function eventFromRow(row: JournalRow): ConversationJournalEvent {
  return {
    cursor: Number(row.cursor),
    conversationId: row.conversation_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    type: row.event_type,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) as Record<string, unknown> : row.payload,
    createdAt: iso(row.created_at)
  };
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseBriefSnapshot(value: BriefSnapshot | string): BriefSnapshot {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return normalizeBriefSnapshot(parsed);
}

function isQueryExecutor(value: unknown): value is PostgresQueryExecutor {
  return typeof value === "object" && value !== null && "query" in value && typeof (value as { query?: unknown }).query === "function";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function conversationRequestKey(
  binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">,
  clientRequestId: string
): string {
  return [binding.ownerAccountId, binding.creatorId, binding.agentId, clientRequestId].join("\u0000");
}

function assertSameConversationBinding(existing: ConversationRecord, expected: ConversationBinding): void {
  if (
    existing.ownerAccountId !== expected.ownerAccountId
    || existing.creatorId !== expected.creatorId
    || existing.agentId !== expected.agentId
    || existing.productId !== expected.productId
  ) {
    throw new ConversationRepositoryError("conversation_binding_mismatch", "Conversation is outside the authenticated Expert Agent binding");
  }
  const expectedBrief = (expected as ConversationBinding & { briefSnapshot?: BriefSnapshot }).briefSnapshot;
  const existingBrief = existing.briefSnapshot;
  if (expectedBrief) {
    const sameBrief = Boolean(existingBrief)
      && expectedBrief.spec_digest === existingBrief!.spec_digest
      && JSON.stringify(expectedBrief.fields) === JSON.stringify(existingBrief!.fields);
    if (!sameBrief) {
      throw new ConversationRepositoryError("conversation_binding_mismatch", "Conversation BriefSnapshot does not match the original task");
    }
  }
}

function assertSameRunInput(existing: ConversationRunRecord, input: CreateRunInput): void {
  // Nullable digest is deliberately tolerated only for Runs written before
  // protocol 0.7. New Runs always carry one, so a reused idempotency key can
  // never silently point at different attachment content.
  if (existing.inputDigest && existing.inputDigest !== input.inputDigest) {
    throw new ConversationRepositoryError(
      "client_message_conflict",
      `client_message_id ${input.clientMessageId} was already used with different user input`,
      cloneRun(existing)
    );
  }
}

export function assertConversationBinding(
  conversation: ConversationRecord,
  binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId" | "productId">
): void {
  assertSameConversationBinding(conversation, binding as ConversationBinding);
}

function cloneConversation(conversation: ConversationRecord): ConversationRecord {
  return { ...conversation, ...(conversation.briefSnapshot ? { briefSnapshot: structuredClone(conversation.briefSnapshot) } : {}) };
}

/** The database-level rule: a Run is not complete while a message it accepted is unclaimed. */
function assertNoUnclaimedSteer(run: ConversationRunRecord, next: DurableRunStatus): void {
  if (next === "completed" && run.consumedCount < run.steeredCount) {
    throw new ConversationRepositoryError("steer_pending", `Run ${run.id} still has ${run.steeredCount - run.consumedCount} unclaimed message(s)`, run);
  }
}

function cloneRun(run: ConversationRunRecord): ConversationRunRecord {
  return { ...run };
}

function cloneEvent(event: ConversationJournalEvent): ConversationJournalEvent {
  return { ...event, payload: structuredClone(event.payload) };
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) return 50;
  return value;
}

type ListCursor = { createdAt: string; id: string };

function encodeListCursor(conversation: ListCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: conversation.createdAt, id: conversation.id }), "utf8").toString("base64url");
}

function decodeListCursor(value: string | undefined): ListCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ListCursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string" || !parsed.id
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(parsed.createdAt)
      || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("Invalid creation cursor");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    // updatedAt cursors belong to the retired activity order, not this list.
    throw new RangeError("Invalid conversation list cursor; restart pagination without a cursor");
  }
}

function compareConversationNewestFirst(left: ConversationRecord, right: ConversationRecord): number {
  return -compareConversationPosition(left, right);
}

function compareConversationPosition(conversation: ConversationRecord, cursor: ListCursor): number {
  // Pad fractional seconds to match Postgres precision; UTF-8 byte order
  // matches COLLATE "C", independently of the host/database locale.
  const timestamp = (value: string) => value.slice(0, -1).padEnd(26, "0");
  return Buffer.compare(Buffer.from(timestamp(conversation.createdAt)), Buffer.from(timestamp(cursor.createdAt)))
    || Buffer.compare(Buffer.from(conversation.id), Buffer.from(cursor.id));
}
