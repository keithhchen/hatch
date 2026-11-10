import type { ChannelKind } from "../channels/types.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export const TASK_KINDS = ["interview", "content", "research", "agent_research", "build", "evaluate", "poke", "change"] as const;
export type TaskKind = typeof TASK_KINDS[number];
export type TaskStatus = "working" | "needs_you" | "done";
export type TaskNeeds = "answer" | "review" | "blocked";
/** Where a task came from and where its replies go. */
export type TaskOrigin = { source: "web" | ChannelKind | "tick" | "consumer" };
/** The workbench session executing the task. Product sessions carry productId; Assistant-workspace sessions do not. */
export type TaskSession = { scope: "product" | "assistant"; sessionId: string };

/** How the Expert decided a task waiting for them. `key` is the decider's own: a button press, a page click, a tool call. */
export type TaskDecision = { action: "approve" | "decline"; key: string; at: string };

/** A decision that cannot be taken now: the task is out of the Expert's hands, or was decided the other way. The Expert is told why. */
export class TaskRefused extends Error { readonly status = 409; }

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
  /** Set once, in the same step that finishes the task, and never changed. */
  decision?: TaskDecision;
  answeredAt?: string;
  leaseExpiresAt?: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskChange = Partial<Pick<AssistantTask, "status" | "needs" | "session" | "payload" | "outputRef" | "summary" | "answeredAt" | "leaseExpiresAt" | "lastError" | "attempts">>;

const VERB = { approve: "确认", decline: "取消" } as const;
const PAST = { approve: "已确认", decline: "已取消" } as const;

/**
 * The rules of deciding, kept apart from any store so every store keeps them. Deciding a task again the same way is a replay and
 * changes nothing (undefined); the other way is refused; otherwise it returns what the decision changes.
 */
export function settle(task: AssistantTask, action: TaskDecision["action"], key: string, at = new Date().toISOString()): { change: TaskChange; decision: TaskDecision } | undefined {
  if (task.decision) {
    if (task.decision.action === action) return undefined;
    throw new TaskRefused(`这件事${PAST[task.decision.action]}了，不能再${VERB[action]}`);
  }
  if (task.status !== "needs_you" || (action === "approve" && task.needs !== "review")) throw new TaskRefused(action === "approve" ? "这件事现在不需要确认" : "这件事已经结束了");
  return { change: { status: "done", summary: `${task.summary ?? ""}（${PAST[action]}）` }, decision: { action, key, at } };
}

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
  /**
   * The Expert decides a waiting task, once. The decision is recorded in the same step that finishes the task, and `effect` (what
   * approving does to the world) runs inside that step: if it throws, nothing is recorded and the task still waits. Asked again
   * the same way, it returns the recorded task with `replayed` and runs nothing; the other way is refused with TaskRefused.
   */
  decide(id: string, decision: Pick<TaskDecision, "action" | "key">, effect: (task: AssistantTask) => Promise<void>): Promise<{ task: AssistantTask; replayed: boolean }>;
  /** Tasks that were created or announced in a Run (`payload.run`), so its reply can offer their buttons. */
  byRun(runId: string): Promise<AssistantTask[]>;
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
        decision JSONB,
        answered_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      ALTER TABLE hatch_assistant_tasks ADD COLUMN IF NOT EXISTS decision JSONB;
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
  async decide(id: string, { action, key }: Pick<TaskDecision, "action" | "key">, effect: (task: AssistantTask) => Promise<void>): Promise<{ task: AssistantTask; replayed: boolean }> {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Object.assign(new Error("Task was not found"), { status: 404 });
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The row lock makes a second decider wait, then see the first one's decision.
      const row = (await client.query("SELECT * FROM hatch_assistant_tasks WHERE id = $1 FOR UPDATE", [id])).rows[0];
      if (!row) throw Object.assign(new Error("Task was not found"), { status: 404 });
      const task = fromRow(row);
      const settled = settle(task, action, key);
      if (!settled) { await client.query("COMMIT"); return { task, replayed: true }; }
      await effect(task);
      const done = (await client.query("UPDATE hatch_assistant_tasks SET status = $2, needs = NULL, summary = $3, decision = $4::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *", [id, settled.change.status, settled.change.summary, JSON.stringify(settled.decision)])).rows[0];
      await client.query("COMMIT");
      return { task: fromRow(done), replayed: false };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
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
  async byRun(runId: string): Promise<AssistantTask[]> {
    return (await this.pool.query("SELECT * FROM hatch_assistant_tasks WHERE payload->>'run' = $1 ORDER BY created_at LIMIT 20", [runId])).rows.map(fromRow);
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
  private deciding = new Map<string, Promise<unknown>>();
  async decide(id: string, { action, key }: Pick<TaskDecision, "action" | "key">, effect: (task: AssistantTask) => Promise<void>): Promise<{ task: AssistantTask; replayed: boolean }> {
    const run = async () => {
      const task = this.tasks.get(id);
      if (!task) throw Object.assign(new Error("Task was not found"), { status: 404 });
      const settled = settle(task, action, key);
      if (!settled) return { task: structuredClone(task), replayed: true };
      await effect(structuredClone(task));
      Object.assign(task, settled.change, { decision: settled.decision, updatedAt: new Date(Date.now() + 1).toISOString() });
      delete task.needs;
      return { task: structuredClone(task), replayed: false };
    };
    // One decider at a time per task, as the row lock does in Postgres.
    const turn = (this.deciding.get(id) ?? Promise.resolve()).then(run, run);
    this.deciding.set(id, turn.catch(() => undefined));
    return turn;
  }
  async open(accountId: string) { return [...this.tasks.values()].filter(task => task.accountId === accountId && task.status !== "done").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(task => structuredClone(task)); }
  async expired(now: Date) { return [...this.tasks.values()].filter(task => task.status === "working" && task.leaseExpiresAt && task.leaseExpiresAt < now.toISOString()).map(task => structuredClone(task)); }
  async pokes(accountId: string, limit: number) { return [...this.tasks.values()].filter(task => task.accountId === accountId && task.kind === "poke").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(task => structuredClone(task)); }
  async byRun(runId: string) { return [...this.tasks.values()].filter(task => task.payload.run === runId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(task => structuredClone(task)); }
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
  if (row.decision) task.decision = row.decision;
  if (row.answered_at) task.answeredAt = iso(row.answered_at);
  if (row.lease_expires_at) task.leaseExpiresAt = iso(row.lease_expires_at);
  if (row.last_error) task.lastError = row.last_error;
  return task;
}
