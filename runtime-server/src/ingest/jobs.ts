import type { Pool } from "pg";
import { isUnfinished, type IngestJob } from "./job.js";
import type { IngestJobRepository } from "./ports.js";

export class PostgresIngestJobs implements IngestJobRepository {
  private constructor(private readonly pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresIngestJobs> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_ingest_jobs (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL,
        product_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
        context TEXT NOT NULL DEFAULT '',
        items JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hatch_ingest_jobs_product_idx ON hatch_ingest_jobs (account_id, product_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS hatch_ingest_jobs_unfinished_idx ON hatch_ingest_jobs (status) WHERE status IN ('queued', 'running');
    `);
    return new PostgresIngestJobs(pool);
  }
  async create(job: IngestJob) {
    const { rowCount } = await this.pool.query(
      `INSERT INTO hatch_ingest_jobs (id, account_id, product_id, status, context, items, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
      [job.id, job.accountId, job.productId, job.status, job.context, JSON.stringify(job.items), job.error ?? null, job.createdAt, job.updatedAt],
    );
    return rowCount === 1;
  }
  async save(job: IngestJob) {
    await this.pool.query(
      "UPDATE hatch_ingest_jobs SET status = $2, items = $3::jsonb, error = $4, updated_at = $5 WHERE id = $1",
      [job.id, job.status, JSON.stringify(job.items), job.error ?? null, job.updatedAt],
    );
  }
  async get(accountId: string, productId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = (await this.pool.query("SELECT * FROM hatch_ingest_jobs WHERE id = $1 AND account_id = $2 AND product_id = $3", [id, accountId, productId])).rows[0];
    return row ? fromRow(row) : undefined;
  }
  async recent(accountId: string, productId: string, limit: number) {
    return (await this.pool.query("SELECT * FROM hatch_ingest_jobs WHERE account_id = $1 AND product_id = $2 ORDER BY created_at DESC LIMIT $3", [accountId, productId, limit])).rows.map(fromRow);
  }
  async touch(id: string, now: string) {
    await this.pool.query("UPDATE hatch_ingest_jobs SET updated_at = $2 WHERE id = $1 AND status IN ('queued', 'running')", [id, now]);
  }
  async unfinished(staleBefore: string) {
    return (await this.pool.query("SELECT * FROM hatch_ingest_jobs WHERE status IN ('queued', 'running') AND updated_at < $1", [staleBefore])).rows.map(fromRow);
  }
}

/** Explicit test dependency; the product never constructs this store. */
export class MemoryIngestJobs implements IngestJobRepository {
  readonly jobs = new Map<string, IngestJob>();
  async create(job: IngestJob) {
    if (this.jobs.has(job.id)) return false;
    this.jobs.set(job.id, structuredClone(job));
    return true;
  }
  async save(job: IngestJob) { this.jobs.set(job.id, structuredClone(job)); }
  async get(accountId: string, productId: string, id: string) {
    const job = this.jobs.get(id);
    return job && job.accountId === accountId && job.productId === productId ? structuredClone(job) : undefined;
  }
  async recent(accountId: string, productId: string, limit: number) {
    return [...this.jobs.values()].filter(job => job.accountId === accountId && job.productId === productId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(job => structuredClone(job));
  }
  async touch(id: string, now: string) { const job = this.jobs.get(id); if (job && isUnfinished(job)) job.updatedAt = now; }
  async unfinished(staleBefore: string) { return [...this.jobs.values()].filter(job => isUnfinished(job) && job.updatedAt < staleBefore).map(job => structuredClone(job)); }
}

const fromRow = (row: Record<string, any>): IngestJob => {
  const iso = (value: unknown) => value instanceof Date ? value.toISOString() : String(value);
  return {
    id: row.id, accountId: row.account_id, productId: row.product_id, status: row.status, context: row.context ?? "",
    items: row.items ?? [], createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    ...(row.error ? { error: row.error } : {}),
  };
};
