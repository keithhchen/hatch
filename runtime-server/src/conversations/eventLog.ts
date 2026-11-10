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
  /**
   * Appends `event` and runs `work` as one step: `consistent` never sees the event without what `work`
   * stored, or the reverse. When `work` throws, nothing is appended.
   */
  commit<T>(key: string, event: ConversationEvent, work: () => Promise<T>): Promise<T>;
  /** Hands `read` the head at a moment no `commit` is half done, and holds commits back until `read` is over. */
  consistent<T>(key: string, read: (head: EventCursor) => Promise<T>): Promise<T>;
  /** Wakes `wake` when this process appends to `key`. Other processes' appends are found by reading. */
  onAppend(key: string, wake: () => void): Unsubscribe;
  /**
   * Events a conversation says as they happen and does not record, such as token deltas: pushed with no cursor of
   * their own, so a reader that joins late gets what was said so far from the snapshot, not from here.
   */
  live?(key: string, push: (event: ConversationEvent) => void): Unsubscribe;
}

/** Single-process adapter. Only tests construct it: a Registry without a database has no event log. */
export class MemoryEventLog implements EventLog {
  private events = new Map<string, LoggedEvent[]>();
  private wakes = new EventEmitter().setMaxListeners(0);
  private turns = new Map<string, Promise<unknown>>();

  private exclusively<T>(key: string, step: () => Promise<T>): Promise<T> {
    const run = (this.turns.get(key) ?? Promise.resolve()).catch(() => undefined).then(step);
    this.turns.set(key, run);
    return run;
  }
  commit<T>(key: string, event: ConversationEvent, work: () => Promise<T>): Promise<T> {
    return this.exclusively(key, async () => { const result = await work(); await this.append(key, event); return result; });
  }
  consistent<T>(key: string, read: (head: EventCursor) => Promise<T>): Promise<T> { return this.exclusively(key, async () => read(await this.head(key))); }

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
