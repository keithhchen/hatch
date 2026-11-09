/** Receives an event without waiting. A sink that cannot keep up throws and is dropped; it reconnects by cursor. */
export interface EventSink {
  push(event: Record<string, unknown>): void;
}

/**
 * Live events of the Runs this process executes. Publishing never awaits a
 * consumer, so a slow client can fall behind or be dropped but cannot slow a Run.
 */
export class RunEventHub {
  private readonly sinks = new Map<string, Set<EventSink>>();

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
    const group = this.sinks.get(conversationId);
    if (!group) return;
    for (const sink of [...group]) {
      try { sink.push(event); } catch { group.delete(sink); }
    }
  }
}
