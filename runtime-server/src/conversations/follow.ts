import { ConversationError } from "./conversation.js";
import { parseCursor, type EventLog, type LoggedEvent } from "./eventLog.js";
import type { EventCursor } from "../surfaces/contract.js";

export type FollowOptions = { signal: AbortSignal; pollMs?: number };

/** Resolves on the next local append, after `ms` (appends by other processes), or on abort. */
function nextChance(log: EventLog, key: string, options: Required<FollowOptions>): { ready: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const ready = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, options.pollMs);
    const off = log.onAppend(key, resolve);
    const onAbort = () => resolve();
    options.signal.addEventListener("abort", onAbort, { once: true });
    cancel = () => { clearTimeout(timer); off(); options.signal.removeEventListener("abort", onAbort); resolve(); };
  }).finally(() => cancel());
  return { ready, cancel };
}

/** Where a subscriber starts: after the cursor it names, or now when it names none. A cursor the log never issued is refused. */
export async function resumePoint(log: EventLog, key: string, given: string | null | undefined): Promise<EventCursor> {
  const head = await log.head(key);
  if (given === null || given === undefined || given === "") return head;
  const cursor = parseCursor(given);
  if (Number(cursor) > Number(head)) throw new ConversationError(400, "invalid_cursor", "The cursor is ahead of this conversation's events.");
  return cursor;
}

const PARTIAL = new Set(["delta", "thinking"]);

/** A consumer that wants results, not progress: token-level partials never reach it. */
export const withoutPartials = (deliver: (entry: LoggedEvent) => Promise<void> | void) => (entry: LoggedEvent) => PARTIAL.has(entry.event.type) ? undefined : deliver(entry);

/**
 * Replay what is after `cursor`, then keep delivering as the log grows, until aborted.
 * `deliver` is awaited per event, so a consumer's pace is its own: it can never slow the producer.
 */
export async function follow(log: EventLog, key: string, cursor: EventCursor, deliver: (entry: LoggedEvent) => Promise<void> | void, options: FollowOptions): Promise<void> {
  const settings = { pollMs: 250, ...options };
  let position = cursor;
  while (!settings.signal.aborted) {
    const chance = nextChance(log, key, settings);
    const batch = await log.after(key, position);
    for (const entry of batch) {
      if (settings.signal.aborted) break;
      await deliver(entry);
      position = entry.cursor;
    }
    if (batch.length) chance.cancel(); else await chance.ready;
  }
}
