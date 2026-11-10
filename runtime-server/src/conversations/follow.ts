import { ConversationError, type ConversationEvent } from "./conversation.js";
import { parseCursor, type EventLog, type LoggedEvent } from "./eventLog.js";
import type { EventCursor } from "../surfaces/contract.js";

export type FollowOptions = { signal: AbortSignal; pollMs?: number };

/** Resolves on the next local append or live event, after `ms` (appends by other processes), or on abort. */
function nextChance(log: EventLog, key: string, options: Required<FollowOptions>, wakeOnLive: { on: (wake: () => void) => () => void }): { ready: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const ready = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, options.pollMs);
    const off = log.onAppend(key, resolve);
    const offLive = wakeOnLive.on(resolve);
    const onAbort = () => resolve();
    options.signal.addEventListener("abort", onAbort, { once: true });
    cancel = () => { clearTimeout(timer); off(); offLive(); options.signal.removeEventListener("abort", onAbort); resolve(); };
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

/** A reader that falls this far behind the live events is let go; it reconnects by cursor. */
const MAX_LIVE_BACKLOG = 2000;

/**
 * Replay what is after `cursor`, then keep delivering as the log grows, until aborted.
 * `deliver` is awaited per event, so a consumer's pace is its own: it can never slow the producer.
 * Live events (not recorded) are delivered before the recorded events read at the same moment: a recorded event is
 * committed after the live ones that led to it, so a reader never sees a reply's end before its last words.
 */
export async function follow(log: EventLog, key: string, cursor: EventCursor, deliver: (entry: LoggedEvent) => Promise<void> | void, options: FollowOptions): Promise<void> {
  const lagging = new AbortController();
  const settings = { pollMs: 250, ...options, signal: AbortSignal.any([options.signal, lagging.signal]) };
  let position = cursor;
  const backlog: ConversationEvent[] = [];
  const waiting = new Set<() => void>();
  const stopLive = log.live?.(key, event => {
    // Too far behind: stop reading rather than grow without bound or slow the Run; the reader reconnects by cursor.
    if (backlog.length >= MAX_LIVE_BACKLOG) { backlog.length = 0; lagging.abort(); return; }
    backlog.push(event);
    for (const wake of [...waiting]) wake();
  });
  try {
    while (!settings.signal.aborted) {
      const chance = nextChance(log, key, settings, { on: wake => { waiting.add(wake); return () => { waiting.delete(wake); }; } });
      const batch = await log.after(key, position);
      for (const event of backlog.splice(0)) {
        if (settings.signal.aborted) break;
        await deliver({ cursor: position, event });
      }
      for (const entry of batch) {
        if (settings.signal.aborted) break;
        await deliver(entry);
        position = entry.cursor;
      }
      if (batch.length || backlog.length) chance.cancel(); else await chance.ready;
    }
  } finally { stopLive?.(); }
}
