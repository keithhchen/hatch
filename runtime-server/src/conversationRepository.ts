import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type QueryResultRow } from "pg";
import type { PostgresQueryExecutor } from "./postgresStore.js";
import type { RunStatus } from "./store.js";

/**
 * This module is deliberately separate from RuntimeStore. RuntimeStore is an
 * append-only transcript projection; it is useful for rendering history but
 * cannot safely answer ownership, idempotency, or recovery questions.
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
  /** Reserved for a future renewable cross-process lease protocol; unused in V1. */
  executorLeaseExpiresAt?: string;
};

export type ConversationJournalEvent = {
  /** Monotonically increasing within one repository. */
  cursor: number;
  conversationId: string;
  runId?: string;
  type: "conversation.created" | "conversation.updated" | "run.created" | "run.state" | "message.created";
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

export type CreateConversationInput = ConversationBinding & {
  id: string;
  publicId: string;
  title?: string;
  clientRequestId?: string;
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

export type UpdateConversationInput = {
  title?: string | null;
  status?: ConversationStatus;
  /** Optimistic concurrency token supplied by the client. */
  expectedVersion?: number;
};

export class ConversationRepositoryError extends Error {
  constructor(
    readonly code: "conversation_not_found" | "conversation_binding_mismatch" | "conversation_archived" | "conversation_busy" | "version_conflict" | "run_not_found" | "run_id_conflict" | "client_message_conflict",
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
  listConversations(binding: Pick<ConversationBinding, "ownerAccountId" | "creatorId" | "agentId">, options?: {
    status?: ConversationStatus;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationListPage>;
  updateConversation(id: string, input: UpdateConversationInput): Promise<ConversationRecord>;
  createRun(input: CreateRunInput): Promise<{ run: ConversationRunRecord; created: boolean }>;
  getRun(conversationId: string, runId: string): Promise<ConversationRunRecord | undefined>;
  /** Lookup used to acknowledge a transport retry without starting tools again. */
  getRunByClientMessageId(conversationId: string, clientMessageId: string): Promise<ConversationRunRecord | undefined>;
  listRuns(conversationId: string): Promise<ConversationRunRecord[]>;
  transitionRun(runId: string, status: DurableRunStatus, reason?: string): Promise<ConversationRunRecord>;
  appendEvent(input: Omit<ConversationJournalEvent, "cursor" | "createdAt"> & { createdAt?: string }): Promise<ConversationJournalEvent>;
  snapshot(conversationId: string, afterCursor?: number): Promise<ConversationSnapshot>;
  /**
   * V1 recovery never resurrects work from a lost executor. Pending tool calls
   * become Interrupted; a future attach/reclaim protocol must mint a new lease
   * and must not replay effects from this Run.
   */
  interruptActiveRuns(reason: string): Promise<ConversationRunRecord[]>;
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
    version: conversation.version
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
  protected nextCursor = 1;

  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.writeChain;
  }

  async createConversation(input: CreateConversationInput): Promise<{ conversation: ConversationRecord; created: boolean }> {
    return this.write(async () => {
      const requestKey = input.clientRequestId ? conversationRequestKey(input, input.clientRequestId) : undefined;
      if (requestKey) {
        const existingId = this.conversationRequests.get(requestKey);
        if (existingId) {
          const existing = this.conversations.get(existingId);
          if (existing) return { conversation: cloneConversation(existing), created: false };
        }
      }

      const existing = this.conversations.get(input.id);
      if (existing) {
        assertSameConversationBinding(existing, input);
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
        version: 1
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
    return this.write(async () => {
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
        ...(input.executorId ? { executorId: input.executorId } : {}),
        ...(input.executorLeaseExpiresAt ? { executorLeaseExpiresAt: input.executorLeaseExpiresAt } : {})
      };
      this.runs.set(run.id, run);
      this.appendEventUnsafe({
        conversationId: run.conversationId,
        runId: run.id,
        type: "run.created",
        payload: publicRunEvent(run)
      });
      return { run: cloneRun(run), created: true };
    });
  }

  async getRun(conversationId: string, runId: string): Promise<ConversationRunRecord | undefined> {
    await this.readReady();
    const run = this.runs.get(runId);
    return run?.conversationId === conversationId ? cloneRun(run) : undefined;
  }

  async getRunByClientMessageId(conversationId: string, clientMessageId: string): Promise<ConversationRunRecord | undefined> {
    await this.readReady();
    const run = [...this.runs.values()].find((candidate) => (
      candidate.conversationId === conversationId && candidate.clientMessageId === clientMessageId
    ));
    return run ? cloneRun(run) : undefined;
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

  async interruptActiveRuns(reason: string): Promise<ConversationRunRecord[]> {
    return this.write(async () => {
      const interrupted: ConversationRunRecord[] = [];
      for (const run of this.runs.values()) {
        if (!isActiveRun(run.status)) continue;
        const timestamp = now();
        const next: ConversationRunRecord = {
          ...run,
          status: "interrupted",
          completedAt: timestamp,
          interruptedReason: reason
        };
        this.runs.set(run.id, next);
        this.appendEventUnsafe({
          conversationId: next.conversationId,
          runId: next.id,
          type: "run.state",
          payload: { ...publicRunEvent(next), reason }
        });
        interrupted.push(cloneRun(next));
      }
      return interrupted;
    });
  }

  protected async persist(): Promise<void> {
    // Memory implementation intentionally has no persistence target.
  }

  protected serialize(): SerializedConversationRepository {
    return {
      format: 1,
      nextCursor: this.nextCursor,
      conversations: [...this.conversations.values()],
      runs: [...this.runs.values()],
      events: this.events,
      conversationRequests: [...this.conversationRequests.entries()]
    };
  }

  protected hydrate(serialized: SerializedConversationRepository): void {
    if (serialized.format !== 1) throw new Error(`Unsupported conversation repository format: ${serialized.format}`);
    this.nextCursor = Math.max(1, serialized.nextCursor);
    this.conversations = new Map(serialized.conversations.map((conversation) => [conversation.id, conversation]));
    this.runs = new Map(serialized.runs.map((run) => [run.id, run]));
    this.events = serialized.events;
    this.conversationRequests = new Map(serialized.conversationRequests);
  }

  private async readReady(): Promise<void> {
    await this.ensureInitialized();
    await this.writeChain;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    let result: T | undefined;
    const write = this.writeChain.then(async () => {
      result = await operation();
      await this.persist();
    });
    this.writeChain = write.catch(() => undefined);
    await write;
    if (result === undefined) throw new Error("Conversation repository write did not produce a result");
    return result;
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
    // Library ordering follows the latest durable Conversation activity, but
    // metadata `version` remains an optimistic-concurrency token for explicit
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

type SerializedConversationRepository = {
  format: 1;
  nextCursor: number;
  conversations: ConversationRecord[];
  runs: ConversationRunRecord[];
  events: ConversationJournalEvent[];
  conversationRequests: Array<[string, string]>;
};

/**
 * Local development fallback. It writes a small control-plane document next
 * to RuntimeStore's event transcript, but never attempts to derive recovery
 * state from events.jsonl.
 */
export class FileConversationRepository extends InMemoryConversationRepository {
  private loadPromise: Promise<void> | undefined;

  constructor(private readonly root = process.env.HATCH_RUNTIME_DATA_DIR ?? path.resolve(".hatch-runtime")) {
    super();
  }

  override async initialize(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        await mkdir(this.root, { recursive: true });
        const file = path.join(this.root, "conversations-v1.json");
        const contents = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (contents) this.hydrate(JSON.parse(contents) as SerializedConversationRepository);
        await super.initialize();
      })();
    }
    await this.loadPromise;
  }

  protected override async persist(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const file = path.join(this.root, "conversations-v1.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.serialize())}\n`, "utf8");
    await rename(temporary, file);
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_account_id, creator_id, agent_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS hatch_conversations_library_idx
  ON hatch_conversations (owner_account_id, creator_id, agent_id, updated_at DESC, id DESC);

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
    if (input.clientRequestId) {
      const existing = await this.pool.query<ConversationRow>(`
        SELECT * FROM hatch_conversations
        WHERE owner_account_id = $1 AND creator_id = $2 AND agent_id = $3 AND client_request_id = $4
      `, [input.ownerAccountId, input.creatorId, input.agentId, input.clientRequestId]);
      if (existing.rows[0]) return { conversation: conversationFromRow(existing.rows[0]), created: false };
    }
    const alreadyById = await this.getConversation(input.id);
    if (alreadyById) {
      assertSameConversationBinding(alreadyById, input);
      return { conversation: alreadyById, created: false };
    }
    try {
      const result = await this.pool.query<ConversationRow>(`
        INSERT INTO hatch_conversations (
          id, public_id, owner_account_id, creator_id, agent_id, product_id, corpus_digest,
          product_id_at_creation, title, status, version, client_request_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', 1, $10)
        RETURNING *
      `, [
        input.id, input.publicId, input.ownerAccountId, input.creatorId, input.agentId, input.productId,
        input.corpusDigest, input.productId, input.title?.trim() || null, input.clientRequestId ?? null
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
        if (existing.rows[0]) return { conversation: conversationFromRow(existing.rows[0]), created: false };
      }
      const byId = await this.getConversation(input.id);
      if (byId) return { conversation: byId, created: false };
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
      values.push(cursor.updatedAt, cursor.id);
      pagination = " AND (updated_at, id) < ($5::timestamptz, $6)";
    }
    values.push(limit + 1);
    const result = await this.pool.query<ConversationRow>(`
      SELECT * FROM hatch_conversations
      WHERE owner_account_id = $1 AND creator_id = $2 AND agent_id = $3
        AND ($4::text IS NULL OR status = $4)${pagination}
      ORDER BY updated_at DESC, id DESC
      LIMIT $${values.length}
    `, values);
    const rows = result.rows.map(conversationFromRow);
    const hasMore = rows.length > limit;
    const conversations = rows.slice(0, limit);
    const last = conversations.at(-1);
    return { conversations, ...(hasMore && last ? { nextCursor: encodeListCursor(last) } : {}) };
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
        ) VALUES ($1, $2, $3, $4, 'queued', $5, $6, $7)
        RETURNING *
      `, [
        input.id, input.conversationId, input.clientMessageId, input.inputDigest, input.corpusDigest,
        input.executorId ?? null, input.executorLeaseExpiresAt ?? null
      ]);
      const run = runFromRow(requireRow(result.rows[0], "Run insert returned no row"));
      await this.appendEvent({ conversationId: run.conversationId, runId: run.id, type: "run.created", payload: publicRunEvent(run) });
      return { run, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
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

  async getRunByClientMessageId(conversationId: string, clientMessageId: string): Promise<ConversationRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs
      WHERE conversation_id = $1 AND client_message_id = $2
    `, [conversationId, clientMessageId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async listRuns(conversationId: string): Promise<ConversationRunRecord[]> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      SELECT * FROM hatch_conversation_runs WHERE conversation_id = $1 ORDER BY created_at ASC, id ASC
    `, [conversationId]);
    return result.rows.map(runFromRow);
  }

  async transitionRun(runId: string, status: DurableRunStatus, reason?: string): Promise<ConversationRunRecord> {
    await this.initialize();
    const currentResult = await this.pool.query<RunRow>("SELECT * FROM hatch_conversation_runs WHERE id = $1", [runId]);
    const currentRow = currentResult.rows[0];
    if (!currentRow) throw new ConversationRepositoryError("run_not_found", `Run ${runId} was not found`);
    const current = runFromRow(currentRow);
    if (current.status === status || TERMINAL_RUN_STATUSES.has(current.status)) return current;
    const result = await this.pool.query<RunRow>(`
      UPDATE hatch_conversation_runs
      SET status = $2,
          started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
          completed_at = CASE WHEN $2 IN ('completed', 'failed', 'cancelled', 'interrupted') THEN now() ELSE completed_at END,
          interrupted_reason = CASE WHEN $2 = 'interrupted' THEN $3 ELSE interrupted_reason END
      WHERE id = $1
      RETURNING *
    `, [runId, status, reason ?? null]);
    const updated = runFromRow(requireRow(result.rows[0], `Run ${runId} update returned no row`));
    await this.appendEvent({
      conversationId: updated.conversationId,
      runId: updated.id,
      type: "run.state",
      payload: { ...publicRunEvent(updated), ...(reason ? { reason } : {}) }
    });
    return updated;
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

  async interruptActiveRuns(reason: string): Promise<ConversationRunRecord[]> {
    await this.initialize();
    const result = await this.pool.query<RunRow>(`
      UPDATE hatch_conversation_runs
      SET status = 'interrupted', completed_at = now(), interrupted_reason = $1
      WHERE status IN ('queued', 'running', 'waiting_for_tool', 'compacting')
      RETURNING *
    `, [reason]);
    const runs = result.rows.map(runFromRow);
    for (const run of runs) {
      await this.appendEvent({
        conversationId: run.conversationId,
        runId: run.id,
        type: "run.state",
        payload: { ...publicRunEvent(run), reason }
      });
    }
    return runs;
  }

  private async latestCursor(conversationId: string, fallback: number): Promise<number> {
    const result = await this.pool.query<{ cursor: string | number }>(`
      SELECT cursor FROM hatch_conversation_journal
      WHERE conversation_id = $1 ORDER BY cursor DESC LIMIT 1
    `, [conversationId]);
    return result.rows[0] ? Number(result.rows[0].cursor) : fallback;
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
    version: Number(row.version)
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
    ...(row.executor_lease_expires_at ? { executorLeaseExpiresAt: iso(row.executor_lease_expires_at) } : {})
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
    throw new ConversationRepositoryError("conversation_binding_mismatch", "Conversation is outside the authenticated Creator Agent binding");
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
  return { ...conversation };
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

type ListCursor = { updatedAt: string; id: string };

function encodeListCursor(conversation: Pick<ConversationRecord, "updatedAt" | "id">): string {
  return Buffer.from(JSON.stringify({ updatedAt: conversation.updatedAt, id: conversation.id }), "utf8").toString("base64url");
}

function decodeListCursor(value: string | undefined): ListCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ListCursor>;
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string" || Number.isNaN(Date.parse(parsed.updatedAt))) return undefined;
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch {
    return undefined;
  }
}

function compareConversationNewestFirst(left: ConversationRecord, right: ConversationRecord): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id);
}

function compareConversationPosition(conversation: ConversationRecord, cursor: ListCursor): number {
  return conversation.updatedAt.localeCompare(cursor.updatedAt) || conversation.id.localeCompare(cursor.id);
}
