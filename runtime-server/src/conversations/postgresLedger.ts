import type { Pool } from "pg";
import type { Sent } from "./conversation.js";
import type { Claim, MessageLedger } from "./ledger.js";

/** The ledger in the Registry database: the primary key is what makes a key mean one message across processes. */
export class PostgresMessageLedger implements MessageLedger {
  private constructor(private pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresMessageLedger> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_conversation_messages (
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        digest TEXT NOT NULL,
        sent JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope, key)
      )`);
    return new PostgresMessageLedger(pool);
  }

  /** The no-op update makes RETURNING yield the existing row; xmax is 0 only for a row this statement inserted. */
  async claim(scope: string, key: string, digest: string, sent: Sent): Promise<Claim> {
    const { rows } = await this.pool.query<{ digest: string; sent: Sent; fresh: boolean }>(`
      INSERT INTO hatch_conversation_messages (scope, key, digest, sent) VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (scope, key) DO UPDATE SET scope = EXCLUDED.scope
      RETURNING digest, sent, (xmax = 0) AS fresh`, [scope, key, digest, JSON.stringify(sent)]);
    const row = rows[0]!;
    return row.fresh ? { fresh: true } : { fresh: false, digest: row.digest, sent: row.sent };
  }

  async settle(scope: string, key: string, sent: Sent): Promise<void> {
    await this.pool.query("UPDATE hatch_conversation_messages SET sent = $3::jsonb WHERE scope = $1 AND key = $2", [scope, key, JSON.stringify(sent)]);
  }

  async release(scope: string, key: string): Promise<void> {
    await this.pool.query("DELETE FROM hatch_conversation_messages WHERE scope = $1 AND key = $2", [scope, key]);
  }
}
