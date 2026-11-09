import { EventEmitter } from "node:events";
import type { EventCursor } from "../surfaces/contract.js";
import { ConversationError, type ConversationEvent, type Unsubscribe } from "./conversation.js";

export type LoggedEvent = { cursor: EventCursor; event: ConversationEvent };

export const START: EventCursor = "0";

/** A cursor is a position the log handed out. Anything else is the caller's mistake. */
export function parseCursor(value: string | null | undefined): EventCursor {
  if (value === undefined || value === null || value === "") return START;
  if (!/^\d{1,15}$/.test(value)) throw new ConversationError(400, "invalid_cursor", "The cursor is not a position in this conversation's events.");
  return String(Number(value));
}

/**
 * The durable record of what happened in a conversation. Cursors are consecutive integers per key,
 * so a cursor taken from `head` and a cursor on an event are on one scale.
 * Producers never wait for consumers: reading is the only way anyone sees an event.
 */
export interface EventLog {
  append(key: string, event: ConversationEvent): Promise<EventCursor>;
  /** Oldest first, strictly after `cursor`. */
  after(key: string, cursor: EventCursor, limit?: number): Promise<LoggedEvent[]>;
  /** The latest cursor; START when nothing was appended. */
  head(key: string): Promise<EventCursor>;
  /** Wakes `wake` when this process appends to `key`. Other processes' appends are found by reading. */
  onAppend(key: string, wake: () => void): Unsubscribe;
}

/** Single-process adapter, for tests and a Registry without a database. */
export class MemoryEventLog implements EventLog {
  private events = new Map<string, LoggedEvent[]>();
  private wakes = new EventEmitter().setMaxListeners(0);

  async append(key: string, event: ConversationEvent): Promise<EventCursor> {
    const list = this.events.get(key) ?? [];
    const cursor = String(list.length + 1);
    this.events.set(key, [...list, { cursor, event }]);
    this.wakes.emit(key);
    return cursor;
  }
  async after(key: string, cursor: EventCursor, limit = 500): Promise<LoggedEvent[]> { return (this.events.get(key) ?? []).slice(Number(cursor), Number(cursor) + limit); }
  async head(key: string): Promise<EventCursor> { return String(this.events.get(key)?.length ?? 0); }
  onAppend(key: string, wake: () => void): Unsubscribe { this.wakes.on(key, wake); return () => { this.wakes.off(key, wake); }; }
}
