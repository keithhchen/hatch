import { randomUUID } from "node:crypto";

type Deliver = (conversationId: string, event: Record<string, unknown>) => void;

/**
 * Carries a Run's live events to the other instances, so an observer sees them whichever instance it
 * connected to. Durable events do not need it: observers read those from the journal by cursor.
 */
export interface EventRelay {
  /** Never awaits and never throws: a Run is not slowed by its observers. */
  publish(conversationId: string, event: Record<string, unknown>): void;
  /** Events other instances published; resolves to the way to stop listening. */
  subscribe(deliver: Deliver): Promise<() => Promise<void>>;
}

type Listener = { query(text: string): Promise<unknown>; on(event: string, handler: (...args: any[]) => void): unknown; release(error?: Error | boolean): void };
type Pool = { query(text: string, values?: unknown[]): Promise<unknown>; connect(): Promise<Listener> };

/**
 * PostgreSQL LISTEN/NOTIFY. Publishing only queues: one background loop sends whatever has queued in a
 * single statement. If the database cannot keep up the oldest events are dropped (a delta is a hint, the
 * journal and the snapshot hold the truth), and an event too large for a notification is not relayed.
 */
export class PostgresEventRelay implements EventRelay {
  private readonly queue: string[] = [];
  private sending = false;
  private readonly instanceId = randomUUID();

  constructor(private readonly pool: Pool, private readonly options: { channel?: string; maxQueue?: number; maxPayloadBytes?: number; retryMs?: number } = {}) {}

  private get channel(): string { return this.options.channel ?? "hatch_run_events"; }

  publish(conversationId: string, event: Record<string, unknown>): void {
    try {
      const payload = JSON.stringify({ o: this.instanceId, c: conversationId, e: event });
      if (Buffer.byteLength(payload) > (this.options.maxPayloadBytes ?? 7_000)) return;
      if (this.queue.length >= (this.options.maxQueue ?? 2_000)) this.queue.shift();
      this.queue.push(payload);
      if (!this.sending) void this.send();
    } catch { /* an event that cannot be serialized is not relayed */ }
  }

  private async send(): Promise<void> {
    this.sending = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0);
        await this.pool.query("SELECT pg_notify($1, p) FROM (SELECT p FROM unnest($2::text[]) WITH ORDINALITY AS t(p, n) ORDER BY n) AS ordered", [this.channel, batch]);
      }
    } catch { /* dropped: observers recover by cursor */ } finally { this.sending = false; }
  }

  async subscribe(deliver: Deliver): Promise<() => Promise<void>> {
    let stopped = false;
    let current: Listener | undefined;
    const listen = async (): Promise<void> => {
      const client = await this.pool.connect();
      current = client;
      client.on("notification", (message: { payload?: string }) => {
        try {
          const { o, c, e } = JSON.parse(message.payload ?? "") as { o: string; c: string; e: Record<string, unknown> };
          if (o !== this.instanceId) deliver(c, e);
        } catch { /* not ours */ }
      });
      // A lost connection is replaced; what was missed in between is in the journal.
      client.on("error", () => { client.release(true); if (!stopped) setTimeout(() => void listen().catch(() => undefined), this.options.retryMs ?? 1_000).unref(); });
      await client.query(`LISTEN ${this.channel}`);
    };
    await listen();
    return async () => { stopped = true; await current?.query(`UNLISTEN ${this.channel}`).catch(() => undefined); current?.release(); };
  }
}
