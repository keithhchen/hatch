import type { ConnectionRepository } from "./connections.js";
import type { ChannelHub } from "./hub.js";
import type { ChannelAdapter, InboundEvent } from "./types.js";

type Running = { adapter: ChannelAdapter; abort: AbortController; done: Promise<void> };

/**
 * Keeps one listener per platform tenant that pushes over its own connection (shared adapters, and each Expert's own app).
 * Across processes a tenant is listened to by one process at a time; credentials added, replaced or removed are picked up on the next reconcile.
 */
export class ChannelListeners {
  private running = new Map<string, Running>();
  private timer?: NodeJS.Timeout;
  constructor(private deps: {
    hub: ChannelHub;
    connections: Pick<ConnectionRepository, "listening">;
    exclusive: (name: string, fn: () => Promise<void>) => Promise<void>;
    accept: (adapter: ChannelAdapter, events: InboundEvent[]) => Promise<void>;
    onError: (key: string, error: unknown) => void;
    interval?: number;
    backoff?: number;
  }) {}

  start(): void {
    const tick = () => void this.reconcile().catch(error => this.deps.onError("reconcile", error)).finally(() => { if (this.timer) this.timer = setTimeout(tick, this.deps.interval ?? 30_000).unref(); });
    this.timer = setTimeout(tick, 0).unref();
  }

  async reconcile(): Promise<void> {
    const desired = new Map<string, ChannelAdapter>();
    for (const adapter of this.deps.hub.listeners()) desired.set(`${adapter.kind}:`, adapter);
    for (const { channel, scope } of await this.deps.connections.listening()) {
      const adapter = await this.deps.hub.get(channel, scope);
      if (adapter?.listen) desired.set(`${channel}:${scope}`, adapter);
    }
    await Promise.all([...this.running].filter(([key, run]) => desired.get(key) !== run.adapter).map(async ([key, run]) => { this.running.delete(key); await end(run); }));
    for (const [key, adapter] of desired) if (!this.running.has(key)) this.running.set(key, this.run(key, adapter));
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const all = [...this.running.values()];
    this.running.clear();
    await Promise.all(all.map(end));
  }

  private run(key: string, adapter: ChannelAdapter): Running {
    const abort = new AbortController();
    const { signal } = abort;
    const done = (async () => {
      while (!signal.aborted) {
        await this.deps.exclusive(`assistant-channel:${key}`, () => adapter.listen!(events => this.deps.accept(adapter, events), signal))
          .catch(error => this.deps.onError(key, error));
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.deps.backoff ?? 30_000);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    })();
    return { adapter, abort, done };
  }
}

const end = async (run: Running) => { run.abort.abort(); await run.done; };
