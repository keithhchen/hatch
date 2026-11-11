import type { Pool } from "pg";
import type { ChannelKind, InboundEvent } from "./types.js";

export type InboxItem = {
  id: string;
  channel: ChannelKind;
  scope: string;
  event: InboundEvent;
  attempts: number;
  connectionId?: string;
  runId?: string;
};

/** Who holds an event: the claim that leased it. `attempts` counts claims, so an older claim never matches a newer one. */
export type Lease = Pick<InboxItem, "id" | "attempts">;

/** The photos of an album arrive as separate events; the first is handled once no new one has come for this long. */
export const ALBUM_SETTLE_MS = 1500;

/** A thread with a message nobody has answered yet. */
export type WaitingThread = { connectionId: string; channel: ChannelKind; scope: string; threadId: string; senderId: string };

/** How long an unanswered message counts as a user still waiting. */
const WAITING_MS = 60 * 60_000;

/**
 * Port: every verified inbound event, stored before the platform is answered.
 * Processing is a lease, so a crash returns the event to the queue.
 */
export interface Inbox {
  /** The events not stored before. A repeat is refused by the database, whatever its timing. */
  store(channel: ChannelKind, scope: string, events: InboundEvent[], now?: Date, after?: { key: string; cursor: string }): Promise<InboxItem[]>;
  /**
   * Where a pull stopped, kept in one transaction with the events it fetched. It belongs to the platform tenant (scope) and
   * the notice's key, not to a Connection: several Connections share a tenant, so none of them can name it.
   */
  cursor(channel: ChannelKind, scope: string, key: string): Promise<string | undefined>;
  /** Leases the next unprocessed event of each thread. Events of one thread are handed out one at a time, in the platform's sequence when events carry one (`InboundEvent.sequence`) and in arrival order otherwise; an album's first waits until its album is complete. */
  claim(limit: number, leaseMs: number, now?: Date): Promise<InboxItem[]>;
  /** The other events of this event's album that are still waiting, in the thread's order. */
  siblings(item: InboxItem): Promise<InboxItem[]>;
  /**
   * Every write below belongs to the claim that holds the lease and to it alone: once the lease has run out, or another worker has
   * claimed the event, the write changes nothing and says so (false or undefined), so a slow worker cannot undo a faster one.
   */
  /** The claimant is alive: pushes its lease out, so a dead one is noticed after a short lease however long processing takes. */
  extend(lease: Lease, leaseMs: number, now?: Date): Promise<boolean>;
  /** Marks the event done, together with the `absorbed` events that were handled as part of it (the rest of an album). */
  complete(lease: Lease, outcome: { connectionId?: string; runId?: string; replied?: boolean }, absorbed?: string[], now?: Date): Promise<boolean>;
  /** Releases the lease after `delayMs`; after `maxAttempts` the event is given up and kept as failed. */
  retry(lease: Lease, error: string, delayMs: number, maxAttempts: number, now?: Date): Promise<"pending" | "failed" | undefined>;
  get(id: string): Promise<InboxItem | undefined>;
  /** When the platform last wrote to this thread. */
  lastInbound(channel: ChannelKind, scope: string, threadId: string): Promise<Date | undefined>;
  /** These events have been answered, and nothing else has. */
  markReplied(ids: string[]): Promise<void>;
  waiting(filter: { runId: string }, now?: Date): Promise<WaitingThread[]>;
  byRun(runId: string): Promise<InboxItem[]>;
  /** Runs started for a message nobody has answered yet, oldest first. */
  openRuns(limit: number): Promise<string[]>;
}

/**
 * The order of one thread's events: by the platform's sequence where it numbers them, then by arrival. An event without one comes
 * before the numbered ones, so a thread is always one total order whatever it holds. Only the events of one thread are compared,
 * and a thread belongs to one platform.
 */
const IN_ORDER = "COALESCE(sequence, -1), seq";
const BEFORE = "(COALESCE(earlier.sequence, -1), earlier.seq) < (COALESCE(i.sequence, -1), i.seq)";

const itemOf =(row: Record<string, any>): InboxItem => ({
  id: row.id, channel: row.channel, scope: row.scope, event: row.event, attempts: row.attempts,
  ...(row.connection_id ? { connectionId: row.connection_id } : {}), ...(row.run_id ? { runId: row.run_id } : {}),
});

