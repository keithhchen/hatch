import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import type { EventCursor } from "../surfaces/contract.js";
import type { ConversationEvent, Unsubscribe } from "./conversation.js";
import type { EventLog, LoggedEvent } from "./eventLog.js";

/** The log in the Registry database, shared by every process. */
export class PostgresEventLog implements EventLog {
  private wakes = new EventEmitter().setMaxListeners(0);
  private constructor(private pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresEventLog> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_conversation_event_heads (key TEXT PRIMARY KEY, seq BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS hatch_conversation_event_log (
        key TEXT NOT NULL,
        seq BIGINT NOT NULL,
        event JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (key, seq)
      );
    `);
    return new PostgresEventLog(pool);
  }

  /** One statement: the head row's lock makes the next seq and its commit follow each other, so a reader never skips a position. */
  private async insert(db: Pick<Pool, "query">, key: string, event: ConversationEvent): Promise<EventCursor> {
    const { rows } = await db.query<{ seq: string }>(`
      WITH next AS (
        INSERT INTO hatch_conversation_event_heads (key, seq) VALUES ($1, 1)
        ON CONFLICT (key) DO UPDATE SET seq = hatch_conversation_event_heads.seq + 1
        RETURNING seq
      )
      INSERT INTO hatch_conversation_event_log (key, seq, event) SELECT $1, seq, $2::jsonb FROM next RETURNING seq`, [key, JSON.stringify(event)]);
    return rows[0]!.seq;
  }

  async append(key: string, event: ConversationEvent): Promise<EventCursor> {
    const cursor = await this.insert(this.pool, key, event);
    this.wakes.emit(key);
    return cursor;
  }

  /** The database decides who goes first: writers take the key's advisory lock exclusively, readers share it, and it ends with the transaction. */
  private async locked<T>(key: string, mode: "" | "_shared", step: (db: Pick<Pool, "query">) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock${mode}(hashtextextended($1, 0))`, [key]);
      const result = await step(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  /** The event is appended inside the transaction and `work` runs before it commits: a failed `work` leaves no event. */
  async commit<T>(key: string, event: ConversationEvent, work: () => Promise<T>): Promise<T> {
    const result = await this.locked(key, "", async db => { await this.insert(db, key, event); return work(); });
    this.wakes.emit(key);
    return result;
  }

  consistent<T>(key: string, read: (head: EventCursor) => Promise<T>): Promise<T> {
    return this.locked(key, "_shared", async db => read((await db.query<{ seq: string }>("SELECT seq FROM hatch_conversation_event_heads WHERE key = $1", [key])).rows[0]?.seq ?? "0"));
  }

  async after(key: string, cursor: EventCursor, limit = 500): Promise<LoggedEvent[]> {
    const { rows } = await this.pool.query<{ seq: string; event: ConversationEvent }>(
      "SELECT seq, event FROM hatch_conversation_event_log WHERE key = $1 AND seq > $2 ORDER BY seq LIMIT $3", [key, cursor, limit]);
    return rows.map(row => ({ cursor: row.seq, event: row.event }));
  }

  async head(key: string): Promise<EventCursor> {
    const { rows } = await this.pool.query<{ seq: string }>("SELECT seq FROM hatch_conversation_event_heads WHERE key = $1", [key]);
    return rows[0]?.seq ?? "0";
  }

  onAppend(key: string, wake: () => void): Unsubscribe { this.wakes.on(key, wake); return () => { this.wakes.off(key, wake); }; }
}
