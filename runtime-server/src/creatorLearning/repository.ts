import { createHash, randomUUID } from "node:crypto";
import { Pool, type QueryResultRow } from "pg";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import { requireQuestionBatchId } from "./questionBatch.js";
import type { FactoryRunState, FactoryStage, FactoryStartInput } from "./types.js";
import type { CreateCreatorProductInput, CreatorProductRecord, CreatorProductRepository } from "./products.js";
import { validateProductText } from "./products.js";
import { normalizeBriefSpec, type BriefSpec } from "../brief.js";

/**
 * Durable control-plane state for Creator Factory work.
 *
 * Semantic artifacts (Evidence, QA, evaluations, Corpus candidates) remain in
 * FactoryFileStore. This repository stores only enough input and workflow
 * state to recover, schedule, and fence a worker after a process restart.
 */

export type FactoryControlStatus =
  | "queued"
  | "running"
  | "waiting_for_creator"
  | "ready"
  | "needs_attention";

export type PendingCreatorAnswers = {
  /** Legacy CLI transport; new API submissions use structured answers. */
  answerMarkdown?: string;
  answers?: Array<{ questionId: string; answer: string }>;
  /** Optional client-generated key retained for audit and retry diagnosis. */
  submissionId?: string;
  /** Run-scoped ID of the sealed Question batch these answers belong to. */
  questionBatchId?: string;
  submittedAt?: string;
};

export type SaveFactoryAnswerDraftInput = {
  creatorId: string;
  runId: string;
  answers: PendingCreatorAnswers;
  expectedVersion?: number;
  now?: string;
};

type AnswerSubmissionReceipt = {
  answerDigest: string;
  questionBatchId?: string;
  submittedAt: string;
};

export type FactoryRunRecord = {
  id: string;
  creatorId: string;
  idempotencyKey: string;
  input: FactoryStartInput;
  status: FactoryControlStatus;
  factoryStage?: FactoryStage;
  state?: FactoryRunState;
  pendingAnswers?: PendingCreatorAnswers;
  /** Durable, partial Creator answers kept while the UI advances a carousel. */
  answerDrafts?: PendingCreatorAnswers;
  version: number;
  nextAttemptAt?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateFactoryRunInput = {
  id: string;
  creatorId: string;
  idempotencyKey: string;
  input: FactoryStartInput;
  nextAttemptAt?: string;
};

export type ClaimFactoryRunInput = {
  workerId: string;
  leaseMs?: number;
  /** Injectable clock boundary for deterministic workers and tests. */
  now?: string;
};

export type FactoryLeaseInput = {
  runId: string;
  workerId: string;
  leaseToken: string;
  now?: string;
};

export type HeartbeatFactoryRunInput = FactoryLeaseInput & {
  leaseMs?: number;
};

export type SubmitFactoryAnswersInput = {
  creatorId: string;
  runId: string;
  answers: PendingCreatorAnswers;
  expectedVersion?: number;
  now?: string;
};

export type RetryFactoryRunInput = {
  creatorId: string;
  runId: string;
  expectedVersion?: number;
  now?: string;
};

export type CompleteFactoryRunInput = FactoryLeaseInput & {
  state: FactoryRunState;
};

export type FailFactoryRunInput = FactoryLeaseInput & {
  error: string;
  /** Preferred production retry policy, measured from the repository/database clock. */
  retryDelayMs?: number;
  /** Legacy absolute override retained for deterministic tests and compatibility. */
  nextAttemptAt?: string;
};

export class CreatorFactoryRepositoryError extends Error {
  constructor(
    readonly code:
      | "run_not_found"
      | "run_id_conflict"
      | "idempotency_conflict"
      | "creator_mismatch"
      | "version_conflict"
      | "invalid_status"
      | "invalid_stage"
      | "lease_lost",
    message: string
  ) {
    super(message);
    this.name = "CreatorFactoryRepositoryError";
  }
}

export interface CreatorFactoryRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
  create(input: CreateFactoryRunInput): Promise<{ run: FactoryRunRecord; created: boolean }>;
  getForCreator(creatorId: string, runId: string): Promise<FactoryRunRecord | undefined>;
  listForCreator(creatorId: string): Promise<FactoryRunRecord[]>;
  claim(input: ClaimFactoryRunInput): Promise<FactoryRunRecord | undefined>;
  /** Cheap fencing check used before committing filesystem artifacts. */
  assertLease(input: FactoryLeaseInput): Promise<void>;
  heartbeat(input: HeartbeatFactoryRunInput): Promise<FactoryRunRecord>;
  submitAnswers(input: SubmitFactoryAnswersInput): Promise<FactoryRunRecord>;
  saveAnswerDraft(input: SaveFactoryAnswerDraftInput): Promise<FactoryRunRecord>;
  retry(input: RetryFactoryRunInput): Promise<FactoryRunRecord>;
  complete(input: CompleteFactoryRunInput): Promise<FactoryRunRecord>;
  fail(input: FailFactoryRunInput): Promise<FactoryRunRecord>;
}

const DEFAULT_LEASE_MS = 60_000;

export class InMemoryCreatorFactoryRepository implements CreatorFactoryRepository, CreatorProductRepository {
  private readonly runs = new Map<string, FactoryRunRecord>();
  private readonly products = new Map<string, CreatorProductRecord>();
  private readonly idempotency = new Map<string, { runId: string; inputDigest: string }>();
  private readonly inputDigests = new Map<string, string>();
  private readonly answerSubmissions = new Map<string, Map<string, AnswerSubmissionReceipt>>();
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {}

  async close(): Promise<void> {
    await this.writeChain;
  }

