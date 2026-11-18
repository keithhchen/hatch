import { RESYNC_EVENT, type EventRelay } from "./eventRelay.js";
import { TERMINAL_STATUSES } from "./runResult.js";
import { RunLedger, type LiveRun } from "./runLedger.js";

/** A Run's text longer than this keeps only its tail in memory; the snapshot holds all of it. */
const MAX_LIVE_TEXT = 1024 * 1024;

/** The text of a conversation's current Run seen so far, from `base`: what a late observer needs to catch up. */
type LiveText = { runId: unknown; base: number; text: string };

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
  private readonly live = new Map<string, LiveText>();
  private readonly ledgers = new Map<string, RunLedger>();

  constructor(private readonly relay?: EventRelay) {}

  /** Starts hearing the other instances; resolves to the way to stop. */
  listen(): Promise<() => Promise<void>> {
    return this.relay?.subscribe((conversationId, event) => this.deliver(conversationId, event), () => this.resyncAll()) ?? Promise.resolve(async () => undefined);
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

  /** Numbers each event of a Run in order, so any observer can tell what it holds from what it has not heard. */
  publish(conversationId: string, event: Record<string, unknown>): void {
    const ledger = this.ledgers.get(conversationId);
    const numbered = typeof event.run_id === "string" && typeof event.seq !== "number"
      ? { ...event, seq: (ledger?.runId === event.run_id ? ledger.seq : 0) + 1 } : event;
    this.deliver(conversationId, numbered);
    this.relay?.publish(conversationId, numbered);
  }

  /**
   * The Run in progress as a page would have shown it so far, undefined when there is none or this instance did not hear all of it.
   * A page that applies it and then skips every event numbered at or below `seq` has seen each event exactly once.
   */
  liveRun(conversationId: string, runId?: string): LiveRun | undefined {
    const ledger = this.ledgers.get(conversationId);
    return ledger?.complete && !ledger.ended && (!runId || ledger.runId === runId) ? ledger.view() : undefined;
  }

  /** The Run's text so far as one delta; a client that already holds part of it skips that part by offset. */
  catchUp(conversationId: string): Record<string, unknown> | undefined {
    const live = this.live.get(conversationId);
    return live && { type: "assistant.delta", run_id: live.runId, delta: { kind: "text", content: live.text, offset: live.base } };
  }

  private track(conversationId: string, event: Record<string, unknown>): void {
    if (event.type === "turn.state" && TERMINAL_STATUSES.has(String(event.status))) { this.live.delete(conversationId); const ended = this.ledgers.get(conversationId); if (ended && ended.runId === event.run_id) ended.end(); return; }
    if (typeof event.run_id === "string") {
      let ledger = this.ledgers.get(conversationId);
      if (ledger?.runId !== event.run_id) { ledger = new RunLedger(event.run_id); this.ledgers.set(conversationId, ledger); }
      ledger.accept(event);
    }
    const delta = event.type === "assistant.delta" ? event.delta as { kind?: string; content?: string; offset?: number } : undefined;
    if (delta?.kind !== "text" || typeof delta.content !== "string" || typeof delta.offset !== "number") return;
    let live = this.live.get(conversationId);
    // A new Run, or an event the relay dropped, starts the text again from where this delta is.
    if (!live || live.runId !== event.run_id || live.base + live.text.length !== delta.offset) live = { runId: event.run_id, base: delta.offset, text: "" };
    live.text += delta.content;
    if (live.text.length > MAX_LIVE_TEXT) { const cut = live.text.length - MAX_LIVE_TEXT; live.text = live.text.slice(cut); live.base += cut; }
    this.live.set(conversationId, live);
  }

  /** Events may have been missed on every conversation: each observer is told to read again. */
  private resyncAll(): void {
    this.live.clear();
    for (const conversationId of [...this.sinks.keys()]) this.deliver(conversationId, RESYNC_EVENT);
  }

  /** To this instance's observers only. */
  private deliver(conversationId: string, event: Record<string, unknown>): void {
    this.track(conversationId, event);
    const group = this.sinks.get(conversationId);
    if (!group) return;
    for (const sink of [...group]) {
      try { sink.push(event); } catch { group.delete(sink); }
    }
  }
}
