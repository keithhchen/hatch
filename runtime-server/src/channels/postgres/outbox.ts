import type { Pool } from "pg";
import type { DeliveryState } from "../../surfaces/contract.js";
import type { Delivery, Lease, NewDelivery, Outbox } from "../outbox.js";
import type { ChannelKind } from "../types.js";

const deliveryOf = (row: Record<string, any>): Delivery => ({
  id: row.id, channel: row.channel, scope: row.scope, kind: row.kind, parts: row.parts, sentParts: row.sent_parts, state: row.state, attempts: row.attempts, claims: row.claims, inFlight: row.in_flight,
  address: { threadId: row.thread_id, senderId: row.sender_id }, ...(row.connection_id ? { connectionId: row.connection_id } : {}),
});

export class PostgresOutbox implements Outbox {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresOutbox> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_channel_outbox (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seq BIGSERIAL NOT NULL,
        connection_id UUID REFERENCES hatch_connections (id) ON DELETE SET NULL,
        channel TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        thread_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('reply', 'notice')),
        source_key TEXT UNIQUE,
        parts JSONB NOT NULL,
        sent_parts INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled', 'undelivered')),
        in_flight BOOLEAN NOT NULL DEFAULT false,
        attempts INTEGER NOT NULL DEFAULT 0,
        claims INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_until TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_sent_at TIMESTAMPTZ
      );
      ALTER TABLE hatch_channel_outbox ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ;
      ALTER TABLE hatch_channel_outbox ADD COLUMN IF NOT EXISTS claims INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS hatch_channel_outbox_thread_idx ON hatch_channel_outbox (channel, scope, thread_id, last_sent_at);
      CREATE INDEX IF NOT EXISTS hatch_channel_outbox_due_idx ON hatch_channel_outbox (seq) WHERE state IN ('pending', 'sending');
      CREATE INDEX IF NOT EXISTS hatch_channel_outbox_undelivered_idx ON hatch_channel_outbox (connection_id, created_at DESC) WHERE state = 'undelivered';
    `);
    // Whatever way a Connection is deleted, what it still owes the platform is cancelled in the same transaction, not sent to a binding that no longer exists.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hatch_channel_outbox_unbind'))");
      await client.query(`
        CREATE OR REPLACE FUNCTION hatch_cancel_outbox_of_connection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          UPDATE hatch_channel_outbox SET state = 'cancelled', in_flight = false, lease_until = NULL WHERE connection_id = OLD.id AND state IN ('pending', 'sending');
          RETURN OLD;
        END $$;
        DROP TRIGGER IF EXISTS hatch_connection_unbound ON hatch_connections;
        CREATE TRIGGER hatch_connection_unbound BEFORE DELETE ON hatch_connections FOR EACH ROW EXECUTE FUNCTION hatch_cancel_outbox_of_connection();
      `);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
    return new PostgresOutbox(pool);
  }

  async enqueue(input: NewDelivery): Promise<Delivery | undefined> {
    // Nothing is queued for a Connection that is gone (unbound).
    const row = (await this.pool.query(`INSERT INTO hatch_channel_outbox (connection_id, channel, scope, thread_id, sender_id, kind, source_key, parts, state)
      SELECT $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9 WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM hatch_connections WHERE id = $1::uuid)
      ON CONFLICT (source_key) DO NOTHING RETURNING *`,
    [input.connectionId ?? null, input.channel, input.scope, input.address.threadId, input.address.senderId, input.kind, input.sourceKey ?? null, JSON.stringify(input.parts), input.state])).rows[0];
    return row && deliveryOf(row);
  }

  async claim(limit: number, leaseMs: number, now = new Date()): Promise<Delivery[]> {
    const rows = (await this.pool.query(`
      WITH due AS (
        SELECT o.id FROM hatch_channel_outbox o
        WHERE ((o.state = 'pending' AND o.next_attempt_at <= $1) OR (o.state = 'sending' AND o.lease_until < $1))
          AND NOT EXISTS (SELECT 1 FROM hatch_channel_outbox earlier WHERE earlier.state IN ('pending', 'sending') AND earlier.channel = o.channel AND earlier.scope = o.scope AND earlier.thread_id = o.thread_id AND earlier.seq < o.seq)
        ORDER BY o.seq LIMIT $2 FOR UPDATE OF o SKIP LOCKED
      )
      UPDATE hatch_channel_outbox o SET state = 'sending', lease_until = $3, claims = o.claims + 1 FROM due WHERE o.id = due.id RETURNING o.*`,
    [now, limit, new Date(now.getTime() + leaseMs)])).rows;
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map(deliveryOf);
  }

  /** The row a lease still holds. */
  private static readonly HELD = "id = $1 AND state = 'sending' AND claims = $2 AND lease_until > $3";

  private async held(sql: string, lease: Lease, now: Date, ...values: unknown[]): Promise<Record<string, any> | undefined> {
    return (await this.pool.query(`UPDATE hatch_channel_outbox SET ${sql} WHERE ${PostgresOutbox.HELD} RETURNING state`, [lease.id, lease.claims, now, ...values])).rows[0];
  }

  async begin(lease: Lease, now = new Date()): Promise<boolean> { return Boolean(await this.held("in_flight = true", lease, now)); }

  async progress(lease: Lease, sentParts: number, leaseMs: number, now = new Date()): Promise<boolean> {
    return Boolean(await this.held("sent_parts = $4, in_flight = false, lease_until = $5, last_sent_at = $3", lease, now, sentParts, new Date(now.getTime() + leaseMs)));
  }

  async settle(lease: Lease, state: DeliveryState, error?: string, now = new Date()): Promise<boolean> {
    return Boolean(await this.held("state = $4, in_flight = false, lease_until = NULL, last_error = COALESCE($5, last_error)", lease, now, state, error?.slice(0, 1000) ?? null));
  }

  async retry(lease: Lease, error: string, delayMs: number, maxAttempts: number, now = new Date()): Promise<DeliveryState | undefined> {
    return (await this.held(`attempts = attempts + 1, in_flight = false, lease_until = NULL, last_error = $4, next_attempt_at = $5,
      state = CASE WHEN attempts + 1 >= $6 THEN 'failed' ELSE 'pending' END`, lease, now, error.slice(0, 1000), new Date(now.getTime() + delayMs), maxAttempts))?.state;
  }

  async defer(lease: Lease, delayMs: number, now = new Date()): Promise<boolean> {
    return Boolean(await this.held("state = 'pending', in_flight = false, lease_until = NULL, next_attempt_at = $4", lease, now, new Date(now.getTime() + delayMs)));
  }

  async sentSince(channel: ChannelKind, scope: string, threadId: string, since: Date): Promise<number> {
    return Number((await this.pool.query("SELECT COALESCE(SUM(sent_parts), 0) AS total FROM hatch_channel_outbox WHERE channel = $1 AND scope = $2 AND thread_id = $3 AND last_sent_at >= $4", [channel, scope, threadId, since])).rows[0].total);
  }

  async undelivered(connectionId: string): Promise<Delivery[]> {
    return (await this.pool.query("SELECT * FROM hatch_channel_outbox WHERE connection_id = $1 AND state = 'undelivered' ORDER BY seq", [connectionId])).rows.map(deliveryOf);
  }

  async get(id: string): Promise<Delivery | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = (await this.pool.query("SELECT * FROM hatch_channel_outbox WHERE id = $1", [id])).rows[0];
    return row && deliveryOf(row);
  }
}
