import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const TASK_KINDS = ["interview", "content", "research", "agent_research", "build", "evaluate", "poke", "change"] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type TaskStatus = "working" | "needs_you" | "done";
export type TaskNeeds = "answer" | "review" | "blocked";
/** Where a task came from and where its replies go. */
export type TaskOrigin = { source: "web" | "telegram" | "line" | "lark" | "imessage" | "tick" | "consumer" };
/** The workbench session executing the task. Product sessions carry productId; Assistant-workspace sessions do not. */
export type TaskSession = { scope: "product" | "assistant"; sessionId: string };

export type AssistantTask = {
  id: string;
  accountId: string;
  productId?: string;
  kind: TaskKind;
  status: TaskStatus;
  needs?: TaskNeeds;
  origin: TaskOrigin;
  session?: TaskSession;
  /** What the task carries between steps: the instruction, a pipeline step, a proposed storefront change, the question asked. */
  payload: Record<string, unknown>;
  outputRef?: string;
  summary?: string;
  answeredAt?: string;
  leaseExpiresAt?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskChange = Partial<Pick<AssistantTask, "status" | "needs" | "session" | "payload" | "outputRef" | "summary" | "answeredAt" | "leaseExpiresAt" | "lastError" | "attempts">>;

export interface TaskRepository {
  create(input: Pick<AssistantTask, "accountId" | "kind" | "origin"> & Partial<Pick<AssistantTask, "productId" | "status" | "needs" | "session" | "payload" | "summary" | "leaseExpiresAt">>): Promise<AssistantTask>;
  get(id: string): Promise<AssistantTask | undefined>;
  update(id: string, change: TaskChange): Promise<AssistantTask>;
  /** Open tasks (working or needs_you) of one account, newest first. */
  open(accountId: string): Promise<AssistantTask[]>;
  /** Working tasks whose lease expired: their worker was lost to a restart or hang. */
  expired(now: Date): Promise<AssistantTask[]>;
  /** The latest pokes of one account, newest first. */
  pokes(accountId: string, limit: number): Promise<AssistantTask[]>;
  bySession(sessionId: string): Promise<AssistantTask | undefined>;
}

export class PostgresTaskRepository implements TaskRepository {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresTaskRepository> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_assistant_tasks (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL,
        product_id TEXT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('working', 'needs_you', 'done')),
        needs TEXT CHECK (needs IN ('answer', 'review', 'blocked')),
        origin JSONB NOT NULL,
        session JSONB,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        output_ref TEXT,
        summary TEXT,
        answered_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hatch_assistant_tasks_open_idx ON hatch_assistant_tasks (account_id, updated_at DESC) WHERE status <> 'done';
      CREATE INDEX IF NOT EXISTS hatch_assistant_tasks_lease_idx ON hatch_assistant_tasks (lease_expires_at) WHERE status = 'working';
      CREATE INDEX IF NOT EXISTS hatch_assistant_tasks_session_idx ON hatch_assistant_tasks ((session->>'sessionId')) WHERE status <> 'done';
    `);
    return new PostgresTaskRepository(pool);
  }
  async create(input: Parameters<TaskRepository["create"]>[0]): Promise<AssistantTask> {
    const now = new Date().toISOString();
    const row = (await this.pool.query(
      `INSERT INTO hatch_assistant_tasks (id, account_id, product_id, kind, status, needs, origin, session, payload, summary, lease_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $12) RETURNING *`,
      [randomUUID(), input.accountId, input.productId ?? null, input.kind, input.status ?? "working", input.needs ?? null, JSON.stringify(input.origin), input.session ? JSON.stringify(input.session) : null, JSON.stringify(input.payload ?? {}), input.summary ?? null, input.leaseExpiresAt ?? null, now],
    )).rows[0];
    return fromRow(row);
  }
  async get(id: string): Promise<AssistantTask | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = (await this.pool.query("SELECT * FROM hatch_assistant_tasks WHERE id = $1", [id])).rows[0];
    return row ? fromRow(row) : undefined;
  }
  async update(id: string, change: TaskChange): Promise<AssistantTask> {
    const columns: Record<keyof TaskChange, string> = { status: "status", needs: "needs", session: "session", payload: "payload", outputRef: "output_ref", summary: "summary", answeredAt: "answered_at", leaseExpiresAt: "lease_expires_at", lastError: "last_error", attempts: "attempts" };
    const sets: string[] = []; const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns) as Array<[keyof TaskChange, string]>) {
      if (!(key in change)) continue;
      const value = change[key];
      values.push(value === undefined ? null : key === "session" || key === "payload" ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}${key === "session" || key === "payload" ? "::jsonb" : ""}`);
    }
    if (change.status && change.status !== "needs_you" && !("needs" in change)) sets.push("needs = NULL");
    const row = (await this.pool.query(`UPDATE hatch_assistant_tasks SET ${[...sets, "updated_at = NOW()"].join(", ")} WHERE id = $1 RETURNING *`, values)).rows[0];
    if (!row) throw Object.assign(new Error("Task was not found"), { status: 404 });
    return fromRow(row);
  }
  async open(accountId: string): Promise<AssistantTask[]> {
    return (await this.pool.query("SELECT * FROM hatch_assistant_tasks WHERE account_id = $1 AND status <> 'done' ORDER BY updated_at DESC LIMIT 100", [accountId])).rows.map(fromRow);
  }
  async expired(now: Date): Promise<AssistantTask[]> {
    return (await this.pool.query("SELECT * FROM hatch_assistant_tasks WHERE status = 'working' AND lease_expires_at < $1 ORDER BY lease_expires_at LIMIT 50", [now.toISOString()])).rows.map(fromRow);
  }
  async pokes(accountId: string, limit: number): Promise<AssistantTask[]> {
    return (await this.pool.query("SELECT * FROM hatch_assistant_tasks WHERE account_id = $1 AND kind = 'poke' ORDER BY created_at DESC LIMIT $2", [accountId, limit])).rows.map(fromRow);
  }
  async bySession(sessionId: string): Promise<AssistantTask | undefined> {
    const row = (await this.pool.query("SELECT * FROM hatch_assistant_tasks WHERE status <> 'done' AND session->>'sessionId' = $1 ORDER BY updated_at DESC LIMIT 1", [sessionId])).rows[0];
    return row ? fromRow(row) : undefined;
  }
}

