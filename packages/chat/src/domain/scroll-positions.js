/**
 * Where each conversation was scrolled, keyed by conversation id, most
 * recent last and bounded. A position at the bottom is remembered as
 * `atBottom` so returning keeps following new replies instead of landing on
 * an old absolute offset. Hosts may observe changes to persist them.
 */
export class ScrollPositions {
  constructor({ limit = 50, entries = {}, onChange = null } = {}) {
    this.limit = limit;
    this.onChange = onChange;
    this.positions = new Map();
    this.restore(entries);
  }

  /** Seed from persisted entries (most recent first); positions recorded since stay newer. */
  restore(entries) {
    const current = [...this.positions];
    this.positions = new Map();
    for (const [id, position] of Object.entries(entries ?? {}).reverse()) this.write(id, position);
    for (const [id, position] of current) this.write(id, position);
  }

  /** @returns {{ top: number, atBottom: boolean } | null} */
  get(conversationId) {
    return this.positions.get(conversationId) ?? null;
  }

  save(conversationId, position) {
    if (!this.write(conversationId, position)) return;
    this.onChange?.(this.toJSON());
  }

  write(conversationId, { top, atBottom } = {}) {
    if (typeof conversationId !== "string" || !conversationId || !Number.isFinite(top) || top < 0 || typeof atBottom !== "boolean") return false;
    const previous = this.positions.get(conversationId);
    if (previous && previous.atBottom === atBottom && (atBottom || previous.top === top)) return false;
    this.positions.delete(conversationId);
    this.positions.set(conversationId, Object.freeze({ top: Math.round(top), atBottom }));
    while (this.positions.size > this.limit) this.positions.delete(this.positions.keys().next().value);
    return true;
  }

  /** Most recent first, so a bounded store keeps the newest entries. */
  toJSON() {
    return Object.fromEntries([...this.positions].reverse());
  }
}

/** The in-memory default every ChatView shares unless the host supplies its own. */
export const sharedScrollPositions = new ScrollPositions();
