import type { Pool } from "pg";
import type { DeliveryState } from "../surfaces/contract.js";
import type { ChannelKind, OutboundMessage, PlatformAddress } from "./types.js";

export type DeliveryKind = "reply" | "notice";

/** One reply or notice to one thread, as one or more messages that go in order. */
export type Delivery = {
  id: string;
  connectionId?: string;
  channel: ChannelKind;
  scope: string;
  address: PlatformAddress;
  kind: DeliveryKind;
  parts: OutboundMessage[];
  /** How many parts the platform has accepted. */
  sentParts: number;
  state: DeliveryState;
  attempts: number;
  /** A part was being sent when the lease ran out: the platform may have it. */
  inFlight: boolean;
};

export type NewDelivery = Pick<Delivery, "channel" | "scope" | "address" | "kind" | "parts"> & {
  connectionId?: string;
  state: Extract<DeliveryState, "pending" | "undelivered">;
  /** At most one delivery exists per key: the database refuses a second. */
  sourceKey?: string;
};

/** Port: every message we owe a platform, kept until the platform has it or we know it cannot. */
export interface Outbox {
  /** Undefined when a delivery with this source key already exists. */
  enqueue(input: NewDelivery): Promise<Delivery | undefined>;
  /** Leases the next due delivery of each thread. A thread's deliveries go out in the order they were queued. */
  claim(limit: number, leaseMs: number, now?: Date): Promise<Delivery[]>;
  /** About to send part `sentParts`; if the process dies now, the delivery is `inFlight` when next claimed. */
  begin(id: string): Promise<void>;
  progress(id: string, sentParts: number, leaseMs: number, now?: Date): Promise<void>;
  settle(id: string, state: DeliveryState, error?: string): Promise<void>;
  /** Back to `pending` after `delayMs`, or `failed` once `maxAttempts` is reached. */
  retry(id: string, error: string, delayMs: number, maxAttempts: number, now?: Date): Promise<DeliveryState>;
  /** Not yet: the rate limit said wait. This is not a failed attempt. */
  defer(id: string, delayMs: number, now?: Date): Promise<void>;
  undelivered(connectionId: string): Promise<Delivery[]>;
  get(id: string): Promise<Delivery | undefined>;
}

const deliveryOf = (row: Record<string, any>): Delivery => ({
  id: row.id, channel: row.channel, scope: row.scope, kind: row.kind, parts: row.parts, sentParts: row.sent_parts, state: row.state, attempts: row.attempts, inFlight: row.in_flight,
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
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        lease_until TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS hatch_channel_outbox_due_idx ON hatch_channel_outbox (seq) WHERE state IN ('pending', 'sending');
      CREATE INDEX IF NOT EXISTS hatch_channel_outbox_undelivered_idx ON hatch_channel_outbox (connection_id, created_at DESC) WHERE state = 'undelivered';
    `);
    return new PostgresOutbox(pool);
  }

  async enqueue(input: NewDelivery): Promise<Delivery | undefined> {
    const row = (await this.pool.query(`INSERT INTO hatch_channel_outbox (connection_id, channel, scope, thread_id, sender_id, kind, source_key, parts, state)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (source_key) DO NOTHING RETURNING *`,
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
      UPDATE hatch_channel_outbox o SET state = 'sending', lease_until = $3 FROM due WHERE o.id = due.id RETURNING o.*`,
    [now, limit, new Date(now.getTime() + leaseMs)])).rows;
    return rows.sort((a, b) => Number(a.seq) - Number(b.seq)).map(deliveryOf);
  }

  async begin(id: string): Promise<void> { await this.pool.query("UPDATE hatch_channel_outbox SET in_flight = true WHERE id = $1", [id]); }

  async progress(id: string, sentParts: number, leaseMs: number, now = new Date()): Promise<void> {
    await this.pool.query("UPDATE hatch_channel_outbox SET sent_parts = $2, in_flight = false, lease_until = $3 WHERE id = $1", [id, sentParts, new Date(now.getTime() + leaseMs)]);
  }

  async settle(id: string, state: DeliveryState, error?: string): Promise<void> {
    await this.pool.query("UPDATE hatch_channel_outbox SET state = $2, in_flight = false, lease_until = NULL, last_error = COALESCE($3, last_error) WHERE id = $1", [id, state, error?.slice(0, 1000) ?? null]);
  }

  async retry(id: string, error: string, delayMs: number, maxAttempts: number, now = new Date()): Promise<DeliveryState> {
    return (await this.pool.query(`UPDATE hatch_channel_outbox SET attempts = attempts + 1, in_flight = false, lease_until = NULL, last_error = $2, next_attempt_at = $3,
      state = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END WHERE id = $1 RETURNING state`, [id, error.slice(0, 1000), new Date(now.getTime() + delayMs), maxAttempts])).rows[0].state;
  }

  async defer(id: string, delayMs: number, now = new Date()): Promise<void> {
    await this.pool.query("UPDATE hatch_channel_outbox SET state = 'pending', in_flight = false, lease_until = NULL, next_attempt_at = $2 WHERE id = $1", [id, new Date(now.getTime() + delayMs)]);
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
