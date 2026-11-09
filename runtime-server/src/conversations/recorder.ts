import type { EventEmitter } from "node:events";
import { publicEvent } from "./conversation.js";
import type { EventLog } from "./eventLog.js";

const recording = new WeakSet<EventEmitter>();

/**
 * Writes a producer's public events to the log, in the order they happened, whether or not anyone
 * is watching. A source is recorded once for the life of the process.
 */
export function record(log: EventLog, source: EventEmitter, keyOf: (event: { sessionId?: string; accountId?: string }) => string | undefined): void {
  if (recording.has(source)) return;
  recording.add(source);
  let queue = Promise.resolve();
  source.on("event", (event: { type?: string; sessionId?: string; accountId?: string }) => {
    const key = keyOf(event);
    const shown = key ? publicEvent(event) : undefined;
    if (key && shown) queue = queue.then(() => log.append(key, shown)).then(() => undefined, error => { console.error("[conversation log]", error); });
  });
}
