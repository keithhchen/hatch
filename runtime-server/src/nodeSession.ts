import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { NodeScope } from "./node.js";
import type { PostgresQueryExecutor } from "./postgresStore.js";

/**
 * Node persistence is deliberately split from OSS artifacts:
 * - session messages and execution state live in Postgres;
 * - source files, candidates, feedback, and final outputs live in OSS.
 */
export const POSTGRES_NODE_RUNTIME_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_node_sessions (
  product_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  system_prompt_sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, node_name, execution_id, session_id)
);
CREATE TABLE IF NOT EXISTS hatch_node_session_messages (
  id BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hatch_node_session_messages_scope_idx
  ON hatch_node_session_messages (product_id, node_name, execution_id, session_id, id);
CREATE TABLE IF NOT EXISTS hatch_node_executions (
  product_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  status TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  input_ref TEXT,
  candidate_ref TEXT,
  feedback_ref TEXT,
  output_ref TEXT,
  handoff_ref TEXT,
  decision TEXT,
  last_error TEXT,
  state_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, node_name, execution_id)
);
ALTER TABLE hatch_node_executions ADD COLUMN IF NOT EXISTS feedback_ref TEXT;
ALTER TABLE hatch_node_executions ADD COLUMN IF NOT EXISTS input_ref TEXT;
ALTER TABLE hatch_node_executions ADD COLUMN IF NOT EXISTS handoff_ref TEXT;
ALTER TABLE hatch_node_executions ADD COLUMN IF NOT EXISTS last_error TEXT;
`;

export type NodeSessionRef = {
  scope: NodeScope;
  sessionId: string;
};

export type NodeSessionStore = {
  open(ref: NodeSessionRef, systemPrompt: string): Promise<AgentMessage[]>;
  appendMessage(ref: NodeSessionRef, message: AgentMessage): Promise<void>;
};

export type NodeExecutionRef = {
  scope: NodeScope;
};

export type NodeExecutionState = {
  status: "queued" | "running" | "completed" | "waiting_for_creator" | "handoff_saved" | "failed" | "max_rounds";
  round: number;
  phase?: "actor" | "critic";
  /** Legacy read-time field. New executions persist only inputRef. */
  input?: unknown;
  inputRef?: string;
  candidateRef?: string;
  feedbackRef?: string;
  outputRef?: string;
  handoffRef?: string;
  decision?: "done" | "revise";
  lastError?: string;
  /** Small host checkpoint metadata only; content artifacts stay in OSS. */
  details?: unknown;
};

export type NodeExecutionStore = {
  load(ref: NodeExecutionRef): Promise<NodeExecutionState | undefined>;
  save(ref: NodeExecutionRef, state: NodeExecutionState): Promise<void>;
  latest?(productId: string, nodeName: string): Promise<{ scope: NodeScope; state: NodeExecutionState } | undefined>;
};

export type PostgresNodeStoreOptions = {
  connectionString?: string;
  databaseUrl?: string;
  pool?: PostgresQueryExecutor;
  maxConnections?: number;
  environment?: NodeJS.ProcessEnv;
};

type NodeSessionRow = {
  system_prompt_sha256: string;
};

type NodeMessageRow = {
  message: AgentMessage;
};

type NodeExecutionRow = {
  status: string;
  round: number;
  input_ref: string | null;
  candidate_ref: string | null;
  feedback_ref: string | null;
  output_ref: string | null;
  handoff_ref: string | null;
  decision: string | null;
  last_error: string | null;
  state_jsonb: unknown;
};

/** Postgres-backed messages and execution state for one generic Node runtime. */
export class PostgresNodeStore implements NodeSessionStore, NodeExecutionStore {
  readonly pool: PostgresQueryExecutor;

  private readonly ownsPool: boolean;
  private schemaPromise?: Promise<void>;

  constructor(connectionString: string);
  constructor(options?: PostgresNodeStoreOptions);
  constructor(pool: PostgresQueryExecutor);
  constructor(input: string | PostgresNodeStoreOptions | PostgresQueryExecutor = {}) {
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
    if (!connectionString) throw new Error("Postgres Node store requires a database connection string");
    this.pool = new Pool({
      connectionString,
      ...(input.maxConnections === undefined ? {} : { max: input.maxConnections })
    });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(POSTGRES_NODE_RUNTIME_SCHEMA).then(() => undefined);
    }
    await this.schemaPromise;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }

  async open(ref: NodeSessionRef, systemPrompt: string): Promise<AgentMessage[]> {
    await this.initialize();
    const digest = promptDigest(systemPrompt);
    const scope = ref.scope;
    await this.pool.query(`
      INSERT INTO hatch_node_sessions
        (product_id, node_name, execution_id, session_id, system_prompt_sha256)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (product_id, node_name, execution_id, session_id) DO NOTHING
    `, [scope.productId, scope.nodeName, scope.executionId, ref.sessionId, digest]);

    const session = await this.pool.query<NodeSessionRow>(`
      SELECT system_prompt_sha256
      FROM hatch_node_sessions
      WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4
    `, [scope.productId, scope.nodeName, scope.executionId, ref.sessionId]);
    const stored = session.rows[0];
    if (!stored) throw new Error(`Node session ${ref.sessionId} was not created`);
    if (stored.system_prompt_sha256 !== digest) {
      throw new Error(`Node session ${ref.sessionId} was created with a different system prompt`);
    }

    const messages = await this.pool.query<NodeMessageRow>(`
      SELECT message
      FROM hatch_node_session_messages
      WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4
      ORDER BY id ASC
    `, [scope.productId, scope.nodeName, scope.executionId, ref.sessionId]);
    return messages.rows.map((row) => row.message);
  }

  async appendMessage(ref: NodeSessionRef, message: AgentMessage): Promise<void> {
    await this.initialize();
    const scope = ref.scope;
    const session = await this.pool.query(`
      SELECT 1
      FROM hatch_node_sessions
      WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4
    `, [scope.productId, scope.nodeName, scope.executionId, ref.sessionId]);
    if (!session.rows[0]) throw new Error(`Node session ${ref.sessionId} must be opened before appending messages`);
    await this.pool.query(`
      INSERT INTO hatch_node_session_messages
        (product_id, node_name, execution_id, session_id, message)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [scope.productId, scope.nodeName, scope.executionId, ref.sessionId, JSON.stringify(message)]);
    await this.pool.query(`
      UPDATE hatch_node_sessions
      SET updated_at = clock_timestamp()
      WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4
    `, [scope.productId, scope.nodeName, scope.executionId, ref.sessionId]);
  }

  async load(ref: NodeExecutionRef): Promise<NodeExecutionState | undefined> {
    await this.initialize();
    const scope = ref.scope;
    const result = await this.pool.query<NodeExecutionRow>(`
      SELECT status, round, input_ref, candidate_ref, feedback_ref, output_ref, handoff_ref, decision, last_error, state_jsonb
      FROM hatch_node_executions
      WHERE product_id = $1 AND node_name = $2 AND execution_id = $3
    `, [scope.productId, scope.nodeName, scope.executionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const checkpoint = asRecord(row.state_jsonb);
    const phase = checkpoint.phase === "actor" || checkpoint.phase === "critic"
      ? checkpoint.phase
      : undefined;
    const details = Object.prototype.hasOwnProperty.call(checkpoint, "details")
      ? checkpoint.details
      : row.state_jsonb;
    return {
      status: executionStatus(row.status),
      round: row.round,
      ...(row.input_ref === null ? {} : { inputRef: row.input_ref }),
      ...(phase === undefined ? {} : { phase }),
      ...(Object.prototype.hasOwnProperty.call(checkpoint, "input") ? { input: checkpoint.input } : {}),
      ...(row.candidate_ref === null ? {} : { candidateRef: row.candidate_ref }),
      ...(row.feedback_ref === null ? {} : { feedbackRef: row.feedback_ref }),
      ...(row.output_ref === null ? {} : { outputRef: row.output_ref }),
      ...(row.handoff_ref === null ? {} : { handoffRef: row.handoff_ref }),
      ...(row.decision === "done" || row.decision === "revise" ? { decision: row.decision } : {}),
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(details === undefined ? {} : { details })
    };
  }

  async save(ref: NodeExecutionRef, state: NodeExecutionState): Promise<void> {
    await this.initialize();
    const scope = ref.scope;
    const checkpoint = JSON.stringify({
      ...(state.phase === undefined ? {} : { phase: state.phase }),
      ...(state.input === undefined ? {} : { input: state.input }),
      details: state.details ?? {}
    });
    await this.pool.query(`
      INSERT INTO hatch_node_executions
        (product_id, node_name, execution_id, status, round, input_ref, candidate_ref, feedback_ref, output_ref, handoff_ref, decision, last_error, state_jsonb)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      ON CONFLICT (product_id, node_name, execution_id) DO UPDATE SET
        status = EXCLUDED.status,
        round = EXCLUDED.round,
        input_ref = EXCLUDED.input_ref,
        candidate_ref = EXCLUDED.candidate_ref,
        feedback_ref = EXCLUDED.feedback_ref,
        output_ref = EXCLUDED.output_ref,
        handoff_ref = EXCLUDED.handoff_ref,
        decision = EXCLUDED.decision,
        last_error = EXCLUDED.last_error,
        state_jsonb = EXCLUDED.state_jsonb,
        updated_at = clock_timestamp()
    `, [
      scope.productId,
      scope.nodeName,
      scope.executionId,
      state.status,
      state.round,
      state.inputRef ?? null,
      state.candidateRef ?? null,
      state.feedbackRef ?? null,
      state.outputRef ?? null,
      state.handoffRef ?? null,
      state.decision ?? null,
      state.lastError ?? null,
      checkpoint
    ]);
  }

  async latest(productId: string, nodeName: string): Promise<{ scope: NodeScope; state: NodeExecutionState } | undefined> {
    await this.initialize();
    const result = await this.pool.query<NodeExecutionRow & { execution_id: string }>(`
      SELECT execution_id, status, round, input_ref, candidate_ref, feedback_ref, output_ref, handoff_ref, decision, last_error, state_jsonb
      FROM hatch_node_executions
      WHERE product_id = $1 AND node_name = $2
      ORDER BY updated_at DESC
      LIMIT 1
    `, [productId, nodeName]);
    const row = result.rows[0];
    if (!row) return undefined;
    const state = await this.load({ scope: { productId, nodeName, executionId: row.execution_id } });
    return state
      ? { scope: { productId, nodeName, executionId: row.execution_id }, state }
      : undefined;
  }
}

function promptDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function isQueryExecutor(value: unknown): value is PostgresQueryExecutor {
  return Boolean(value && typeof value === "object" && typeof (value as { query?: unknown }).query === "function");
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function executionStatus(value: string): NodeExecutionState["status"] {
  if (value === "queued" || value === "running" || value === "completed" || value === "waiting_for_creator" || value === "handoff_saved" || value === "failed" || value === "max_rounds") return value;
  throw new Error(`Unknown Node execution status: ${value}`);
}
