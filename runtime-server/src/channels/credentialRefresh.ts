import type { ConnectionRepository } from "./connections.js";
import type { ChannelHub } from "./hub.js";
import { CredentialsExpired } from "./types.js";

/**
 * Renews credentials that expire, such as Instagram's 60-day tokens, before they do. What to renew and when is the adapter's
 * (`refresh`); this only walks the tenants. Credentials that can no longer be renewed unbind their Connection, credentials and all, so the Expert installs again.
 */
export class CredentialRefresher {
  private timer?: NodeJS.Timeout;
  constructor(private deps: {
    hub: ChannelHub;
    connections: Pick<ConnectionRepository, "listening" | "credentials" | "saveCredentials" | "unbind">;
    seal: { seal(value: unknown): string; open<T>(sealed: string): T };
    onError: (key: string, error: unknown) => void;
    now?: () => Date;
    interval?: number;
  }) {}

  start(): void {
    const tick = () => void this.run().catch(error => this.deps.onError("refresh", error)).finally(() => { if (this.timer) this.timer = setTimeout(tick, this.deps.interval ?? 6 * 60 * 60_000).unref(); });
    this.timer = setTimeout(tick, 0).unref();
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  async run(): Promise<void> {
    const { hub, connections, seal } = this.deps;
    for (const { ownerAccountId, channel, scope } of await connections.listening()) {
      const adapter = await hub.get(channel, scope);
      const sealed = adapter?.refresh ? await connections.credentials(ownerAccountId, channel) : undefined;
      if (!adapter?.refresh || !sealed) continue;
      try {
        const next = await adapter.refresh(seal.open(sealed), this.deps.now?.() ?? new Date());
        if (next) await connections.saveCredentials(ownerAccountId, channel, seal.seal(next), scope);
      } catch (error) {
        if (error instanceof CredentialsExpired) await connections.unbind(ownerAccountId, channel);
        this.deps.onError(`${channel}:${scope}`, error);
      }
    }
  }
}
