import type { PostgresQueryExecutor } from "../postgresStore.js";
import { MAX_REPORT_ATTEMPTS, MAX_REPORT_STEPS, RETRY_BACKOFF_MS, type ReportKeys, type ReportRecord, type ReportRepository, type ReportStage, type ReportStep } from "./ports.js";

export const POSTGRES_ARTIFACT_REPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_artifact_reports (
  conversation_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  owner_account_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'generating', 'ready', 'failed')),
  stage TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 1,
  run_id TEXT,
  error TEXT,
  keys JSONB,
  steps JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  unlocked_at TIMESTAMPTZ,
  retry_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hatch_artifact_reports_owner ON hatch_artifact_reports (owner_account_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hatch_artifact_reports_retry ON hatch_artifact_reports (retry_at) WHERE retry_at IS NOT NULL;
`;

type Row = {
  conversation_id: string; product_id: string; owner_account_id: string; status: ReportRecord["status"]; stage: ReportStage; attempt: number; run_id: string | null;
  error: string | null; keys: ReportKeys | null; steps: ReportStep[]; created_at: Date | string; started_at: Date | string | null;
  ready_at: Date | string | null; unlocked_at: Date | string | null; retry_at: Date | string | null;
};
const iso = (value: Date | string) => new Date(value).toISOString();
const restore = (row: Row | undefined): ReportRecord | undefined => row && {
  conversationId: row.conversation_id, productId: row.product_id, ownerAccountId: row.owner_account_id, status: row.status, stage: row.stage, attempt: row.attempt,
  ...(row.run_id ? { runId: row.run_id } : {}), ...(row.error ? { error: row.error } : {}), ...(row.keys ? { keys: row.keys } : {}), steps: row.steps ?? [],
  createdAt: iso(row.created_at), ...(row.started_at ? { startedAt: iso(row.started_at) } : {}), ...(row.ready_at ? { readyAt: iso(row.ready_at) } : {}),
  ...(row.unlocked_at ? { unlockedAt: iso(row.unlocked_at) } : {}), ...(row.retry_at ? { retryAt: iso(row.retry_at) } : {})
};

const BACKOFF = [...RETRY_BACKOFF_MS];
const backoffMs = (attempt: number) => BACKOFF[Math.min(attempt, BACKOFF.length) - 1]!;

export class PostgresReportRepository implements ReportRepository {
  constructor(private readonly db: PostgresQueryExecutor) {}

  async initialize() { await this.db.query(POSTGRES_ARTIFACT_REPORT_SCHEMA); }

  private async one(sql: string, values: unknown[]) { return restore((await this.db.query<Row>(sql, values)).rows[0]); }

  get(conversationId: string) { return this.one("SELECT * FROM hatch_artifact_reports WHERE conversation_id = $1", [conversationId]); }

  async create(input: { conversationId: string; productId: string; ownerAccountId: string }) {
    await this.db.query("INSERT INTO hatch_artifact_reports (conversation_id, product_id, owner_account_id, status) VALUES ($1, $2, $3, 'draft') ON CONFLICT DO NOTHING",
      [input.conversationId, input.productId, input.ownerAccountId]);
    return (await this.get(input.conversationId))!;
  }

  async list(ownerAccountId: string, productId: string) {
    return (await this.db.query<Row>("SELECT * FROM hatch_artifact_reports WHERE owner_account_id = $1 AND product_id = $2 ORDER BY created_at DESC, conversation_id", [ownerAccountId, productId])).rows.map((row) => restore(row)!);
  }

  begin(conversationId: string, runId: string, now: Date) {
    return this.one(
      `UPDATE hatch_artifact_reports SET
         status = 'generating', error = NULL,
         attempt = CASE WHEN status IN ('draft', 'failed') THEN 1 ELSE attempt END,
         run_id = CASE WHEN status IN ('draft', 'failed') THEN $2 ELSE run_id END,
         stage = CASE WHEN status IN ('draft', 'failed') THEN 'queued' ELSE stage END,
         steps = CASE WHEN status IN ('draft', 'failed') THEN '[]'::jsonb ELSE steps END,
         started_at = CASE WHEN status IN ('draft', 'failed') THEN $3 ELSE started_at END,
         retry_at = NULL
       WHERE conversation_id = $1 AND (status IN ('draft', 'failed') OR (status = 'generating' AND run_id = $2)) RETURNING *`,
      [conversationId, runId, now]);
  }

  async progress(conversationId: string, attempt: number, stage: ReportStage, detail: string | undefined, now: Date) {
    const step: ReportStep = { at: now.toISOString(), stage, ...(detail ? { detail } : {}) };
    await this.db.query(
      `UPDATE hatch_artifact_reports SET stage = $3, steps = (
         SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb) FROM (
           SELECT item, ord FROM jsonb_array_elements(steps || $4::jsonb) WITH ORDINALITY AS t(item, ord) ORDER BY ord DESC LIMIT ${MAX_REPORT_STEPS}) latest)
       WHERE conversation_id = $1 AND attempt = $2 AND status = 'generating'`,
      [conversationId, attempt, stage, JSON.stringify([step])]);
  }

  ready(conversationId: string, attempt: number, keys: ReportKeys, now: Date) {
    return this.one(
      `UPDATE hatch_artifact_reports SET status = 'ready', stage = 'ready', error = NULL, keys = $3, ready_at = $4, retry_at = NULL
       WHERE conversation_id = $1 AND attempt = $2 AND status IN ('generating', 'ready') RETURNING *`,
      [conversationId, attempt, JSON.stringify(keys), now]);
  }

  runEnded(runId: string, reason: string, now: Date) {
    return this.one(
      `UPDATE hatch_artifact_reports SET
         status = CASE WHEN attempt >= $3 THEN 'failed' ELSE 'generating' END,
         stage = CASE WHEN attempt >= $3 THEN 'failed' ELSE 'queued' END,
         error = $2,
         retry_at = CASE WHEN attempt >= $3 THEN NULL ELSE $4::timestamptz + (CASE WHEN attempt = 1 THEN $5::int ELSE $6::int END) * interval '1 millisecond' END
       WHERE run_id = $1 AND status IN ('draft', 'generating') RETURNING *`,
      [runId, reason, MAX_REPORT_ATTEMPTS, now, backoffMs(1), backoffMs(2)]);
  }

  async due(now: Date) {
    return (await this.db.query<{ conversation_id: string; attempt: number }>(
      "SELECT conversation_id, attempt FROM hatch_artifact_reports WHERE status = 'generating' AND retry_at IS NOT NULL AND retry_at <= $1 ORDER BY retry_at LIMIT 50", [now]))
      .rows.map((row) => ({ conversationId: row.conversation_id, attempt: row.attempt }));
  }

  claim(conversationId: string, attempt: number, runId: string, now: Date, leaseMs: number) {
    return this.one(
      `UPDATE hatch_artifact_reports SET attempt = attempt + 1, status = 'generating', stage = 'queued', run_id = $3, retry_at = $4::timestamptz + $5::int * interval '1 millisecond'
       WHERE conversation_id = $1 AND attempt = $2 AND status = 'generating' AND retry_at IS NOT NULL AND retry_at <= $4 RETURNING *`,
      [conversationId, attempt, runId, now, leaseMs]);
  }

  async unlock(conversationId: string) {
    await this.db.query("UPDATE hatch_artifact_reports SET unlocked_at = COALESCE(unlocked_at, now()) WHERE conversation_id = $1", [conversationId]);
  }
}

/** For tests and single-node development; the same contract as the database adapter (each method is one synchronous step). */
export class InMemoryReportRepository implements ReportRepository {
  private readonly rows = new Map<string, ReportRecord>();
  private put(next: ReportRecord) { this.rows.set(next.conversationId, next); return next; }

  async initialize() { return; }
  async get(conversationId: string) { return this.rows.get(conversationId); }

  async create(input: { conversationId: string; productId: string; ownerAccountId: string }) {
    return this.rows.get(input.conversationId) ?? this.put({ ...input, status: "draft", stage: "queued", attempt: 1, steps: [], createdAt: new Date().toISOString() });
  }
  async list(ownerAccountId: string, productId: string) {
    return [...this.rows.values()].filter((r) => r.ownerAccountId === ownerAccountId && r.productId === productId).reverse();
  }
  async begin(conversationId: string, runId: string, now: Date) {
    const row = this.rows.get(conversationId);
    if (!row) return undefined;
    const { error: _error, retryAt: _retryAt, ...rest } = row;
    if (row.status === "draft" || row.status === "failed") return this.put({ ...rest, status: "generating", attempt: 1, runId, stage: "queued", steps: [], startedAt: now.toISOString() });
    if (row.status === "generating" && row.runId === runId) return this.put({ ...rest });
    return undefined;
  }
  async progress(conversationId: string, attempt: number, stage: ReportStage, detail: string | undefined, now: Date) {
    const row = this.rows.get(conversationId);
    if (row?.status !== "generating" || row.attempt !== attempt) return;
    this.put({ ...row, stage, steps: [...row.steps, { at: now.toISOString(), stage, ...(detail ? { detail } : {}) }].slice(-MAX_REPORT_STEPS) });
  }
  async ready(conversationId: string, attempt: number, keys: ReportKeys, now: Date) {
    const row = this.rows.get(conversationId);
    if (!row || row.attempt !== attempt || (row.status !== "generating" && row.status !== "ready")) return undefined;
    const { error: _error, retryAt: _retryAt, ...rest } = row;
    return this.put({ ...rest, status: "ready", stage: "ready", keys, readyAt: now.toISOString() });
  }
  async runEnded(runId: string, reason: string, now: Date) {
    const row = [...this.rows.values()].find((r) => r.runId === runId);
    if (!row || (row.status !== "draft" && row.status !== "generating")) return undefined;
    if (row.attempt >= MAX_REPORT_ATTEMPTS) { const { retryAt: _retryAt, ...rest } = row; return this.put({ ...rest, status: "failed", stage: "failed", error: reason }); }
    return this.put({ ...row, status: "generating", stage: "queued", error: reason, retryAt: new Date(now.getTime() + backoffMs(row.attempt)).toISOString() });
  }
  async due(now: Date) {
    return [...this.rows.values()].filter((r) => r.status === "generating" && r.retryAt && Date.parse(r.retryAt) <= now.getTime()).map((r) => ({ conversationId: r.conversationId, attempt: r.attempt }));
  }
  async claim(conversationId: string, attempt: number, runId: string, now: Date, leaseMs: number) {
    const row = this.rows.get(conversationId);
    if (!row || row.attempt !== attempt || row.status !== "generating" || !row.retryAt || Date.parse(row.retryAt) > now.getTime()) return undefined;
    return this.put({ ...row, attempt: attempt + 1, stage: "queued", runId, retryAt: new Date(now.getTime() + leaseMs).toISOString() });
  }
  async unlock(conversationId: string) {
    const row = this.rows.get(conversationId);
    if (row) this.put({ ...row, unlockedAt: row.unlockedAt ?? new Date().toISOString() });
  }
}