/** Explicit test dependency; the product never constructs this repository. */
export class MemoryTaskRepository implements TaskRepository {
  readonly tasks = new Map<string, AssistantTask>();
  async create(input: Parameters<TaskRepository["create"]>[0]): Promise<AssistantTask> {
    const now = new Date().toISOString();
    const task: AssistantTask = { id: randomUUID(), status: "working", payload: {}, attempts: 0, createdAt: now, updatedAt: now, ...input };
    this.tasks.set(task.id, task);
    return structuredClone(task);
  }
  async get(id: string) { const task = this.tasks.get(id); return task && structuredClone(task); }
  async update(id: string, change: TaskChange): Promise<AssistantTask> {
    const task = this.tasks.get(id);
    if (!task) throw Object.assign(new Error("Task was not found"), { status: 404 });
    Object.assign(task, change, { updatedAt: new Date(Date.now() + 1).toISOString() });
    if (change.status && change.status !== "needs_you" && !("needs" in change)) delete task.needs;
    for (const key of Object.keys(task) as Array<keyof AssistantTask>) if (task[key] === undefined) delete task[key];
    return structuredClone(task);
  }
  async open(accountId: string) { return [...this.tasks.values()].filter(task => task.accountId === accountId && task.status !== "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(task => structuredClone(task)); }
  async expired(now: Date) { return [...this.tasks.values()].filter(task => task.status === "working" && task.leaseExpiresAt && task.leaseExpiresAt < now.toISOString()).map(task => structuredClone(task)); }
  async pokes(accountId: string, limit: number) { return [...this.tasks.values()].filter(task => task.accountId === accountId && task.kind === "poke").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(task => structuredClone(task)); }
  async bySession(sessionId: string) { const task = [...this.tasks.values()].filter(task => task.status !== "done" && task.session?.sessionId === sessionId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]; return task && structuredClone(task); }
}

function fromRow(row: Record<string, any>): AssistantTask {
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" ? value : undefined;
  const task: AssistantTask = {
    id: row.id, accountId: row.account_id, kind: row.kind, status: row.status, origin: row.origin, payload: row.payload ?? {},
    attempts: Number(row.attempts ?? 0), createdAt: iso(row.created_at)!, updatedAt: iso(row.updated_at)!,
  };
  if (row.product_id) task.productId = row.product_id;
  if (row.needs) task.needs = row.needs;
  if (row.session) task.session = row.session;
  if (row.output_ref) task.outputRef = row.output_ref;
  if (row.summary) task.summary = row.summary;
  if (row.answered_at) task.answeredAt = iso(row.answered_at);
  if (row.lease_expires_at) task.leaseExpiresAt = iso(row.lease_expires_at);
  if (row.last_error) task.lastError = row.last_error;
  return task;
}
