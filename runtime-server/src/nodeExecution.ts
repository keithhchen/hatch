import type { PostgresQueryExecutor } from "./postgresStore.js";
import type { NodeScope } from "./node.js";
import { PostgresNodeSessionStore, type NodeSessionStore } from "./nodeSession.js";

/** The only states the Studio needs to render for one Node execution. */
export type NodeExecutionStateName =
  | "loading"
  | "actor"
  | "critic"
  | "completed"
  | "failed";

/**
 * Postgres stores the control-plane facts only. The bytes behind the refs live
 * in OSS, and Pi conversation entries live in the Node session tables.
 */
export type NodeExecutionState = {
  state: NodeExecutionStateName;
  round: number;
  inputRef: string;
  candidateRef?: string;
  feedbackRef?: string;
  outputRef?: string;
  errorMessage?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

/**
 * One execution row is also the work queue. A worker must claim the row before
 * it calls an LLM and must keep the lease alive while the call is running.
 */
export type NodeExecutionStateStore = {
  initialize?(): Promise<void>;
  ensure(scope: NodeScope, inputRef: string): Promise<NodeExecutionState>;
  load(scope: NodeScope): Promise<NodeExecutionState | undefined>;
  list(productId: string): Promise<Array<NodeExecutionState & { nodeName: string; executionId: string }>>;
  listRunnable(limit?: number): Promise<Array<NodeExecutionState & { productId: string; nodeName: string; executionId: string }>>;
  claim(scope: NodeScope, leaseOwner: string, leaseMs: number): Promise<NodeExecutionState | undefined>;
  heartbeat(scope: NodeScope, leaseOwner: string, leaseMs: number): Promise<void>;
  save(scope: NodeScope, state: NodeExecutionState, leaseOwner: string): Promise<void>;
};

/**
 * This is deliberately one flat table. There is no FactoryRun, graph-run
 * record, generic JSON state column, creator-input table, or separate lease
 * table in the new Node control plane.
 */
export const POSTGRES_NODE_EXECUTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_factory_node_executions (
  product_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('loading', 'actor', 'critic', 'completed', 'failed')),
  round INTEGER NOT NULL CHECK (round >= 1),
  input_ref TEXT NOT NULL,
  candidate_ref TEXT,
  feedback_ref TEXT,
  output_ref TEXT,
  error_message TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (product_id, node_name, execution_id)
);
CREATE INDEX IF NOT EXISTS hatch_factory_node_executions_state_idx
  ON hatch_factory_node_executions (state, updated_at);
