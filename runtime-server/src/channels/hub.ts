import type { ChannelAdapter, ChannelKind } from "./types.js";

/** Finds the adapter for a platform tenant: the Expert's own app when the scope names one (their account id, or the id of a bot of theirs), otherwise our shared one. */
export class ChannelHub {
  private shared = new Map<ChannelKind, ChannelAdapter>();
  constructor(adapters: ChannelAdapter[], private own: (kind: ChannelKind, scope: string) => Promise<ChannelAdapter | undefined> = async () => undefined) {
    for (const adapter of adapters) this.shared.set(adapter.kind, adapter);
  }
  async get(kind: ChannelKind, scope = ""): Promise<ChannelAdapter | undefined> {
    const adapter = (scope ? await this.own(kind, scope) : undefined) ?? this.shared.get(kind);
    return adapter?.available() ? adapter : undefined;
  }
  /** Platforms an Expert can connect to right now without bringing anything. */
  sharedKinds(): ChannelKind[] { return [...this.shared.values()].filter(adapter => adapter.available()).map(adapter => adapter.kind); }
  listeners(): ChannelAdapter[] { return [...this.shared.values()].filter(adapter => adapter.available() && adapter.listen); }
}
