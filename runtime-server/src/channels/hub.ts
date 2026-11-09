import type { ChannelAdapter, ChannelKind } from "./types.js";

/** Finds the adapter for a platform tenant: our shared one, or the Expert's own app (the scope is then their account id). */
export class ChannelHub {
  private shared = new Map<ChannelKind, ChannelAdapter>();
  constructor(adapters: ChannelAdapter[], private own: (kind: ChannelKind, scope: string) => Promise<ChannelAdapter | undefined> = async () => undefined) {
    for (const adapter of adapters) this.shared.set(adapter.kind, adapter);
  }
  async get(kind: ChannelKind, scope = ""): Promise<ChannelAdapter | undefined> {
    const adapter = this.shared.get(kind) ?? (scope ? await this.own(kind, scope) : undefined);
    return adapter?.available() ? adapter : undefined;
  }
  /** Platforms an Expert can connect to right now without bringing anything. */
  sharedKinds(): ChannelKind[] { return [...this.shared.values()].filter(adapter => adapter.available()).map(adapter => adapter.kind); }
  listeners(): ChannelAdapter[] { return [...this.shared.values()].filter(adapter => adapter.available() && adapter.listen); }
}
