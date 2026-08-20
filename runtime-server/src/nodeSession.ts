import {
  Session,
  SessionError,
  uuidv7,
  type SessionEntryCursorOptions,
  type SessionMetadata,
  type SessionStats,
  type SessionStorage,
  type SessionTreeEntry
} from "@earendil-works/pi-agent-core";
import { createHash } from "node:crypto";
import type { PostgresQueryExecutor } from "./postgresStore.js";
import type { NodeScope } from "./node.js";

export type NodeSessionRef = {
  scope: NodeScope;
  sessionId: string;
};

/** Pi's Session stays intact; Factory only supplies a Postgres storage adapter. */
export type NodeSessionMetadata = SessionMetadata;

export type NodeSessionStore = {
  initialize?(): Promise<void>;
  open(ref: NodeSessionRef, systemPrompt: string): Promise<Session<NodeSessionMetadata>>;
};

export const POSTGRES_NODE_SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_factory_node_sessions (
  product_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  system_prompt_sha256 TEXT NOT NULL,
  leaf_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (product_id, node_name, execution_id, session_id)
);
ALTER TABLE hatch_factory_node_sessions ADD COLUMN IF NOT EXISTS leaf_id TEXT;
CREATE TABLE IF NOT EXISTS hatch_factory_node_session_entries (
  seq BIGSERIAL PRIMARY KEY,
  product_id TEXT NOT NULL,
  node_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  entry JSONB NOT NULL CHECK (jsonb_typeof(entry) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (product_id, node_name, execution_id, session_id, entry_id),
  FOREIGN KEY (product_id, node_name, execution_id, session_id)
    REFERENCES hatch_factory_node_sessions(product_id, node_name, execution_id, session_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hatch_factory_node_session_entries_order_idx
  ON hatch_factory_node_session_entries (product_id, node_name, execution_id, session_id, seq);
`;

/** Implements Pi's SessionStorage against Postgres. */
export class PostgresNodeSessionStorage implements SessionStorage<NodeSessionMetadata> {
  private schemaPromise?: Promise<void>;
  private metadata?: NodeSessionMetadata;

  constructor(
    private readonly pool: PostgresQueryExecutor,
    private readonly ref: NodeSessionRef,
    private readonly systemPromptSha256: string
  ) {}

  async initialize(): Promise<void> {
    this.schemaPromise ??= this.pool.query(POSTGRES_NODE_SESSION_SCHEMA).then(() => undefined);
    await this.schemaPromise;
  }

  async ensureSession(): Promise<NodeSessionMetadata> {
    await this.initialize();
    const { scope } = this.ref;
    await this.pool.query(
      `
        INSERT INTO hatch_factory_node_sessions
          (product_id, node_name, execution_id, session_id, system_prompt_sha256)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (product_id, node_name, execution_id, session_id) DO NOTHING
      `,
      [scope.productId, scope.nodeName, scope.executionId, this.ref.sessionId, this.systemPromptSha256]
    );
    const row = await this.sessionRow();
    if (!row) throw new SessionError("not_found", `Node session ${this.ref.sessionId} could not be opened`);
    if (row.system_prompt_sha256 !== this.systemPromptSha256) {
      throw new SessionError("invalid_session", `Node session ${this.ref.sessionId} was created with a different system prompt`);
    }
    this.metadata = { id: this.ref.sessionId, createdAt: new Date(row.created_at).toISOString() };
    return this.metadata;
  }

  async getMetadata(): Promise<NodeSessionMetadata> {
    if (!this.metadata) await this.ensureSession();
    return this.metadata as NodeSessionMetadata;
  }

  async getLeafId(): Promise<string | null> {
    const row = await this.sessionRow();
    if (!row) throw new SessionError("not_found", `Node session ${this.ref.sessionId} was not opened`);
    if (row.leaf_id !== null && !(await this.getEntry(row.leaf_id))) {
      throw new SessionError("invalid_session", `Session leaf ${row.leaf_id} not found`);
    }
    return row.leaf_id;
  }

  async setLeafId(leafId: string | null): Promise<void> {
    if (leafId !== null && !(await this.getEntry(leafId))) {
      throw new SessionError("not_found", `Entry ${leafId} not found`);
    }
    await this.appendEntry({
      type: "leaf",
      id: await this.createEntryId(),
      parentId: await this.getLeafId(),
      timestamp: new Date().toISOString(),
      targetId: leafId
    });
  }

  async createEntryId(): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // Match Pi's default JSONL adapter: short UUIDv7 tails are the entry ids.
      const id = uuidv7().slice(-8);
      if (!(await this.getEntry(id))) return id;
    }
    return uuidv7();
  }

  async appendEntry(entry: SessionTreeEntry): Promise<void> {
    await this.initialize();
    const serialized = JSON.stringify(entry);
    if (serialized === undefined) {
      throw new SessionError("invalid_entry", `Session entry ${entry.id} is not JSON serializable`);
    }
    const leafId = entry.type === "leaf" ? entry.targetId : entry.id;
    // The entry and leaf advance commit together. A retry after a lost DB
    // response cannot create a second durable Pi entry.
    const result = await this.pool.query<{ session_id: string }>(
      `
        WITH appended AS (
          INSERT INTO hatch_factory_node_session_entries
            (product_id, node_name, execution_id, session_id, entry_id, entry)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
          ON CONFLICT (product_id, node_name, execution_id, session_id, entry_id) DO NOTHING
          RETURNING entry_id
        )
        UPDATE hatch_factory_node_sessions AS sessions
        SET leaf_id = $7, updated_at = clock_timestamp()
        WHERE sessions.product_id = $1
          AND sessions.node_name = $2
          AND sessions.execution_id = $3
          AND sessions.session_id = $4
          AND EXISTS (SELECT 1 FROM appended)
        RETURNING sessions.session_id
      `,
      [
        this.ref.scope.productId,
        this.ref.scope.nodeName,
        this.ref.scope.executionId,
        this.ref.sessionId,
        entry.id,
        serialized,
        leafId
      ]
    );
    if (result.rows[0]) return;
    if (await this.getEntry(entry.id)) return;
    throw new SessionError("storage", `Failed to append session entry ${entry.id}`);
  }

  async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
    await this.initialize();
    const result = await this.pool.query<{ entry: unknown }>(
      `
        SELECT entry
        FROM hatch_factory_node_session_entries
        WHERE product_id = $1 AND node_name = $2 AND execution_id = $3
          AND session_id = $4 AND entry_id = $5
      `,
      [this.ref.scope.productId, this.ref.scope.nodeName, this.ref.scope.executionId, this.ref.sessionId, id]
    );
    return result.rows[0] ? parseEntry(result.rows[0].entry) : undefined;
  }

  async findEntries<TType extends SessionTreeEntry["type"]>(
    type: TType
  ): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
    const entries = await this.getEntries();
    return entries.filter((entry): entry is Extract<SessionTreeEntry, { type: TType }> => entry.type === type);
  }

  async getLabel(id: string): Promise<string | undefined> {
    const labels = await this.findEntries("label");
    let label: string | undefined;
    for (const entry of labels) {
      if (entry.targetId === id) label = entry.label?.trim() || undefined;
    }
    return label;
  }

  async getSessionName(): Promise<string | undefined> {
    const entries = await this.findEntries("session_info");
    return entries.at(-1)?.name?.trim() || undefined;
  }

  async getSessionStats(): Promise<SessionStats> {
    const entries = await this.getEntries();
    let messageCount = 0;
    let cachedTokens = 0;
    let uncachedTokens = 0;
    let totalTokens = 0;
    let costTotal = 0;
    for (const entry of entries) {
      if (entry.type === "message") messageCount += 1;
      const usage = entry.type === "message"
        ? entry.message.role === "assistant" ? entry.message.usage : undefined
        : entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
      if (!usage || typeof usage.input !== "number" || typeof usage.output !== "number" || typeof usage.cacheRead !== "number" || typeof usage.cacheWrite !== "number" || typeof usage.cost?.total !== "number") continue;
      cachedTokens += usage.cacheRead;
      uncachedTokens += usage.input + usage.cacheWrite;
      totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      costTotal += usage.cost.total;
    }
    return { messageCount, cachedTokens, uncachedTokens, totalTokens, costTotal };
  }

  async getPathToRootOrCompaction(leafId: string | null): Promise<SessionTreeEntry[]> {
    if (leafId === null) return [];
    const entries = await this.getEntries();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const path: SessionTreeEntry[] = [];
    let stopAtEntryId: string | null = null;
    let current = byId.get(leafId);
    if (!current) throw new SessionError("not_found", `Entry ${leafId} not found`);
    while (current) {
      path.unshift(current);
      if (stopAtEntryId !== null && current.id === stopAtEntryId) break;
      if (current.type === "compaction") {
        if (current.retainedTail) break;
        stopAtEntryId = current.firstKeptEntryId ?? null;
      }
      if (!current.parentId) break;
      const parent = byId.get(current.parentId);
      if (!parent) throw new SessionError("invalid_session", `Entry ${current.parentId} not found`);
      current = parent;
    }
    return path;
  }

  async getEntries(options?: SessionEntryCursorOptions): Promise<SessionTreeEntry[]> {
    const offset = options?.afterEntrySeq ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new SessionError("invalid_entry", `Invalid session entry cursor ${offset}`);
    if (options?.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
      throw new SessionError("invalid_entry", `Invalid session entry limit ${options.limit}`);
    }
    const values: unknown[] = [this.ref.scope.productId, this.ref.scope.nodeName, this.ref.scope.executionId, this.ref.sessionId, offset];
    const query = options?.limit === undefined
      ? "SELECT entry FROM hatch_factory_node_session_entries WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4 ORDER BY seq ASC OFFSET $5"
      : "SELECT entry FROM hatch_factory_node_session_entries WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4 ORDER BY seq ASC OFFSET $5 LIMIT $6";
    if (options?.limit !== undefined) values.push(options.limit);
    return this.queryEntries(query, values);
  }

  private async sessionRow(): Promise<SessionRow | undefined> {
    await this.initialize();
    const result = await this.pool.query<SessionRow>(
      `SELECT system_prompt_sha256, leaf_id, created_at FROM hatch_factory_node_sessions WHERE product_id = $1 AND node_name = $2 AND execution_id = $3 AND session_id = $4`,
      [this.ref.scope.productId, this.ref.scope.nodeName, this.ref.scope.executionId, this.ref.sessionId]
    );
    return result.rows[0];
  }

  private async queryEntries(query: string, values: unknown[]): Promise<SessionTreeEntry[]> {
    const result = await this.pool.query<{ entry: unknown }>(query, values);
    return result.rows.map((row) => parseEntry(row.entry));
  }
}

export class PostgresNodeSessionStore implements NodeSessionStore {
  private schemaPromise?: Promise<void>;

  constructor(private readonly pool: PostgresQueryExecutor) {}

  async initialize(): Promise<void> {
    this.schemaPromise ??= this.pool.query(POSTGRES_NODE_SESSION_SCHEMA).then(() => undefined);
    await this.schemaPromise;
  }

  async open(ref: NodeSessionRef, systemPrompt: string): Promise<Session<NodeSessionMetadata>> {
    const storage = new PostgresNodeSessionStorage(this.pool, ref, digest(systemPrompt));
    await storage.ensureSession();
    return new Session(storage);
  }
}

type SessionRow = {
  system_prompt_sha256: string;
  leaf_id: string | null;
  created_at: string | Date;
};

function parseEntry(value: unknown): SessionTreeEntry {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SessionError("invalid_session", "Persisted Pi session entry is not an object");
  }
  return parsed as SessionTreeEntry;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
