import type { EventRelay } from "./eventRelay.js";

/** Receives an event without waiting. A sink that cannot keep up throws and is dropped; it reconnects by cursor. */
export interface EventSink {
  push(event: Record<string, unknown>): void;
}

/**
 * Live events of the Runs, wherever they execute. Publishing never awaits a consumer, so a slow client can
 * fall behind or be dropped but cannot slow a Run. With a relay, other instances' events arrive here too.
 */
export class RunEventHub {
  private readonly sinks = new Map<string, Set<EventSink>>();

  constructor(private readonly relay?: EventRelay) {}

  /** Starts hearing the other instances; resolves to the way to stop. */
  listen(): Promise<() => Promise<void>> {
    return this.relay?.subscribe((conversationId, event) => this.deliver(conversationId, event)) ?? Promise.resolve(async () => undefined);
  }

  subscribe(conversationId: string, sink: EventSink): () => void {
    const group = this.sinks.get(conversationId) ?? new Set<EventSink>();
    group.add(sink);
    this.sinks.set(conversationId, group);
    return () => {
      group.delete(sink);
      if (group.size === 0 && this.sinks.get(conversationId) === group) this.sinks.delete(conversationId);
    };
  }

  publish(conversationId: string, event: Record<string, unknown>): void {
    this.deliver(conversationId, event);
    this.relay?.publish(conversationId, event);
  }

  /** To this instance's observers only. */
  private deliver(conversationId: string, event: Record<string, unknown>): void {
    const group = this.sinks.get(conversationId);
    if (!group) return;
    for (const sink of [...group]) {
      try { sink.push(event); } catch { group.delete(sink); }
    }
  }
}
