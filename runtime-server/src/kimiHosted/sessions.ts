import type { PostgresQueryExecutor } from "../postgresStore.js";

/** A Kimi session that works for one of our conversations, and what we have done with it. */
export type KimiSessionRecord = {
  sessionId: string; conversationId: string; runId: string;
  /** The Brief message was sent: a session that has it is never sent it again. */
  messageSent: boolean;
  /** Where the event stream was read up to, so a restarted Runtime resumes there. */
  cursor?: string;
  /** artifact id -> the link of its published page. */
  pages: Record<string, string>;
  finished: boolean;
};

/**
 * The durable side of a hosted Run, kept apart from the Run's own record so the shared Run code stays as it is.
 * A restart interrupts the Run and starts a new one in the same conversation (see RestartRetrier); the new Run finds
 * the conversation's unfinished session here and watches that, instead of making another.
 */
export interface KimiSessions {
  /** The conversation's latest session that is not finished. */
  open(conversationId: string): Promise<KimiSessionRecord | undefined>;
  create(record: Pick<KimiSessionRecord, "sessionId" | "conversationId" | "runId">): Promise<void>;
  /** The Run that now watches the session. */
  adopt(sessionId: string, runId: string): Promise<void>;
  markMessageSent(sessionId: string): Promise<void>;
  saveCursor(sessionId: string, cursor: string): Promise<void>;
  /** Records the page of an artifact once: when it was already recorded, the earlier link is returned and the new one dropped. */
  recordPage(sessionId: string, artifactId: string, url: string): Promise<string>;
  finish(sessionId: string): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_kimi_sessions (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  message_sent BOOLEAN NOT NULL DEFAULT false,
  cursor TEXT,
  pages JSONB NOT NULL DEFAULT '{}',
  finished BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hatch_kimi_sessions_conversation_idx ON hatch_kimi_sessions (conversation_id, created_at DESC);`;

type Row = { session_id: string; conversation_id: string; run_id: string; message_sent: boolean; cursor: string | null; pages: Record<string, string>; finished: boolean };
const recordOf = (row: Row): KimiSessionRecord => ({ sessionId: row.session_id, conversationId: row.conversation_id, runId: row.run_id, messageSent: row.message_sent, ...row.cursor ? { cursor: row.cursor } : {}, pages: row.pages, finished: row.finished });

export class PostgresKimiSessions implements KimiSessions {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async initialize(): Promise<void> { await this.db.query(SCHEMA); }
  async open(conversationId: string) {
    const row = (await this.db.query("SELECT * FROM hatch_kimi_sessions WHERE conversation_id = $1 AND NOT finished ORDER BY created_at DESC LIMIT 1", [conversationId])).rows[0] as Row | undefined;
    return row && recordOf(row);
  }
  async create({ sessionId, conversationId, runId }: Pick<KimiSessionRecord, "sessionId" | "conversationId" | "runId">) {
    await this.db.query("INSERT INTO hatch_kimi_sessions (session_id, conversation_id, run_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [sessionId, conversationId, runId]);
  }
  async adopt(sessionId: string, runId: string) { await this.db.query("UPDATE hatch_kimi_sessions SET run_id = $2 WHERE session_id = $1", [sessionId, runId]); }
  async markMessageSent(sessionId: string) { await this.db.query("UPDATE hatch_kimi_sessions SET message_sent = true WHERE session_id = $1", [sessionId]); }
  async saveCursor(sessionId: string, cursor: string) { await this.db.query("UPDATE hatch_kimi_sessions SET cursor = $2 WHERE session_id = $1", [sessionId, cursor]); }
  async recordPage(sessionId: string, artifactId: string, url: string) {
    // One statement: the first link recorded for an artifact stays, whoever asks again.
    const result = await this.db.query(
      `UPDATE hatch_kimi_sessions SET pages = CASE WHEN pages ? $2::text THEN pages ELSE pages || jsonb_build_object($2::text, $3::text) END WHERE session_id = $1 RETURNING pages ->> $2::text AS url`,
      [sessionId, artifactId, url]);
    return (result.rows[0] as { url: string }).url;
  }
  async finish(sessionId: string) { await this.db.query("UPDATE hatch_kimi_sessions SET finished = true WHERE session_id = $1", [sessionId]); }
}

export class MemoryKimiSessions implements KimiSessions {
  readonly rows: KimiSessionRecord[] = [];
  private find(sessionId: string) { const row = this.rows.find(r => r.sessionId === sessionId); if (!row) throw new Error(`No session ${sessionId}`); return row; }
  async open(conversationId: string) { const row = [...this.rows].reverse().find(r => r.conversationId === conversationId && !r.finished); return row && structuredClone(row); }
  async create(record: Pick<KimiSessionRecord, "sessionId" | "conversationId" | "runId">) { if (!this.rows.some(r => r.sessionId === record.sessionId)) this.rows.push({ ...record, messageSent: false, pages: {}, finished: false }); }
  async adopt(sessionId: string, runId: string) { this.find(sessionId).runId = runId; }
  async markMessageSent(sessionId: string) { this.find(sessionId).messageSent = true; }
  async saveCursor(sessionId: string, cursor: string) { this.find(sessionId).cursor = cursor; }
  async recordPage(sessionId: string, artifactId: string, url: string) { const row = this.find(sessionId); return row.pages[artifactId] ??= url; }
  async finish(sessionId: string) { this.find(sessionId).finished = true; }
}
