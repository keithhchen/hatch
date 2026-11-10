import type { Pool } from "pg";
import type { ChannelKind } from "../channels/types.js";

/** An interview holds the Assistant's conversation: the Expert's words go to it until it hands back. */
export type Interview = { taskId: string; productId: string; sessionId: string; /** How much of the interview's own history has been told to the Expert. */ relayFrom: number };

/** News for the Assistant that waited because an interview held the conversation. */
export type HeldNews = { id: string; text: string; taskId?: string };

/** Where the Expert last spoke: a reply goes back there, and a message the Assistant starts goes there too. */
export type LastExpert = { source: "web" | ChannelKind; at: string; messageRef?: string };

/**
 * Port: what the Assistant knows about an Expert that is not the conversation. The conversation itself, with its
 * messages and Runs, belongs to Chat alone.
 */
export interface AssistantStateRepository {
  interview(accountId: string): Promise<Interview | undefined>;
  /** False when an interview is already going. */
  startInterview(accountId: string, interview: Interview): Promise<boolean>;
  advanceInterview(accountId: string, taskId: string, relayFrom: number): Promise<void>;
  endInterview(accountId: string, taskId: string): Promise<void>;
  lastExpert(accountId: string): Promise<LastExpert | undefined>;
  expertSpoke(accountId: string, last: LastExpert): Promise<void>;
  /** Keeps news until the interview hands back. Repeating an id keeps it once. */
  hold(accountId: string, news: HeldNews): Promise<void>;
  /** Everything held, oldest first; it is held no more. */
  takeHeld(accountId: string): Promise<HeldNews[]>;
}

export class PostgresAssistantState implements AssistantStateRepository {
  private constructor(private pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresAssistantState> {
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

  async interview(accountId: string): Promise<Interview | undefined> {
    return (await this.pool.query("SELECT interview FROM hatch_assistant_state WHERE account_id = $1", [accountId])).rows[0]?.interview ?? undefined;
  }

  async startInterview(accountId: string, interview: Interview): Promise<boolean> {
    const row = (await this.pool.query(`
      INSERT INTO hatch_assistant_state (account_id, interview) VALUES ($1, $2::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET interview = EXCLUDED.interview, updated_at = now() WHERE hatch_assistant_state.interview IS NULL
      RETURNING account_id`, [accountId, JSON.stringify(interview)])).rows[0];
    return Boolean(row);
  }

  async advanceInterview(accountId: string, taskId: string, relayFrom: number): Promise<void> {
    await this.pool.query(`UPDATE hatch_assistant_state SET interview = jsonb_set(interview, '{relayFrom}', to_jsonb($3::int)), updated_at = now() WHERE account_id = $1 AND interview->>'taskId' = $2`, [accountId, taskId, relayFrom]);
  }

  async endInterview(accountId: string, taskId: string): Promise<void> {
    await this.pool.query("UPDATE hatch_assistant_state SET interview = NULL, updated_at = now() WHERE account_id = $1 AND interview->>'taskId' = $2", [accountId, taskId]);
  }

  async lastExpert(accountId: string): Promise<LastExpert | undefined> {
    return (await this.pool.query("SELECT last_expert FROM hatch_assistant_state WHERE account_id = $1", [accountId])).rows[0]?.last_expert ?? undefined;
  }

  async expertSpoke(accountId: string, last: LastExpert): Promise<void> {
    await this.pool.query(`
      INSERT INTO hatch_assistant_state (account_id, last_expert) VALUES ($1, $2::jsonb)
      ON CONFLICT (account_id) DO UPDATE SET last_expert = EXCLUDED.last_expert, updated_at = now()`, [accountId, JSON.stringify(last)]);
  }

  async hold(accountId: string, news: HeldNews): Promise<void> {
    await this.pool.query(`
      INSERT INTO hatch_assistant_state (account_id, held) VALUES ($1, jsonb_build_array($2::jsonb))
      ON CONFLICT (account_id) DO UPDATE SET held = hatch_assistant_state.held || jsonb_build_array($2::jsonb), updated_at = now()
      WHERE NOT hatch_assistant_state.held @> jsonb_build_array(jsonb_build_object('id', $2::jsonb->>'id'))`, [accountId, JSON.stringify(news)]);
  }

  async takeHeld(accountId: string): Promise<HeldNews[]> {
    const row = (await this.pool.query(`
      UPDATE hatch_assistant_state AS state SET held = '[]'::jsonb, updated_at = now()
      FROM (SELECT held FROM hatch_assistant_state WHERE account_id = $1 FOR UPDATE) AS before
      WHERE state.account_id = $1 RETURNING before.held AS held`, [accountId])).rows[0];
    return row?.held ?? [];
  }
}

/** Explicit test dependency; the product never constructs this repository. */
export class MemoryAssistantState implements AssistantStateRepository {
  private readonly rows = new Map<string, { interview?: Interview; lastExpert?: LastExpert; held?: HeldNews[] }>();
  private row(accountId: string) { let row = this.rows.get(accountId); if (!row) { row = {}; this.rows.set(accountId, row); } return row; }
  async interview(accountId: string) { const interview = this.rows.get(accountId)?.interview; return interview && { ...interview }; }
  async startInterview(accountId: string, interview: Interview) { const row = this.row(accountId); if (row.interview) return false; row.interview = { ...interview }; return true; }
  async advanceInterview(accountId: string, taskId: string, relayFrom: number) { const row = this.rows.get(accountId); if (row?.interview?.taskId === taskId) row.interview.relayFrom = relayFrom; }
  async endInterview(accountId: string, taskId: string) { const row = this.rows.get(accountId); if (row?.interview?.taskId === taskId) delete row.interview; }
  async lastExpert(accountId: string) { const last = this.rows.get(accountId)?.lastExpert; return last && { ...last }; }
  async expertSpoke(accountId: string, last: LastExpert) { this.row(accountId).lastExpert = { ...last }; }
  async hold(accountId: string, news: HeldNews) { const row = this.row(accountId); row.held ??= []; if (!row.held.some(held => held.id === news.id)) row.held.push({ ...news }); }
  async takeHeld(accountId: string) { const row = this.rows.get(accountId); const held = row?.held ?? []; if (row) row.held = []; return held; }
}
