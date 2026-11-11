import type { ChannelAdapter, ChannelKind } from "./types.js";

/**
 * Finds the adapter for a platform tenant: the Expert's own app when the scope names one (their account id, or the id of a bot of theirs).
 * Our shared one serves the default scope, and every tenant of a platform where one app serves many (`tenants`). Any other scope is
 * unknown, such as a bot that was replaced or removed: it never falls back to the shared bot, whose token belongs to someone else's chats.
 */
export class ChannelHub {
  private shared = new Map<ChannelKind, ChannelAdapter>();
  constructor(adapters: ChannelAdapter[], private own: (kind: ChannelKind, scope: string) => Promise<ChannelAdapter | undefined> = async () => undefined, private tenants: (kind: ChannelKind) => boolean = () => false) {
    for (const adapter of adapters) this.shared.set(adapter.kind, adapter);
  }
  async get(kind: ChannelKind, scope = ""): Promise<ChannelAdapter | undefined> {
    const shared = this.shared.get(kind);
    const adapter = scope ? await this.own(kind, scope) ?? (scope === shared?.scope || this.tenants(kind) ? shared : undefined) : shared;
    return adapter?.available() ? adapter : undefined;
  }
  /** Platforms an Expert can connect to right now without bringing anything. */
  sharedKinds(): ChannelKind[] { return [...this.shared.values()].filter(adapter => adapter.available()).map(adapter => adapter.kind); }
  listeners(): ChannelAdapter[] { return [...this.shared.values()].filter(adapter => adapter.available() && adapter.listen); }
}
