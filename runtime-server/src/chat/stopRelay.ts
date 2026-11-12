import { reported } from "../observability/reported.js";
type Listener = { query(text: string): Promise<unknown>; on(event: string, handler: (...args: any[]) => void): unknown; release(error?: Error | boolean): void };
type Pool = { query(text: string, values?: unknown[]): Promise<unknown>; connect(): Promise<Listener> };

/**
 * Tells the instance that executes a Run that it was stopped. Only a prompt: the stop itself is the Run's
 * durable state, and an executor that misses this still finds out at its next lease renewal or write.
 */
export interface StopRelay {
  /** Never throws: a stop is not slowed or failed by the relay. */
  publish(runId: string): void;
  /** Stops other instances announced; resolves to the way to stop listening. */
  subscribe(onStop: (runId: string) => void): Promise<() => Promise<void>>;
}

/** Instances of one process, such as tests: no database. */
export class InProcessStopRelay implements StopRelay {
  private readonly listeners = new Set<(runId: string) => void>();
  publish(runId: string): void { for (const listener of this.listeners) listener(runId); }
  async subscribe(onStop: (runId: string) => void): Promise<() => Promise<void>> {
    this.listeners.add(onStop);
    return async () => { this.listeners.delete(onStop); };
  }
}

/** PostgreSQL LISTEN/NOTIFY, on a channel of its own. */
export class PostgresStopRelay implements StopRelay {
  constructor(private readonly pool: Pool, private readonly options: { channel?: string; retryMs?: number } = {}) {}

  private get channel(): string { return this.options.channel ?? "hatch_run_stops"; }

  publish(runId: string): void {
    this.pool.query("SELECT pg_notify($1, $2)", [this.channel, runId]).catch(reported("run_stop_publish_failed", { run_id: runId }));
  }

  async subscribe(onStop: (runId: string) => void): Promise<() => Promise<void>> {
    let stopped = false;
    let current: Listener | undefined;
    const listen = async (): Promise<void> => {
      const client = await this.pool.connect();
      current = client;
      client.on("notification", (message: { payload?: string }) => { if (message.payload) onStop(message.payload); });
      // A lost connection is replaced; a stop missed in between is found by the lease renewal and the fence.
      client.on("error", () => { client.release(true); if (!stopped) setTimeout(() => void listen().catch(() => undefined), this.options.retryMs ?? 1_000).unref(); });
      await client.query(`LISTEN ${this.channel}`);
    };
    await listen();
    return async () => { stopped = true; await current?.query(`UNLISTEN ${this.channel}`).catch(() => undefined); current?.release(); };
  }
}
