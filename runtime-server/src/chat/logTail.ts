import { reported } from "../observability/reported.js";
import type { PublicLogEvent, RuntimeStore } from "../store.js";
import type { EventSink, RunEventHub } from "./runEventHub.js";

/** Even without news, a tail looks at the log this often: news can be lost (a dropped notification, a lost connection), the log cannot. */
export const LOG_TAIL_SAFETY_POLL_MS = 1_500;
const PAGE = 100;

/**
 * Follows a conversation's log for one observer: everything after a position, in order and once, then whatever is appended.
 * It hears of appends from the hub and reads the log by position, so it serves any Run on any instance, survives a restart,
 * and a notification it misses costs a delay. An observer that cannot keep up (its sink throws) is let go and comes back with its last position.
 */
export class LogTail {
  constructor(private readonly deps: {
    source: Pick<RuntimeStore, "readLogPage" | "logHead">;
    hub: Pick<RunEventHub, "subscribe">;
    pollMs?: number;
  }) {}

  /** `after` absent: from where the log stands now. Resolves to the way to stop. */
  attach(conversationId: string, after: number | undefined, sink: EventSink): () => void {
    let last = after ?? -1;
    let stopped = false;
    let running = false;
    let again = false;
    let lastFailure = "";
    const stop = (): void => { stopped = true; clearInterval(poll); unsubscribe(); };
    const read = async (): Promise<void> => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          if (last < 0) last = await this.deps.source.logHead(conversationId);
          for (let more = true; more && !stopped;) {
            const from = last;
            const page = await this.deps.source.readLogPage(conversationId, { after: last, limit: PAGE });
            for (const event of page.events) {
              if (event.position <= last) continue;
              last = event.position;
              sink.push(event as unknown as Record<string, unknown>);
            }
            // The page covered every row up to its head: rows it leaves out (internal ones) advance the position too.
            if (!page.has_more) last = Math.max(last, page.head);
            more = page.has_more && last > from;
          }
        } while (again && !stopped);
      } catch (error) {
        if (error instanceof Error && error.name === "SlowConsumerError") stop();
        else {
          // The next poll tries again; the same failure is logged once.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== lastFailure) { lastFailure = message; reported("log_tail_read_failed", { conversation_id: conversationId })(error); }
        }
      } finally { running = false; }
    };
    // Subscribed before the first read: an append between the two is heard, and what the read covers is not sent twice.
    const unsubscribe = this.deps.hub.subscribe(conversationId, () => void read());
    const poll = setInterval(() => void read(), this.deps.pollMs ?? LOG_TAIL_SAFETY_POLL_MS);
    poll.unref();
    void read();
    return stop;
  }
}
