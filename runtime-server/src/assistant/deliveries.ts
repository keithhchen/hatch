import type { Pool } from "pg";

/**
 * Port: Runs the Assistant started on its own, such as news from a worker or the daily check, whose final reply is still
 * owed to the Expert. A Run the Expert started through a chat is answered through that chat's inbox; these have none.
 */
export interface DeliveryRepository {
  /** Remembers that this Run's reply is owed to the account. Repeating a Run keeps one record. */
  owe(runId: string, accountId: string): Promise<void>;
  /** Runs whose reply is still owed, oldest first. */
  open(limit: number): Promise<Array<{ runId: string; accountId: string; createdAt: string }>>;
  /** The reply is queued, or there is none to queue. Closing twice is closing once. */
  done(runId: string): Promise<void>;
}

export class PostgresDeliveries implements DeliveryRepository {
  private constructor(private pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresDeliveries> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_assistant_deliveries (
        run_id TEXT PRIMARY KEY,
        account_id UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        taken_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS hatch_assistant_deliveries_open_idx ON hatch_assistant_deliveries (created_at) WHERE taken_at IS NULL;`);
    return new PostgresDeliveries(pool);
  }

  async owe(runId: string, accountId: string): Promise<void> {
    await this.pool.query("INSERT INTO hatch_assistant_deliveries (run_id, account_id) VALUES ($1, $2) ON CONFLICT (run_id) DO NOTHING", [runId, accountId]);
  }

  async open(limit: number): Promise<Array<{ runId: string; accountId: string; createdAt: string }>> {
    return (await this.pool.query("SELECT run_id, account_id, created_at FROM hatch_assistant_deliveries WHERE taken_at IS NULL ORDER BY created_at LIMIT $1", [limit])).rows
      .map(row => ({ runId: row.run_id, accountId: row.account_id, createdAt: new Date(row.created_at).toISOString() }));
  }

  async done(runId: string): Promise<void> {
    await this.pool.query("UPDATE hatch_assistant_deliveries SET taken_at = COALESCE(taken_at, now()) WHERE run_id = $1", [runId]);
  }
}

/** Explicit test dependency; the product never constructs this repository. */
export class MemoryDeliveries implements DeliveryRepository {
  private readonly rows = new Map<string, { accountId: string; createdAt: string; taken: boolean }>();
  async owe(runId: string, accountId: string) { if (!this.rows.has(runId)) this.rows.set(runId, { accountId, createdAt: new Date().toISOString(), taken: false }); }
  async open(limit: number) { return [...this.rows].filter(([, row]) => !row.taken).slice(0, limit).map(([runId, row]) => ({ runId, accountId: row.accountId, createdAt: row.createdAt })); }
  async done(runId: string) { const row = this.rows.get(runId); if (row) row.taken = true; }
}