`;

export class PostgresNodeExecutionStateStore implements NodeExecutionStateStore {
  private schemaPromise?: Promise<void>;

  constructor(private readonly pool: PostgresQueryExecutor) {}

  async initialize(): Promise<void> {
    this.schemaPromise ??= this.pool.query(POSTGRES_NODE_EXECUTION_SCHEMA).then(() => undefined);
    await this.schemaPromise;
  }

  async ensure(scope: NodeScope, inputRef: string): Promise<NodeExecutionState> {
    await this.initialize();
    requireReference(inputRef, "inputRef");
    await this.pool.query(
      `
        INSERT INTO hatch_factory_node_executions
          (product_id, node_name, execution_id, state, round, input_ref)
        VALUES ($1, $2, $3, 'loading', 1, $4)
        ON CONFLICT (product_id, node_name, execution_id) DO NOTHING
      `,
      [scope.productId, scope.nodeName, scope.executionId, inputRef]
    );
    const state = await this.load(scope);
    if (!state) throw new Error("Node execution disappeared immediately after ensure");
    if (state.inputRef !== inputRef) {
      throw new Error(
        `Node execution input is immutable: expected ${state.inputRef}, received ${inputRef}`
      );
    }
    return state;
  }

  async load(scope: NodeScope): Promise<NodeExecutionState | undefined> {
    await this.initialize();
    const result = await this.pool.query<ExecutionRow>(
      `
        SELECT state, round, input_ref, candidate_ref, feedback_ref, output_ref,
               error_message, lease_owner, lease_expires_at, created_at, updated_at
        FROM hatch_factory_node_executions
        WHERE product_id = $1 AND node_name = $2 AND execution_id = $3
      `,
      [scope.productId, scope.nodeName, scope.executionId]
    );
    const row = result.rows[0];
    return row ? executionFromRow(row) : undefined;
  }

  async list(productId: string): Promise<Array<NodeExecutionState & { nodeName: string; executionId: string }>> {
    await this.initialize();
    const result = await this.pool.query<ExecutionRow & { node_name: string; execution_id: string }>(
      `
        SELECT node_name, execution_id, state, round, input_ref, candidate_ref, feedback_ref, output_ref,
               error_message, lease_owner, lease_expires_at, created_at, updated_at
        FROM hatch_factory_node_executions
        WHERE product_id = $1
        ORDER BY updated_at ASC, node_name ASC, execution_id ASC
      `,
      [productId]
    );
    return result.rows.map((row) => ({
      nodeName: row.node_name,
      executionId: row.execution_id,
      ...executionFromRow(row)
    }));
  }

  async listRunnable(limit = 32): Promise<Array<NodeExecutionState & { productId: string; nodeName: string; executionId: string }>> {
    await this.initialize();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Node runnable limit must be between 1 and 100");
    const result = await this.pool.query<ExecutionRow & { product_id: string; node_name: string; execution_id: string }>(
      `
        SELECT product_id, node_name, execution_id, state, round, input_ref, candidate_ref, feedback_ref, output_ref,
               error_message, lease_owner, lease_expires_at, created_at, updated_at
        FROM hatch_factory_node_executions
        WHERE state IN ('loading', 'actor', 'critic')
          AND (lease_owner IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY updated_at ASC
        LIMIT $1
      `,
      [limit]
    );
    return result.rows.map((row) => ({
      productId: row.product_id,
      nodeName: row.node_name,
      executionId: row.execution_id,
      ...executionFromRow(row)
    }));
  }

  async claim(scope: NodeScope, leaseOwner: string, leaseMs: number): Promise<NodeExecutionState | undefined> {
    await this.initialize();
    requireLeaseOwner(leaseOwner);
    requireLeaseMs(leaseMs);
    const result = await this.pool.query<ExecutionRow>(
      `
        UPDATE hatch_factory_node_executions
        SET lease_owner = $4,
            lease_expires_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
            updated_at = clock_timestamp()
        WHERE product_id = $1
          AND node_name = $2
          AND execution_id = $3
          AND state <> 'completed'
          AND (
            lease_owner IS NULL
            OR lease_expires_at <= clock_timestamp()
            OR lease_owner = $4
          )
        RETURNING state, round, input_ref, candidate_ref, feedback_ref, output_ref,
                  error_message, lease_owner, lease_expires_at, created_at, updated_at
      `,
      [scope.productId, scope.nodeName, scope.executionId, leaseOwner, leaseMs]
    );
    const row = result.rows[0];
    return row ? executionFromRow(row) : undefined;
  }

  async heartbeat(scope: NodeScope, leaseOwner: string, leaseMs: number): Promise<void> {
    await this.initialize();
    requireLeaseOwner(leaseOwner);
    requireLeaseMs(leaseMs);
    const result = await this.pool.query(
      `
        UPDATE hatch_factory_node_executions
        SET lease_expires_at = clock_timestamp() + ($4::bigint * interval '1 millisecond'),
            updated_at = clock_timestamp()
        WHERE product_id = $1
          AND node_name = $2
          AND execution_id = $3
          AND lease_owner = $5
          AND lease_expires_at > clock_timestamp()
          AND state NOT IN ('completed', 'failed')
        RETURNING execution_id
      `,
      [scope.productId, scope.nodeName, scope.executionId, leaseMs, leaseOwner]
    );
    if (result.rows.length === 0) {
      // pg does not return rowCount in the intentionally small executor type.
      // A follow-up read makes lease loss explicit without widening that shared
      // database interface.
      const current = await this.load(scope);
      if (!current || current.leaseOwner !== leaseOwner) {
        throw new Error("Node execution lease was lost");
      }
    }
  }

  async save(scope: NodeScope, state: NodeExecutionState, leaseOwner: string): Promise<void> {
    await this.initialize();
    validateState(state);
    requireLeaseOwner(leaseOwner);
    const terminal = state.state === "completed"
      || state.state === "failed";
    const result = await this.pool.query(
      `
        UPDATE hatch_factory_node_executions
        SET state = $4,
            round = $5,
            candidate_ref = $6,
            feedback_ref = $7,
            output_ref = $8,
            error_message = $9,
            lease_owner = CASE WHEN $10::boolean THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN $10::boolean THEN NULL ELSE lease_expires_at END,
            updated_at = clock_timestamp()
        WHERE product_id = $1
          AND node_name = $2
          AND execution_id = $3
          AND input_ref = $11
          AND lease_owner = $12
          AND lease_expires_at > clock_timestamp()
        RETURNING execution_id
      `,
      [
        scope.productId,
        scope.nodeName,
        scope.executionId,
        state.state,
        state.round,
        state.candidateRef ?? null,
        state.feedbackRef ?? null,
        state.outputRef ?? null,
        state.errorMessage ?? null,
        terminal,
        state.inputRef,
        leaseOwner
      ]
    );
    if (result.rows.length === 0) {
      const current = await this.load(scope);
      throw new Error(
        current?.leaseOwner === leaseOwner
          ? "Node execution lease expired before checkpoint was saved"
          : "Node execution checkpoint rejected because this worker no longer owns the lease"
      );
    }
  }
}

/** The Postgres bundle used by a Factory Node runtime. */
export type NodePersistence = {
  sessions: NodeSessionStore;
  executions: NodeExecutionStateStore;
  initialize?(): Promise<void>;
};

export class PostgresNodePersistence implements NodePersistence {
  readonly sessions: PostgresNodeSessionStore;
  readonly executions: PostgresNodeExecutionStateStore;
  private schemaPromise?: Promise<void>;

  constructor(private readonly pool: PostgresQueryExecutor) {
    this.sessions = new PostgresNodeSessionStore(pool);
    this.executions = new PostgresNodeExecutionStateStore(pool);
  }

  async initialize(): Promise<void> {
    this.schemaPromise ??= Promise.all([
      this.sessions.initialize?.(),
      this.executions.initialize?.()
    ]).then(() => undefined);
    await this.schemaPromise;
  }
}

type ExecutionRow = {
  state: string;
  round: number | string;
  input_ref: string;
  candidate_ref: string | null;
  feedback_ref: string | null;
  output_ref: string | null;
  error_message: string | null;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function executionFromRow(row: ExecutionRow): NodeExecutionState {
  return {
    state: parseState(row.state),
    round: parseRound(row.round),
    inputRef: requireReference(row.input_ref, "persisted input_ref"),
    ...(row.candidate_ref ? { candidateRef: row.candidate_ref } : {}),
    ...(row.feedback_ref ? { feedbackRef: row.feedback_ref } : {}),
    ...(row.output_ref ? { outputRef: row.output_ref } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: toIso(row.lease_expires_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at)
  };
}

function validateState(state: NodeExecutionState): void {
  parseState(state.state);
  parseRound(state.round);
  requireReference(state.inputRef, "inputRef");
  for (const [name, value] of [
    ["candidateRef", state.candidateRef],
    ["feedbackRef", state.feedbackRef],
    ["outputRef", state.outputRef]
  ] as const) {
    if (value !== undefined) requireReference(value, name);
  }
}

function parseState(value: string): NodeExecutionStateName {
  if (
    value === "loading"
    || value === "actor"
    || value === "critic"
    || value === "completed"
    || value === "failed"
  ) return value;
  throw new Error(`Invalid persisted Node execution state: ${value}`);
}

function parseRound(value: number | string): number {
  const round = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(round) || round < 1) throw new Error(`Invalid persisted Node execution round: ${value}`);
  return round;
}

function requireReference(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty OSS reference`);
  return value.trim();
}

function requireLeaseOwner(value: string): void {
  if (!value.trim()) throw new Error("leaseOwner must be non-empty");
}

function requireLeaseMs(value: number): void {
  if (!Number.isInteger(value) || value < 1_000) throw new Error("leaseMs must be an integer of at least 1000ms");
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
