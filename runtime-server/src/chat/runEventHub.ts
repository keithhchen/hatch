import { reported } from "../observability/reported.js";
import type { EventRelay } from "./eventRelay.js";

/** Receives an event without waiting. A sink that cannot keep up throws and is dropped; it reconnects by position. */
export interface EventSink {
  push(event: Record<string, unknown>): void;
}

export type AdvancedListener = (position: number) => void;

/**
 * Tells observers a conversation's log advanced, wherever the Run executes. It carries no events: whoever appends to the
 * log calls `advanced` after the append commits, and observers read the log by position. Never awaits a listener.
 * With a relay, other instances' news arrives here too.
 */
export class RunEventHub {
  private readonly listeners = new Map<string, Set<AdvancedListener>>();

  /** `head` is where a conversation's log stands now; it serves whoever advanced the log without knowing its position. */
  constructor(private readonly relay?: EventRelay, private readonly head?: (conversationId: string) => Promise<number>) {}

  /** Starts hearing the other instances; resolves to the way to stop. */
  listen(): Promise<() => Promise<void>> {
    return this.relay?.subscribe((conversationId, position) => this.deliver(conversationId, position)) ?? Promise.resolve(async () => undefined);
  }

  subscribe(conversationId: string, listener: AdvancedListener): () => void {
    const group = this.listeners.get(conversationId) ?? new Set<AdvancedListener>();
    group.add(listener);
    this.listeners.set(conversationId, group);
    return () => {
      group.delete(listener);
      if (group.size === 0 && this.listeners.get(conversationId) === group) this.listeners.delete(conversationId);
    };
  }

  /** The log of `conversationId` holds events up to `position`, committed. */
  advanced(conversationId: string, position: number): void {
    this.deliver(conversationId, position);
    this.relay?.publish(conversationId, position);
  }

  /** For whoever wrote to the log through the repository and so knows no position: tells observers where the log stands now. */
  async advancedToHead(conversationId: string): Promise<void> {
    if (!this.head) throw new Error("This hub was built without a way to read the log head");
    // What was written is written: a head that cannot be read costs observers a delay (their safety poll), never the writer.
    try { this.advanced(conversationId, await this.head(conversationId)); } catch (error) { reported("log_advance_failed", { conversation_id: conversationId })(error); }
  }

  /** To this instance's observers only. */
  private deliver(conversationId: string, position: number): void {
    const group = this.listeners.get(conversationId);
    if (!group) return;
    for (const listener of [...group]) {
      try { listener(position); } catch { group.delete(listener); }
    }
  }
}