  async createProduct(input: CreateCreatorProductInput): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const id = requireNonEmpty(input.id, "product.id");
      if (this.products.has(id)) throw new CreatorFactoryRepositoryError("run_id_conflict", `Product ${id} already exists`);
      const now = new Date().toISOString();
      const product: CreatorProductRecord = {
        id,
        creatorId: requireNonEmpty(input.creatorId, "product.creatorId"),
        name: validateProductText(input.name, "product.name", 240),
        promise: validateProductText(input.promise, "product.promise"),
        brief: validateProductText(input.promise, "product.promise"),
        status: "active",
        createdAt: now,
        updatedAt: now
      };
      this.products.set(id, product);
      return cloneJson(product);
    });
  }

  async getProduct(creatorId: string, productId: string): Promise<CreatorProductRecord | undefined> {
    await this.writeChain;
    const product = this.products.get(productId);
    return product?.creatorId === creatorId ? cloneJson(product) : undefined;
  }

  async listProducts(creatorId: string): Promise<CreatorProductRecord[]> {
    await this.writeChain;
    return [...this.products.values()]
      .filter((product) => product.creatorId === creatorId && product.status !== "deleted")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(cloneJson);
  }

  async updateProductPromise(creatorId: string, productId: string, input: { promise: string; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Product ${productId} was not found`);
      if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
      if (input.expectedUpdatedAt && product.updatedAt !== input.expectedUpdatedAt) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
      }
      const promise = validateProductText(input.promise, "product.promise");
      product.promise = promise;
      product.brief = promise;
      product.updatedAt = new Date().toISOString();
      return cloneJson(product);
    });
  }

  async saveBriefSpec(creatorId: string, productId: string, input: { briefSpec: BriefSpec; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Product ${productId} was not found`);
      if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
      if (input.expectedUpdatedAt && product.updatedAt !== input.expectedUpdatedAt) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
      }
      product.briefSpec = normalizeBriefSpec(input.briefSpec);
      product.updatedAt = new Date().toISOString();
      return cloneJson(product);
    });
  }

  async softDeleteProduct(creatorId: string, productId: string): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      const now = new Date().toISOString();
      product.status = "deleted";
      product.deletedAt = now;
      product.updatedAt = now;
      return cloneJson(product);
    });
  }

  async setProductRevision(creatorId: string, productId: string, input: { runId: string; revisionId: string }): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Product ${productId} was not found`);
      if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
      if (product.runId && product.runId !== input.runId) throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} already belongs to another Run`);
      product.runId = requireNonEmpty(input.runId, "product.runId");
      product.latestRevisionId = requireNonEmpty(input.revisionId, "product.latestRevisionId");
      product.updatedAt = new Date().toISOString();
      return cloneJson(product);
    });
  }

  async create(input: CreateFactoryRunInput): Promise<{ run: FactoryRunRecord; created: boolean }> {
    return this.write(async () => {
      const normalized = normalizeCreateInput(input);
      const inputDigest = factoryInputDigest(normalized.input);
      const requestKey = idempotencyMapKey(normalized.creatorId, normalized.idempotencyKey);
      const request = this.idempotency.get(requestKey);
      if (request) {
        assertIdempotentDigest(request.inputDigest, inputDigest, normalized.idempotencyKey);
        const replay = this.runs.get(request.runId);
        if (replay) return { run: cloneRun(replay), created: false };
      }

      const byId = this.runs.get(normalized.id);
      if (byId) {
        if (byId.creatorId !== normalized.creatorId || byId.idempotencyKey !== normalized.idempotencyKey) {
          throw new CreatorFactoryRepositoryError("run_id_conflict", `Factory run ${normalized.id} already exists`);
        }
        assertIdempotentDigest(this.inputDigests.get(byId.id) ?? factoryInputDigest(byId.input), inputDigest, normalized.idempotencyKey);
        return { run: cloneRun(byId), created: false };
      }

      const createdAt = new Date().toISOString();
      const run: FactoryRunRecord = {
        id: normalized.id,
        creatorId: normalized.creatorId,
        idempotencyKey: normalized.idempotencyKey,
        input: cloneJson(normalized.input),
        status: "queued",
        version: 1,
        nextAttemptAt: normalized.nextAttemptAt ?? createdAt,
        attempts: 0,
        createdAt,
        updatedAt: createdAt
      };
      this.runs.set(run.id, run);
      this.inputDigests.set(run.id, inputDigest);
      this.idempotency.set(requestKey, { runId: run.id, inputDigest });
      return { run: cloneRun(run), created: true };
    });
  }

  async getForCreator(creatorId: string, runId: string): Promise<FactoryRunRecord | undefined> {
    await this.writeChain;
    const run = this.runs.get(runId);
    return run?.creatorId === creatorId ? cloneRun(run) : undefined;
  }

  async listForCreator(creatorId: string): Promise<FactoryRunRecord[]> {
    await this.writeChain;
    return [...this.runs.values()]
      .filter((run) => run.creatorId === creatorId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(cloneRun);
  }

  async claim(input: ClaimFactoryRunInput): Promise<FactoryRunRecord | undefined> {
    return this.write(async () => {
      const workerId = requireNonEmpty(input.workerId, "workerId");
      const now = parsedNow(input.now);
      const leaseExpiresAt = addMilliseconds(now, boundedLeaseMs(input.leaseMs));
      const candidate = [...this.runs.values()]
        .filter((run) => isClaimable(run, now))
        .sort(compareClaimOrder)[0];
      if (!candidate) return undefined;
      candidate.status = "running";
      candidate.leaseOwner = workerId;
      candidate.leaseToken = randomUUID();
      candidate.leaseExpiresAt = leaseExpiresAt;
      candidate.attempts += 1;
      candidate.version += 1;
      candidate.updatedAt = iso(now);
      return cloneRun(candidate);
    });
  }

  async heartbeat(input: HeartbeatFactoryRunInput): Promise<FactoryRunRecord> {
    return this.write(async () => {
      const now = parsedNow(input.now);
      const run = this.requireLease(input, now);
      run.leaseExpiresAt = addMilliseconds(now, boundedLeaseMs(input.leaseMs));
      run.version += 1;
      run.updatedAt = iso(now);
      return cloneRun(run);
    });
  }

  async assertLease(input: FactoryLeaseInput): Promise<void> {
    await this.writeChain;
    this.requireLease(input, parsedNow(input.now));
  }

  async submitAnswers(input: SubmitFactoryAnswersInput): Promise<FactoryRunRecord> {
    return this.write(async () => {
      const run = this.runs.get(input.runId);
      if (!run || run.creatorId !== input.creatorId) {
        throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${input.runId} was not found`);
      }
      const now = parsedNow(input.now);
      const answers = normalizeAnswers(input.answers, now);
      const submissionId = answers.submissionId;
      const answerDigest = answerPayloadDigest(answers);
      if (submissionId) {
        const existing = this.answerSubmissions.get(run.id)?.get(submissionId);
        if (existing) {
          assertIdempotentDigest(existing.answerDigest, answerDigest, submissionId);
          return cloneRun(run);
        }
      }
      assertQuestionBatchMatch(run, answers.questionBatchId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Factory run ${run.id} is at version ${run.version}`);
      }
      if (run.status !== "waiting_for_creator") {
        throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${run.id} is not waiting for Creator answers`);
      }
      run.pendingAnswers = answers;
      if (submissionId) {
        let submissions = this.answerSubmissions.get(run.id);
        if (!submissions) {
          submissions = new Map();
          this.answerSubmissions.set(run.id, submissions);
        }
        submissions.set(submissionId, {
          answerDigest,
          questionBatchId: answers.questionBatchId,
          submittedAt: answers.submittedAt ?? iso(now)
        });
      }
      run.status = "queued";
      run.nextAttemptAt = iso(now);
      run.lastError = undefined;
      run.version += 1;
      run.updatedAt = iso(now);
      return cloneRun(run);
    });
  }

  async saveAnswerDraft(input: SaveFactoryAnswerDraftInput): Promise<FactoryRunRecord> {
    return this.write(async () => {
      const run = this.runs.get(input.runId);
      if (!run || run.creatorId !== input.creatorId) {
        throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${input.runId} was not found`);
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Factory run ${run.id} is at version ${run.version}`);
      }
      if (run.status !== "waiting_for_creator" || run.state?.stage !== "awaiting_creator_answers") {
        throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${run.id} is not waiting for Creator answers`);
      }
      const questionBatchId = requireNonEmpty(input.answers.questionBatchId ?? "", "question_batch_id");
      assertQuestionBatchMatch(run, questionBatchId);
      const normalized = normalizeAnswers(input.answers, parsedNow(input.now));
      run.answerDrafts = normalized;
      run.version += 1;
      run.updatedAt = iso(parsedNow(input.now));
      return cloneRun(run);
    });
  }

  async retry(input: RetryFactoryRunInput): Promise<FactoryRunRecord> {
    return this.write(async () => {
      const run = this.runs.get(input.runId);
      if (!run || run.creatorId !== input.creatorId) {
        throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${input.runId} was not found`);
      }
      if (input.expectedVersion !== undefined && input.expectedVersion !== run.version) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Factory run ${run.id} is at version ${run.version}`);
      }
      if (run.status !== "needs_attention") {
        throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${run.id} does not need attention`);
      }
      const now = parsedNow(input.now);
      run.status = "queued";
      run.nextAttemptAt = iso(now);
      run.lastError = undefined;
      run.version += 1;
      run.updatedAt = iso(now);
      return cloneRun(run);
    });
  }

  async complete(input: CompleteFactoryRunInput): Promise<FactoryRunRecord> {
    return this.write(async () => {
      const now = parsedNow(input.now);
      const run = this.requireLease(input, now);
      const status = completedStatus(input.state.stage);
      run.status = status;
      run.factoryStage = input.state.stage;
      run.state = cloneJson(input.state);
      run.pendingAnswers = undefined;
      run.answerDrafts = undefined;
      run.nextAttemptAt = undefined;
      run.leaseOwner = undefined;
      run.leaseToken = undefined;
      run.leaseExpiresAt = undefined;
      run.lastError = status === "needs_attention" ? input.state.lastError : undefined;
      run.version += 1;
      run.updatedAt = iso(now);
      return cloneRun(run);
    });
  }

  async fail(input: FailFactoryRunInput): Promise<FactoryRunRecord> {
    return this.write(async () => {
      const now = parsedNow(input.now);
      const run = this.requireLease(input, now);
      run.status = "queued";
      run.nextAttemptAt = input.retryDelayMs === undefined
        ? iso(input.nextAttemptAt ?? now)
        : addMilliseconds(now, boundedRetryDelayMs(input.retryDelayMs));
      run.leaseOwner = undefined;
      run.leaseToken = undefined;
      run.leaseExpiresAt = undefined;
      run.lastError = requireNonEmpty(input.error, "error");
      run.version += 1;
      run.updatedAt = iso(now);
      return cloneRun(run);
    });
  }

  private requireLease(input: FactoryLeaseInput, now: Date): FactoryRunRecord {
    const run = this.runs.get(input.runId);
    if (
      !run
      || run.status !== "running"
      || run.leaseOwner !== input.workerId
      || run.leaseToken !== input.leaseToken
      || !run.leaseExpiresAt
      || Date.parse(run.leaseExpiresAt) <= now.getTime()
    ) {
      throw new CreatorFactoryRepositoryError("lease_lost", `Factory run ${input.runId} lease is no longer owned by this worker`);
    }
    return run;
  }

  private async write<T>(operation: () => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeChain = this.writeChain.then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.writeChain;
    return result;
  }
}

export const POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_creator_products (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  promise TEXT NOT NULL,
  -- Read-only migration column for databases created before Product-only.
  brief TEXT,
  brief_spec JSONB,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')) DEFAULT 'active',
  run_id TEXT,
  latest_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hatch_creator_products_creator_idx
  ON hatch_creator_products (creator_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS hatch_creator_factory_runs (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  input_jsonb JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_creator', 'ready', 'needs_attention')),
  factory_stage TEXT,
  state_summary JSONB,
  pending_answers JSONB,
  answer_drafts JSONB,
  answer_submissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMPTZ,
  lease_owner TEXT,
  lease_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (creator_id, idempotency_key)
);
ALTER TABLE hatch_creator_factory_runs
  ADD COLUMN IF NOT EXISTS input_digest TEXT;
ALTER TABLE hatch_creator_factory_runs
  ADD COLUMN IF NOT EXISTS answer_submissions JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE hatch_creator_factory_runs
  ADD COLUMN IF NOT EXISTS answer_drafts JSONB;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS latest_revision_id TEXT;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS promise TEXT;
UPDATE hatch_creator_products
SET promise = brief
WHERE promise IS NULL AND brief IS NOT NULL;
ALTER TABLE hatch_creator_products
  ALTER COLUMN brief DROP NOT NULL;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS brief_spec JSONB;
CREATE INDEX IF NOT EXISTS hatch_creator_factory_claim_idx
  ON hatch_creator_factory_runs (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'running');
`;

export type PostgresCreatorFactoryRepositoryOptions = {
  connectionString?: string;
  databaseUrl?: string;
  pool?: PostgresQueryExecutor;
  maxConnections?: number;
  environment?: NodeJS.ProcessEnv;
};

export class PostgresCreatorFactoryRepository implements CreatorFactoryRepository {
  readonly pool: PostgresQueryExecutor;
  private readonly ownsPool: boolean;
  private schemaPromise: Promise<void> | undefined;

  constructor(connectionString: string);
  constructor(options?: PostgresCreatorFactoryRepositoryOptions);
  constructor(pool: PostgresQueryExecutor);
  constructor(input: string | PostgresCreatorFactoryRepositoryOptions | PostgresQueryExecutor = {}) {
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
      ?? environment.HATCH_FACTORY_DATABASE_URL
      ?? environment.HATCH_RUNTIME_DATABASE_URL
      ?? environment.HATCH_REGISTRY_DATABASE_URL
      ?? environment.DATABASE_URL;
    if (!connectionString) throw new Error("Postgres Creator Factory repository requires a database connection string");
    this.pool = new Pool({
      connectionString,
      ...(input.maxConnections === undefined ? {} : { max: input.maxConnections })
    });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA).then(() => undefined);
    }
    await this.schemaPromise;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }

  async createProduct(input: CreateCreatorProductInput): Promise<CreatorProductRecord> {
    await this.initialize();
    const id = requireNonEmpty(input.id, "product.id");
    const creatorId = requireNonEmpty(input.creatorId, "product.creatorId");
    const name = validateProductText(input.name, "product.name", 240);
    const promise = validateProductText(input.promise, "product.promise");
    const result = await this.pool.query<ProductRow>(`
      INSERT INTO hatch_creator_products (id, creator_id, name, promise)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `, [id, creatorId, name, promise]);
    return productFromRow(requireRow(result.rows[0], "Product insert returned no row"));
  }

  async getProduct(creatorId: string, productId: string): Promise<CreatorProductRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      SELECT * FROM hatch_creator_products WHERE id = $1 AND creator_id = $2
    `, [productId, creatorId]);
    return result.rows[0] ? productFromRow(result.rows[0]) : undefined;
  }

  async listProducts(creatorId: string): Promise<CreatorProductRecord[]> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      SELECT * FROM hatch_creator_products
      WHERE creator_id = $1 AND status = 'active'
      ORDER BY updated_at DESC, id ASC
    `, [creatorId]);
    return result.rows.map(productFromRow);
  }

  async updateProductPromise(creatorId: string, productId: string, input: { promise: string; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    await this.initialize();
    const promise = validateProductText(input.promise, "product.promise");
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET promise = $3, updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2 AND status = 'active'
        AND ($4::timestamptz IS NULL OR updated_at = $4::timestamptz)
      RETURNING *
    `, [productId, creatorId, promise, input.expectedUpdatedAt ?? null]);
    if (!result.rows[0]) {
      const current = await this.getProduct(creatorId, productId);
      if (!current) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
    }
    return productFromRow(result.rows[0]);
  }

  async saveBriefSpec(creatorId: string, productId: string, input: { briefSpec: BriefSpec; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    await this.initialize();
    const briefSpec = normalizeBriefSpec(input.briefSpec);
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET brief_spec = $3::jsonb, updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2 AND status = 'active'
        AND ($4::timestamptz IS NULL OR updated_at = $4::timestamptz)
      RETURNING *
    `, [productId, creatorId, JSON.stringify(briefSpec), input.expectedUpdatedAt ?? null]);
    if (!result.rows[0]) {
      const current = await this.getProduct(creatorId, productId);
      if (!current) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
    }
    return productFromRow(result.rows[0]);
  }

  async softDeleteProduct(creatorId: string, productId: string): Promise<CreatorProductRecord> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET status = 'deleted', deleted_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2
      RETURNING *
    `, [productId, creatorId]);
    if (!result.rows[0]) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
    return productFromRow(result.rows[0]);
  }

  async setProductRevision(creatorId: string, productId: string, input: { runId: string; revisionId: string }): Promise<CreatorProductRecord> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET run_id = COALESCE(run_id, $3), latest_revision_id = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2 AND status = 'active'
        AND (run_id IS NULL OR run_id = $3)
      RETURNING *
    `, [productId, creatorId, requireNonEmpty(input.runId, "product.runId"), requireNonEmpty(input.revisionId, "product.latestRevisionId")]);
    if (!result.rows[0]) throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} cannot advance its Revision`);
    return productFromRow(result.rows[0]);
  }

  async create(input: CreateFactoryRunInput): Promise<{ run: FactoryRunRecord; created: boolean }> {
    await this.initialize();
    const normalized = normalizeCreateInput(input);
    const inputDigest = factoryInputDigest(normalized.input);
    const replay = await this.findRowByIdempotency(normalized.creatorId, normalized.idempotencyKey);
    if (replay) {
      assertIdempotentDigest(rowInputDigest(replay), inputDigest, normalized.idempotencyKey);
      return { run: runFromRow(replay), created: false };
    }
    try {
      const result = await this.pool.query<FactoryRunRow>(`
        INSERT INTO hatch_creator_factory_runs (
          id, creator_id, idempotency_key, input_digest, input_jsonb, status, version, next_attempt_at, attempts
        ) VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', 1, COALESCE($6::timestamptz, clock_timestamp()), 0)
        RETURNING *
      `, [
        normalized.id,
        normalized.creatorId,
        normalized.idempotencyKey,
        inputDigest,
        JSON.stringify(normalized.input),
        normalized.nextAttemptAt ?? null
      ]);
      return { run: runFromRow(requireRow(result.rows[0], "Factory run insert returned no row")), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await this.findRowByIdempotency(normalized.creatorId, normalized.idempotencyKey);
      if (duplicate) {
        assertIdempotentDigest(rowInputDigest(duplicate), inputDigest, normalized.idempotencyKey);
        return { run: runFromRow(duplicate), created: false };
      }
      throw new CreatorFactoryRepositoryError("run_id_conflict", `Factory run ${normalized.id} already exists`);
    }
  }

  async getForCreator(creatorId: string, runId: string): Promise<FactoryRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      SELECT * FROM hatch_creator_factory_runs WHERE id = $1 AND creator_id = $2
    `, [runId, creatorId]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async listForCreator(creatorId: string): Promise<FactoryRunRecord[]> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      SELECT * FROM hatch_creator_factory_runs
      WHERE creator_id = $1
      ORDER BY updated_at DESC, id ASC
    `, [creatorId]);
    return result.rows.map(runFromRow);
  }

  async claim(input: ClaimFactoryRunInput): Promise<FactoryRunRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($1::timestamptz, clock_timestamp()) AS now_at
      ), claimable AS (
        SELECT run.id, timing.now_at
        FROM hatch_creator_factory_runs AS run
        CROSS JOIN timing
        WHERE run.next_attempt_at <= timing.now_at
          AND (
            run.status = 'queued'
            OR (run.status = 'running' AND run.lease_expires_at <= timing.now_at)
          )
        ORDER BY run.next_attempt_at ASC, run.created_at ASC, run.id ASC
        FOR UPDATE OF run SKIP LOCKED
        LIMIT 1
      )
      UPDATE hatch_creator_factory_runs AS run
      SET status = 'running',
          lease_owner = $2,
          lease_token = $3,
          lease_expires_at = claimable.now_at + ($4::bigint * interval '1 millisecond'),
          attempts = run.attempts + 1,
          version = run.version + 1,
          updated_at = claimable.now_at
      FROM claimable
      WHERE run.id = claimable.id
      RETURNING run.*
    `, [
      input.now ? iso(input.now) : null,
      requireNonEmpty(input.workerId, "workerId"),
      randomUUID(),
      boundedLeaseMs(input.leaseMs)
    ]);
    return result.rows[0] ? runFromRow(result.rows[0]) : undefined;
  }

  async assertLease(input: FactoryLeaseInput): Promise<void> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now_at
      )
      SELECT run.*
      FROM hatch_creator_factory_runs AS run
      CROSS JOIN timing
      WHERE run.id = $1
        AND run.status = 'running'
        AND run.lease_owner = $2
        AND run.lease_token = $3
        AND run.lease_expires_at > timing.now_at
    `, [
      input.runId,
      requireNonEmpty(input.workerId, "workerId"),
      requireNonEmpty(input.leaseToken, "leaseToken"),
      input.now ? iso(input.now) : null
    ]);
    requireLeaseRow(result.rows[0], input.runId);
  }

  async heartbeat(input: HeartbeatFactoryRunInput): Promise<FactoryRunRecord> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($5::timestamptz, clock_timestamp()) AS now_at
      )
      UPDATE hatch_creator_factory_runs
      SET lease_expires_at = timing.now_at + ($4::bigint * interval '1 millisecond'),
          version = version + 1,
          updated_at = timing.now_at
      FROM timing
      WHERE id = $1
        AND status = 'running'
        AND lease_owner = $2
        AND lease_token = $3
        AND lease_expires_at > timing.now_at
      RETURNING *
    `, [
      input.runId,
      requireNonEmpty(input.workerId, "workerId"),
      requireNonEmpty(input.leaseToken, "leaseToken"),
      boundedLeaseMs(input.leaseMs),
      input.now ? iso(input.now) : null
    ]);
    return requireLeaseRow(result.rows[0], input.runId);
  }

  async submitAnswers(input: SubmitFactoryAnswersInput): Promise<FactoryRunRecord> {
    await this.initialize();
    const now = parsedNow(input.now);
    const answers = normalizeAnswers(input.answers, now);
    const submissionId = answers.submissionId ?? null;
    const answerDigest = answerPayloadDigest(answers);
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now_at
      )
      UPDATE hatch_creator_factory_runs
      SET pending_answers = $3::jsonb,
          status = 'queued',
          next_attempt_at = timing.now_at,
          answer_submissions = CASE
            WHEN $6::text IS NULL THEN answer_submissions
            ELSE answer_submissions || jsonb_build_object(
              $6::text,
              jsonb_build_object(
                'answerDigest', $7::text,
                'questionBatchId', $9::text,
                'submittedAt', $8::text
              )
            )
          END,
          last_error = NULL,
          version = version + 1,
          updated_at = timing.now_at
      FROM timing
      WHERE id = $1
        AND creator_id = $2
        AND status = 'waiting_for_creator'
        AND ($5::bigint IS NULL OR version = $5::bigint)
        AND $9::text IS NOT NULL
        AND state_summary #>> '{artifacts,currentQuestionBatch,batchId}' = $9::text
        AND (
          $6::text IS NULL
          OR (
            NOT (answer_submissions ? $6::text)
          )
        )
      RETURNING *
    `, [
      input.runId,
      input.creatorId,
      JSON.stringify(answers),
      input.now ? iso(input.now) : null,
      input.expectedVersion ?? null,
      submissionId,
      answerDigest,
      answers.submittedAt ?? iso(now),
      answers.questionBatchId
    ]);
    if (result.rows[0]) return runFromRow(result.rows[0]);
    const currentRow = await this.findRowForCreator(input.creatorId, input.runId);
    if (!currentRow) throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${input.runId} was not found`);
    const current = runFromRow(currentRow);
    if (submissionId) {
      const existing = answerSubmissionFromRow(currentRow, submissionId);
      if (existing) {
        assertIdempotentDigest(existing.answerDigest, answerDigest, submissionId);
        return current;
      }
    }
    assertQuestionBatchMatch(current, answers.questionBatchId);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new CreatorFactoryRepositoryError("version_conflict", `Factory run ${current.id} is at version ${current.version}`);
    }
    throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${current.id} is not waiting for Creator answers`);
  }

  async saveAnswerDraft(input: SaveFactoryAnswerDraftInput): Promise<FactoryRunRecord> {
    await this.initialize();
    const now = parsedNow(input.now);
    const drafts = normalizeAnswers(input.answers, now);
    const batchId = requireNonEmpty(drafts.questionBatchId ?? "", "question_batch_id");
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($4::timestamptz, clock_timestamp()) AS now_at
      )
      UPDATE hatch_creator_factory_runs
      SET answer_drafts = $3::jsonb,
          version = version + 1,
          updated_at = timing.now_at
      FROM timing
      WHERE id = $1
        AND creator_id = $2
        AND status = 'waiting_for_creator'
        AND factory_stage = 'awaiting_creator_answers'
        AND ($5::bigint IS NULL OR version = $5::bigint)
        AND state_summary #>> '{artifacts,currentQuestionBatch,batchId}' = $6::text
      RETURNING *
    `, [
      input.runId,
      input.creatorId,
      JSON.stringify(drafts),
      input.now ? iso(input.now) : null,
      input.expectedVersion ?? null,
      batchId
    ]);
    if (result.rows[0]) return runFromRow(result.rows[0]);
    const currentRow = await this.findRowForCreator(input.creatorId, input.runId);
    if (!currentRow) throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${input.runId} was not found`);
    const current = runFromRow(currentRow);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new CreatorFactoryRepositoryError("version_conflict", `Factory run ${current.id} is at version ${current.version}`);
    }
    if (current.status !== "waiting_for_creator") {
      throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${current.id} is not waiting for Creator answers`);
    }
    throw new CreatorFactoryRepositoryError("version_conflict", `Creator answer draft targets a stale Question batch`);
  }

  async retry(input: RetryFactoryRunInput): Promise<FactoryRunRecord> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($3::timestamptz, clock_timestamp()) AS now_at
      )
      UPDATE hatch_creator_factory_runs
      SET status = 'queued',
          next_attempt_at = timing.now_at,
          last_error = NULL,
          version = version + 1,
          updated_at = timing.now_at
      FROM timing
      WHERE id = $1
        AND creator_id = $2
        AND status = 'needs_attention'
        AND ($4::bigint IS NULL OR version = $4::bigint)
      RETURNING *
    `, [input.runId, input.creatorId, input.now ? iso(input.now) : null, input.expectedVersion ?? null]);
    if (result.rows[0]) return runFromRow(result.rows[0]);
    const current = await this.getForCreator(input.creatorId, input.runId);
    if (!current) throw new CreatorFactoryRepositoryError("run_not_found", `Factory run ${input.runId} was not found`);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
      throw new CreatorFactoryRepositoryError("version_conflict", `Factory run ${current.id} is at version ${current.version}`);
    }
    throw new CreatorFactoryRepositoryError("invalid_status", `Factory run ${current.id} does not need attention`);
  }

  async complete(input: CompleteFactoryRunInput): Promise<FactoryRunRecord> {
    await this.initialize();
    const status = completedStatus(input.state.stage);
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($8::timestamptz, clock_timestamp()) AS now_at
      )
      UPDATE hatch_creator_factory_runs
      SET status = $4,
          factory_stage = $5,
          state_summary = $6::jsonb,
          pending_answers = NULL,
          answer_drafts = NULL,
          next_attempt_at = NULL,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = $7,
          version = version + 1,
          updated_at = timing.now_at
      FROM timing
      WHERE id = $1
        AND status = 'running'
        AND lease_owner = $2
        AND lease_token = $3
        AND lease_expires_at > timing.now_at
      RETURNING *
    `, [
      input.runId,
      requireNonEmpty(input.workerId, "workerId"),
      requireNonEmpty(input.leaseToken, "leaseToken"),
      status,
      input.state.stage,
      JSON.stringify(input.state),
      status === "needs_attention" ? input.state.lastError ?? "Factory needs attention" : null,
      input.now ? iso(input.now) : null
    ]);
    return requireLeaseRow(result.rows[0], input.runId);
  }

  async fail(input: FailFactoryRunInput): Promise<FactoryRunRecord> {
    await this.initialize();
    const result = await this.pool.query<FactoryRunRow>(`
      WITH timing AS (
        SELECT COALESCE($6::timestamptz, clock_timestamp()) AS now_at
      )
      UPDATE hatch_creator_factory_runs
      SET status = 'queued',
          next_attempt_at = CASE
            WHEN $7::bigint IS NOT NULL
              THEN timing.now_at + ($7::bigint * interval '1 millisecond')
            ELSE COALESCE($4::timestamptz, timing.now_at)
          END,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = $5,
          version = version + 1,
          updated_at = timing.now_at
      FROM timing
      WHERE id = $1
        AND status = 'running'
        AND lease_owner = $2
        AND lease_token = $3
        AND lease_expires_at > timing.now_at
      RETURNING *
    `, [
      input.runId,
      requireNonEmpty(input.workerId, "workerId"),
      requireNonEmpty(input.leaseToken, "leaseToken"),
      input.nextAttemptAt ? iso(input.nextAttemptAt) : null,
      requireNonEmpty(input.error, "error"),
      input.now ? iso(input.now) : null,
      input.retryDelayMs === undefined ? null : boundedRetryDelayMs(input.retryDelayMs)
    ]);
    return requireLeaseRow(result.rows[0], input.runId);
  }

  private async findRowForCreator(creatorId: string, runId: string): Promise<FactoryRunRow | undefined> {
    const result = await this.pool.query<FactoryRunRow>(`
      SELECT * FROM hatch_creator_factory_runs WHERE id = $1 AND creator_id = $2
    `, [runId, creatorId]);
    return result.rows[0];
  }

  private async findRowByIdempotency(creatorId: string, idempotencyKey: string): Promise<FactoryRunRow | undefined> {
    const result = await this.pool.query<FactoryRunRow>(`
      SELECT * FROM hatch_creator_factory_runs WHERE creator_id = $1 AND idempotency_key = $2
    `, [creatorId, idempotencyKey]);
    return result.rows[0];
  }
}

