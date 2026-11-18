import { reported } from "../observability/reported.js";
import { randomUUID } from "node:crypto";

type Deliver = (conversationId: string, event: Record<string, unknown>) => void;

/** What observers are told when events may have been lost: they read the conversation again instead of trusting the stream. */
export const RESYNC_EVENT = Object.freeze({ type: "resync" });

/**
 * Carries a Run's live events to the other instances, so an observer sees them whichever instance it
 * connected to. Durable events do not need it: observers read those from the journal by cursor.
 */
export interface EventRelay {
  /** Never awaits and never throws: a Run is not slowed by its observers. */
  publish(conversationId: string, event: Record<string, unknown>): void;
  /**
   * Events other instances published; resolves to the way to stop listening. `onGap` is called whenever this instance may
   * have missed events (a lost connection, a partial event that will never complete): its observers must read again.
   */
  subscribe(deliver: Deliver, onGap?: () => void): Promise<() => Promise<void>>;
}

type Listener = { once(event: string, handler: (...args: any[]) => void): unknown; query(text: string): Promise<unknown>; on(event: string, handler: (...args: any[]) => void): unknown; release(error?: Error | boolean): void };
type Pool = { query(text: string, values?: unknown[]): Promise<unknown>; connect(): Promise<Listener> };

type Queued = { c: string; p: string };
type Partial = { c: string; parts: string[]; got: number };
const MAX_PARTIAL_EVENTS = 64;

/**
 * PostgreSQL LISTEN/NOTIFY. Publishing only queues: one background loop sends whatever has queued in a
 * single statement. An event too large for one notification travels as chunks that the receiver joins. Nothing is lost
 * silently: when events are dropped (a backlog the database cannot keep up with, an event beyond any size, a failed send)
 * the other instances are told to resync that conversation, and an instance that lost its connection tells its own observers.
 */
export class PostgresEventRelay implements EventRelay {
  private readonly queue: Queued[] = [];
  private readonly lost = new Set<string>();
  private sending = false;
  private chunkId = 0;
  private readonly instanceId = randomUUID();

  constructor(private readonly pool: Pool, private readonly options: { channel?: string; maxQueue?: number; maxPayloadBytes?: number; maxEventBytes?: number; retryMs?: number } = {}) {}

  private get channel(): string { return this.options.channel ?? "hatch_run_events"; }

  publish(conversationId: string, event: Record<string, unknown>): void {
    try {
      const body = JSON.stringify(event);
      const payload = JSON.stringify({ o: this.instanceId, c: conversationId, e: event });
      if (Buffer.byteLength(payload) <= (this.options.maxPayloadBytes ?? 7_000)) this.enqueue([{ c: conversationId, p: payload }]);
      else if (body.length > (this.options.maxEventBytes ?? 1_000_000)) this.lost.add(conversationId);
      else this.enqueue(this.chunks(conversationId, body));
    } catch { this.lost.add(conversationId); /* an event that cannot be serialized is not relayed: observers resync */ }
    if (!this.sending) void this.send();
  }

  /** A UTF-8 character is at most 3 bytes in a JSON string, and the envelope is small. */
  private chunks(conversationId: string, body: string): Queued[] {
    const size = Math.max(16, Math.floor(((this.options.maxPayloadBytes ?? 7_000) - 300) / 3));
    const k = `${this.instanceId}:${this.chunkId++}`;
    const n = Math.ceil(body.length / size);
    return Array.from({ length: n }, (_, i) => ({ c: conversationId, p: JSON.stringify({ o: this.instanceId, c: conversationId, k, i, n, d: body.slice(i * size, (i + 1) * size) }) }));
  }

  private enqueue(items: Queued[]): void {
    this.queue.push(...items);
    const max = this.options.maxQueue ?? 4_000;
    while (this.queue.length > max) this.lost.add(this.queue.shift()!.c);
  }

  private async send(): Promise<void> {
    this.sending = true;
    let batch: Queued[] = [];
    try {
      while (this.queue.length || this.lost.size) {
        // Whoever missed events is told, after everything queued before: the resync is the last word on those conversations.
        for (const c of this.lost) this.queue.push({ c, p: JSON.stringify({ o: this.instanceId, c, e: RESYNC_EVENT }) });
        this.lost.clear();
        batch = this.queue.splice(0);
        await this.pool.query("SELECT pg_notify($1, p) FROM (SELECT p FROM unnest($2::text[]) WITH ORDINALITY AS t(p, n) ORDER BY n) AS ordered", [this.channel, batch.map((item) => item.p)]);
        batch = [];
      }
    } catch (error) {
      reported("run_event_publish_failed")(error);
      // Dropped: the next publish tries again, and tells the observers on the other instances to read again.
      for (const item of batch) this.lost.add(item.c);
    } finally { this.sending = false; }
  }

  async subscribe(deliver: Deliver, onGap?: () => void): Promise<() => Promise<void>> {
    let stopped = false;
    let current: Listener | undefined;
    const partials = new Map<string, Partial>();
    const gap = (): void => { partials.clear(); try { onGap?.(); } catch { /* an observer never stops the listener */ } };
    const receive = (message: { payload?: string }): void => {
      try {
        const frame = JSON.parse(message.payload ?? "") as { o: string; c: string; e?: Record<string, unknown>; k?: string; i?: number; n?: number; d?: string };
        if (frame.o === this.instanceId) return;
        if (frame.e) { deliver(frame.c, frame.e); return; }
        if (frame.k === undefined || frame.i === undefined || !frame.n || frame.d === undefined) return;
        const partial = partials.get(frame.k) ?? { c: frame.c, parts: new Array<string>(frame.n), got: 0 };
        if (partial.parts[frame.i] === undefined) { partial.parts[frame.i] = frame.d; partial.got++; }
        partials.set(frame.k, partial);
        if (partial.got === frame.n) { partials.delete(frame.k); deliver(frame.c, JSON.parse(partial.parts.join("")) as Record<string, unknown>); return; }
        // An event whose remaining chunks never came is given up for the conversation to read again.
        if (partials.size > MAX_PARTIAL_EVENTS) { const [oldest, stale] = partials.entries().next().value!; partials.delete(oldest); deliver(stale.c, RESYNC_EVENT); }
      } catch { /* not ours */ }
    };
    const listen = async (): Promise<void> => {
      const client = await this.pool.connect();
      current = client;
      client.on("notification", receive);
      // A lost connection is replaced until it works again; what was missed in between is for the observers to read again.
      client.once("error", () => { client.release(true); if (!stopped) retry(); });
      try { await client.query(`LISTEN ${this.channel}`); } catch (error) { client.release(true); throw error; }
    };
    const retry = (): void => {
      setTimeout(() => { if (!stopped) listen().then(gap, retry); }, this.options.retryMs ?? 1_000).unref();
    };
    await listen();
    return async () => { stopped = true; await current?.query(`UNLISTEN ${this.channel}`).catch(() => undefined); current?.release(); };
  }
}
