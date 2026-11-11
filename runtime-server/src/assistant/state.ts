import type { Pool } from "pg";
import type { ChannelKind } from "../channels/types.js";

/** Where the Expert last spoke: a reply goes back there, and a message the Assistant starts goes there too. */
export type LastExpert = { source: "web" | ChannelKind; at: string; messageRef?: string };

/**
 * Port: what the Assistant knows about an Expert that is not the conversation. The conversation itself, with its
 * messages and Runs, belongs to Chat alone.
 */
export interface AssistantStateRepository {
  lastExpert(accountId: string): Promise<LastExpert | undefined>;
  expertSpoke(accountId: string, last: LastExpert): Promise<void>;
}

export class PostgresAssistantState implements AssistantStateRepository {
  private constructor(private pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresAssistantState> {
    // The interview and held columns are no longer read or written; rows that still carry them are inert. They are not dropped.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_assistant_state (
        account_id UUID PRIMARY KEY,
        interview JSONB,
        last_expert JSONB,
        held JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    return new PostgresAssistantState(pool);
  }

  async lastExpert(accountId: string): Promise<LastExpert | undefined> {
    return (await this.pool.query("SELECT last_expert FROM hatch_assistant_state WHERE account_id = $1", [accountId])).rows[0]?.last_expert ?? undefined;
  }

  async expertSpoke(accountId: string, last: LastExpert): Promise<void> {
    await this.pool.query(`
      INSERT INTO hatch_assistant_state (account_id, last_expert) VALUES ($1, $2::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET last_expert = EXCLUDED.last_expert, updated_at = now()`, [accountId, JSON.stringify(last)]);
  }
}

/** Explicit test dependency; the product never constructs this repository. */
export class MemoryAssistantState implements AssistantStateRepository {
  private readonly rows = new Map<string, { lastExpert?: LastExpert }>();
  private row(accountId: string) { let row = this.rows.get(accountId); if (!row) { row = {}; this.rows.set(accountId, row); } return row; }
  async lastExpert(accountId: string) { const last = this.rows.get(accountId)?.lastExpert; return last && { ...last }; }
  async expertSpoke(accountId: string, last: LastExpert) { this.row(accountId).lastExpert = { ...last }; }
}