export class PostgresInbox implements Inbox {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresInbox> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_channel_inbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seq BIGSERIAL NOT NULL,
        -- The platform's own order within a thread, when it has one. Arrival (seq) orders the rest.
        sequence BIGINT,
        channel TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        event_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        event JSONB NOT NULL,
        connection_id UUID REFERENCES hatch_connections (id) ON DELETE SET NULL,
        run_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        lease_until TIMESTAMPTZ,
        last_error TEXT,
        received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        replied_at TIMESTAMPTZ,
        -- A platform delivers an event more than once. The first write wins.
        UNIQUE (channel, scope, event_id)
      );
      CREATE INDEX IF NOT EXISTS hatch_channel_inbox_pending_idx ON hatch_channel_inbox (seq) WHERE state = 'pending';
      CREATE INDEX IF NOT EXISTS hatch_channel_inbox_thread_idx ON hatch_channel_inbox (channel, scope, thread_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS hatch_channel_inbox_run_idx ON hatch_channel_inbox (run_id) WHERE run_id IS NOT NULL;
    `);
    await pool.query("ALTER TABLE hatch_channel_inbox ADD COLUMN IF NOT EXISTS sequence BIGINT");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_channel_cursors (
        channel TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        cursor TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (channel, scope, key)
      )`);
    return new PostgresInbox(pool);
  }

  async store(channel: ChannelKind, scope: string, events: InboundEvent[], now = new Date(), after?: { key: string; cursor: string }): Promise<InboxItem[]> {
    const stored: InboxItem[] = [];
    const client = await this.pool.connect();
    try {
      // The events and the cursor commit together: a cursor never moves past an event that was not stored.
      if (after) await client.query("BEGIN");
      for (const event of events) {
        const row = (await client.query(`INSERT INTO hatch_channel_inbox (channel, scope, event_id, thread_id, sender_id, event, received_at, sequence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (channel, scope, event_id) DO NOTHING RETURNING *`, [channel, event.scope ?? scope, event.eventId, event.address.threadId, event.address.senderId, JSON.stringify(event), now, event.sequence ?? null])).rows[0];
        if (row) stored.push(itemOf(row));
      }
      if (after) {
        await client.query(`INSERT INTO hatch_channel_cursors (channel, scope, key, cursor, updated_at) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (channel, scope, key) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = EXCLUDED.updated_at`, [channel, scope, after.key, after.cursor, now]);
        await client.query("COMMIT");
      }
    } catch (error) {
      if (after) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
    return stored;
  }

  async cursor(channel: ChannelKind, scope: string, key: string): Promise<string | undefined> {
    return (await this.pool.query("SELECT cursor FROM hatch_channel_cursors WHERE channel = $1 AND scope = $2 AND key = $3", [channel, scope, key])).rows[0]?.cursor;
  }

  async claim(limit: number, leaseMs: number, now = new Date()): Promise<InboxItem[]> {
    const rows = (await this.pool.query(`
      WITH due AS (
        SELECT i.id FROM hatch_channel_inbox i
        WHERE i.state = 'pending' AND (i.lease_until IS NULL OR i.lease_until < $1)
          AND NOT EXISTS (SELECT 1 FROM hatch_channel_inbox earlier WHERE earlier.state = 'pending' AND earlier.channel = i.channel AND earlier.scope = i.scope AND earlier.thread_id = i.thread_id AND ${BEFORE})
          AND NOT EXISTS (SELECT 1 FROM hatch_channel_inbox part WHERE part.state = 'pending' AND part.channel = i.channel AND part.scope = i.scope AND part.thread_id = i.thread_id AND part.event->>'album' = i.event->>'album' AND part.received_at > $1::timestamptz - make_interval(secs => ${ALBUM_SETTLE_MS / 1000}))
        ORDER BY i.seq LIMIT $2 FOR UPDATE OF i SKIP LOCKED
      )
      UPDATE hatch_channel_inbox i SET lease_until = $3, attempts = i.attempts + 1 FROM due WHERE i.id = due.id RETURNING i.*`,
    [now, limit, new Date(now.getTime() + leaseMs)])).rows;
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map(itemOf);
  }

  async siblings(item: InboxItem): Promise<InboxItem[]> {
    if (!item.event.album) return [];
    return (await this.pool.query(`SELECT * FROM hatch_channel_inbox WHERE state = 'pending' AND id <> $1 AND channel = $2 AND scope = $3 AND thread_id = $4 AND event->>'album' = $5 ORDER BY ${IN_ORDER}`,
      [item.id, item.channel, item.scope, item.event.address.threadId, item.event.album])).rows.map(itemOf);
  }

  /** The rows a lease still holds: claimed by this attempt, and not yet expired. */
  private static readonly HELD = "id = $1 AND state = 'pending' AND attempts = $2 AND lease_until > $3";

  async extend(lease: Lease, leaseMs: number, now = new Date()): Promise<boolean> {
    return Boolean((await this.pool.query(`UPDATE hatch_channel_inbox SET lease_until = $4 WHERE ${PostgresInbox.HELD}`, [lease.id, lease.attempts, now, new Date(now.getTime() + leaseMs)])).rowCount);
  }

  async complete(lease: Lease, outcome: { connectionId?: string; runId?: string; replied?: boolean }, absorbed: string[] = [], now = new Date()): Promise<boolean> {
    const client = await this.pool.connect();
    const set = (first: number) => `state = 'done', lease_until = NULL, connection_id = COALESCE($${first}, connection_id), run_id = COALESCE($${first + 1}, run_id), replied_at = CASE WHEN $${first + 2} THEN now() ELSE replied_at END`;
    const values = [outcome.connectionId ?? null, outcome.runId ?? null, outcome.replied ?? false];
    try {
      await client.query("BEGIN");
      const held = await client.query(`UPDATE hatch_channel_inbox SET ${set(4)} WHERE ${PostgresInbox.HELD}`, [lease.id, lease.attempts, now, ...values]);
      if (!held.rowCount) { await client.query("ROLLBACK"); return false; }
      if (absorbed.length) await client.query(`UPDATE hatch_channel_inbox SET ${set(2)} WHERE id = ANY($1::uuid[]) AND state = 'pending'`, [absorbed, ...values]);
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }

  async retry(lease: Lease, error: string, delayMs: number, maxAttempts: number, now = new Date()): Promise<"pending" | "failed" | undefined> {
    const row = (await this.pool.query(`UPDATE hatch_channel_inbox SET last_error = $4, lease_until = $5, state = CASE WHEN attempts >= $6 THEN 'failed' ELSE 'pending' END WHERE ${PostgresInbox.HELD} RETURNING state`,
      [lease.id, lease.attempts, now, error.slice(0, 1000), new Date(now.getTime() + delayMs), maxAttempts])).rows[0];
    return row?.state;
  }

  async get(id: string): Promise<InboxItem | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = (await this.pool.query("SELECT * FROM hatch_channel_inbox WHERE id = $1", [id])).rows[0];
    return row && itemOf(row);
  }

  async lastInbound(channel: ChannelKind, scope: string, threadId: string): Promise<Date | undefined> {
    return (await this.pool.query("SELECT max(received_at) AS at FROM hatch_channel_inbox WHERE channel = $1 AND scope = $2 AND thread_id = $3", [channel, scope, threadId])).rows[0]?.at ?? undefined;
  }

  async markReplied(ids: string[]): Promise<void> {
    await this.pool.query("UPDATE hatch_channel_inbox SET replied_at = now() WHERE replied_at IS NULL AND id = ANY($1::uuid[])", [ids]);
  }

  async waiting(filter: { runId: string }, now = new Date()): Promise<WaitingThread[]> {
    return (await this.pool.query(`SELECT DISTINCT i.connection_id, i.channel, i.scope, i.thread_id, i.sender_id FROM hatch_channel_inbox i JOIN hatch_connections c ON c.id = i.connection_id
      WHERE i.run_id = $2 AND i.state = 'done' AND i.replied_at IS NULL AND i.received_at > $1::timestamptz - interval '${WAITING_MS / 1000} seconds'`, [now, filter.runId])).rows
      .map(row => ({ connectionId: row.connection_id, channel: row.channel, scope: row.scope, threadId: row.thread_id, senderId: row.sender_id }));
  }

  async byRun(runId: string): Promise<InboxItem[]> {
    return (await this.pool.query(`SELECT * FROM hatch_channel_inbox WHERE run_id = $1 ORDER BY ${IN_ORDER}`, [runId])).rows.map(itemOf);
  }

  async openRuns(limit: number): Promise<string[]> {
    return (await this.pool.query("SELECT run_id FROM hatch_channel_inbox WHERE run_id IS NOT NULL AND replied_at IS NULL AND state = 'done' GROUP BY run_id ORDER BY min(seq) LIMIT $1", [limit])).rows.map(row => row.run_id);
  }
}
