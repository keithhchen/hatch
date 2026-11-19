import { reported } from "../observability/reported.js";
import { randomUUID } from "node:crypto";

type Advanced = (conversationId: string, position: number) => void;

/**
 * Tells the other instances a conversation's log advanced, so an observer is served whichever instance it connected to.
 * Only the news travels, never the events: observers read those from the log by position.
 */
export interface EventRelay {
  /** Never awaits and never throws: a Run is not slowed by its observers. */
  publish(conversationId: string, position: number): void;
  /** What other instances advanced; resolves to the way to stop listening. */
  subscribe(advanced: Advanced): Promise<() => Promise<void>>;
}

type Listener = { once(event: string, handler: (...args: any[]) => void): unknown; query(text: string): Promise<unknown>; on(event: string, handler: (...args: any[]) => void): unknown; release(error?: Error | boolean): void };
type Pool = { query(text: string, values?: unknown[]): Promise<unknown>; connect(): Promise<Listener> };

/**
 * PostgreSQL LISTEN/NOTIFY. Publishing only records the newest position per conversation: one background loop sends whatever
 * has accumulated in a single statement. A notification lost to a failed send or a lost connection costs nothing but delay:
 * observers also read the log on a slow timer, and every read is by position.
 */
export class PostgresEventRelay implements EventRelay {
  private readonly pending = new Map<string, number>();
  private sending = false;
  private readonly instanceId = randomUUID();

  constructor(private readonly pool: Pool, private readonly options: { channel?: string; retryMs?: number } = {}) {}

  private get channel(): string { return this.options.channel ?? "hatch_run_events"; }

  publish(conversationId: string, position: number): void {
    this.pending.set(conversationId, Math.max(position, this.pending.get(conversationId) ?? 0));
    if (!this.sending) void this.send();
  }

  private async send(): Promise<void> {
    this.sending = true;
    let batch: Array<[string, number]> = [];
    try {
      while (this.pending.size) {
        batch = [...this.pending];
        this.pending.clear();
        const payloads = batch.map(([c, p]) => JSON.stringify({ o: this.instanceId, c, p }));
        await this.pool.query("SELECT pg_notify($1, p) FROM unnest($2::text[]) AS t(p)", [this.channel, payloads]);
        batch = [];
      }
    } catch (error) {
      reported("run_event_publish_failed")(error);
      // Dropped: observers catch up on their next read.
      for (const [c, p] of batch) this.publish(c, p);
      this.sending = false;
      return;
    }
    this.sending = false;
  }

  async subscribe(advanced: Advanced): Promise<() => Promise<void>> {
    let stopped = false;
    let current: Listener | undefined;
    const receive = (message: { payload?: string }): void => {
      try {
        const frame = JSON.parse(message.payload ?? "") as { o: string; c: string; p: number };
        if (frame.o !== this.instanceId) advanced(frame.c, frame.p);
      } catch { /* not ours */ }
    };
    const listen = async (): Promise<void> => {
      const client = await this.pool.connect();
      current = client;
      client.on("notification", receive);
      // A lost connection is replaced until it works again; the news missed in between is read from the log by the observers' safety poll.
      client.once("error", () => { client.release(true); if (!stopped) retry(); });
      try { await client.query(`LISTEN ${this.channel}`); } catch (error) { client.release(true); throw error; }
    };
    const retry = (): void => {
      setTimeout(() => { if (!stopped) listen().catch(retry); }, this.options.retryMs ?? 1_000).unref();
    };
    await listen();
    return async () => { stopped = true; await current?.query(`UNLISTEN ${this.channel}`).catch(() => undefined); current?.release(); };
  }
}