type FactoryRunRow = QueryResultRow & {
  id: string;
  creator_id: string;
  idempotency_key: string;
  input_digest?: string | null;
  input_jsonb: FactoryStartInput | string;
  status: FactoryControlStatus;
  factory_stage: FactoryStage | null;
  state_summary: FactoryRunState | string | null;
  pending_answers: PendingCreatorAnswers | string | null;
  answer_drafts?: PendingCreatorAnswers | string | null;
  answer_submissions?: Record<string, AnswerSubmissionReceipt> | string | null;
  version: string | number;
  next_attempt_at: string | Date | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: string | Date | null;
  attempts: string | number;
  last_error: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ProductRow = QueryResultRow & {
  id: string;
  creator_id: string;
  name: string;
  promise: string | null;
  brief: string | null;
  brief_spec: BriefSpec | string | null;
  status: "active" | "deleted";
  run_id: string | null;
  latest_revision_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

function productFromRow(row: ProductRow): CreatorProductRecord {
  const promise = validateProductText(row.promise ?? row.brief ?? "", "product.promise");
  return {
    id: row.id,
    creatorId: row.creator_id,
    name: row.name,
    promise,
    // Keep legacy workers readable while Product.id remains the only identity.
    brief: promise,
    ...(row.brief_spec ? { briefSpec: normalizeBriefSpec(typeof row.brief_spec === "string" ? JSON.parse(row.brief_spec) : row.brief_spec) } : {}),
    status: row.status,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.latest_revision_id ? { latestRevisionId: row.latest_revision_id } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {})
  };
}

function runFromRow(row: FactoryRunRow): FactoryRunRecord {
  return {
    id: row.id,
    creatorId: row.creator_id,
    idempotencyKey: row.idempotency_key,
    input: parseJson<FactoryStartInput>(row.input_jsonb),
    status: row.status,
    ...(row.factory_stage ? { factoryStage: row.factory_stage } : {}),
    ...(row.state_summary ? { state: parseJson<FactoryRunState>(row.state_summary) } : {}),
    ...(row.pending_answers ? { pendingAnswers: parseJson<PendingCreatorAnswers>(row.pending_answers) } : {}),
    ...(row.answer_drafts ? { answerDrafts: parseJson<PendingCreatorAnswers>(row.answer_drafts) } : {}),
    version: Number(row.version),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_token ? { leaseToken: row.lease_token } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    attempts: Number(row.attempts),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function normalizeCreateInput(input: CreateFactoryRunInput): CreateFactoryRunInput {
  const id = requireNonEmpty(input.id, "id");
  const creatorId = requireNonEmpty(input.creatorId, "creatorId");
  const idempotencyKey = requireNonEmpty(input.idempotencyKey, "idempotencyKey");
  if (input.input.creator.id !== creatorId) {
    throw new CreatorFactoryRepositoryError(
      "creator_mismatch",
      `Factory input Creator ${input.input.creator.id} does not match authenticated Creator ${creatorId}`
    );
  }
  if (input.input.runId && input.input.runId !== id) {
    throw new CreatorFactoryRepositoryError("run_id_conflict", `Factory input runId ${input.input.runId} does not match ${id}`);
  }
  return {
    ...input,
    id,
    creatorId,
    idempotencyKey,
    input: { ...cloneJson(input.input), runId: id },
    ...(input.nextAttemptAt ? { nextAttemptAt: iso(input.nextAttemptAt) } : {})
  };
}

function normalizeAnswers(answers: PendingCreatorAnswers, now: Date): PendingCreatorAnswers {
  const answerMarkdown = answers.answerMarkdown === undefined
    ? undefined
    : requireNonEmpty(answers.answerMarkdown, "answerMarkdown");
  const structuredAnswers = answers.answers?.map((item) => ({
    questionId: requireNonEmpty(item.questionId, "answers.questionId"),
    answer: requireNonEmpty(item.answer, `answer for ${item.questionId}`)
  }));
  if (!answerMarkdown && (!structuredAnswers || structuredAnswers.length === 0)) {
    throw new Error("Creator answer submission must contain answerMarkdown or structured answers");
  }
  if (structuredAnswers) {
    const ids = new Set<string>();
    for (const item of structuredAnswers) {
      if (ids.has(item.questionId)) throw new Error(`Duplicate Creator answer: ${item.questionId}`);
      ids.add(item.questionId);
    }
  }
  const questionBatchId = requireNonEmpty(answers.questionBatchId ?? "", "questionBatchId");
  return {
    ...(answerMarkdown ? { answerMarkdown } : {}),
    ...(structuredAnswers ? { answers: structuredAnswers } : {}),
    ...(answers.submissionId?.trim() ? { submissionId: answers.submissionId.trim() } : {}),
    questionBatchId,
    submittedAt: answers.submittedAt ? iso(answers.submittedAt) : iso(now)
  };
}

function completedStatus(stage: FactoryStage): "waiting_for_creator" | "ready" | "needs_attention" {
  if (stage === "awaiting_creator_answers" || stage === "review_required") return "waiting_for_creator";
  if (stage === "ready") return "ready";
  if (stage === "needs_attention") return "needs_attention";
  throw new CreatorFactoryRepositoryError("invalid_stage", `Worker cannot complete Factory at intermediate stage ${stage}`);
}

function isClaimable(run: FactoryRunRecord, now: Date): boolean {
  if (!run.nextAttemptAt || Date.parse(run.nextAttemptAt) > now.getTime()) return false;
  if (run.status === "queued") return true;
  return run.status === "running" && !!run.leaseExpiresAt && Date.parse(run.leaseExpiresAt) <= now.getTime();
}

function compareClaimOrder(left: FactoryRunRecord, right: FactoryRunRecord): number {
  return (left.nextAttemptAt ?? left.createdAt).localeCompare(right.nextAttemptAt ?? right.createdAt)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function requireLeaseRow(row: FactoryRunRow | undefined, runId: string): FactoryRunRecord {
  if (!row) {
    throw new CreatorFactoryRepositoryError("lease_lost", `Factory run ${runId} lease is no longer owned by this worker`);
  }
  return runFromRow(row);
}

function boundedLeaseMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LEASE_MS;
  if (!Number.isFinite(value) || value < 1_000 || value > 60 * 60_000) {
    throw new Error("leaseMs must be between 1 second and 1 hour");
  }
  return Math.floor(value);
}

function boundedRetryDelayMs(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 24 * 60 * 60_000) {
    throw new Error("retryDelayMs must be between 0 and 24 hours");
  }
  return Math.floor(value);
}

function parsedNow(value: string | undefined): Date {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  return date;
}

function addMilliseconds(date: Date, milliseconds: number): string {
  return new Date(date.getTime() + milliseconds).toISOString();
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return date.toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function idempotencyMapKey(creatorId: string, idempotencyKey: string): string {
  return `${creatorId}\u0000${idempotencyKey}`;
}

function factoryInputDigest(input: FactoryStartInput): string {
  const { runId: _transportRunId, ...semanticInput } = input;
  return sha256(stableJson(semanticInput));
}

function answerPayloadDigest(answers: PendingCreatorAnswers): string {
  return sha256(stableJson({
    ...(answers.answerMarkdown ? { answerMarkdown: answers.answerMarkdown } : {}),
    ...(answers.answers ? { answers: answers.answers } : {}),
    ...(answers.questionBatchId ? { questionBatchId: answers.questionBatchId } : {})
  }));
}

function rowInputDigest(row: FactoryRunRow): string {
  return row.input_digest?.trim() || factoryInputDigest(parseJson<FactoryStartInput>(row.input_jsonb));
}

function answerSubmissionFromRow(row: FactoryRunRow, submissionId: string): AnswerSubmissionReceipt | undefined {
  const history = row.answer_submissions
    ? parseJson<Record<string, AnswerSubmissionReceipt>>(row.answer_submissions)
    : {};
  return Object.prototype.hasOwnProperty.call(history, submissionId) ? history[submissionId] : undefined;
}

function assertIdempotentDigest(existing: string, incoming: string, key: string): void {
  if (existing === incoming) return;
  throw new CreatorFactoryRepositoryError(
    "idempotency_conflict",
    `Idempotency key ${key} was already used with a different payload`
  );
}

function assertQuestionBatchMatch(run: FactoryRunRecord, incomingBatchId: string | undefined): void {
  let currentBatchId: string | undefined;
  try {
    currentBatchId = requireQuestionBatchId(run.id, run.state?.artifacts.currentQuestionBatch);
  } catch {
    currentBatchId = undefined;
  }
  if (incomingBatchId && currentBatchId && incomingBatchId === currentBatchId) return;
  throw new CreatorFactoryRepositoryError(
    "version_conflict",
    `Creator answers target a stale or unknown Question batch for Factory run ${run.id}`
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function cloneRun(run: FactoryRunRecord): FactoryRunRecord {
  return cloneJson(run);
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function parseJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : cloneJson(value);
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

function isQueryExecutor(value: unknown): value is PostgresQueryExecutor {
  return typeof value === "object"
    && value !== null
    && "query" in value
    && typeof (value as { query?: unknown }).query === "function";
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}
