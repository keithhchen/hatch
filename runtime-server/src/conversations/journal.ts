import type { Journal, JournalEvent } from "../factoryAgents/journal.js";
import { publicEvent } from "./conversation.js";
import type { EventLog } from "./eventLog.js";
import { log } from "../observability/log.js";

/** A runtime's journal in a conversation's event log. Only what leaves the process is written. */
export class EventLogJournal implements Journal {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private log: EventLog, private keyOf: (event: JournalEvent) => string | undefined) {}

  append(event: JournalEvent): void {
    const target = this.target(event);
    if (target) this.enqueue(() => this.log.append(target.key, target.shown)).catch(error => log.error("conversation_log_failed", { error }));
  }

  async commit(event: JournalEvent, persist: () => Promise<unknown>): Promise<void> {
    const target = this.target(event);
    await (target ? this.enqueue(() => this.log.commit(target.key, target.shown, persist)) : persist());
  }

  private target(event: JournalEvent) {
    const key = this.keyOf(event);
    const shown = key ? publicEvent(event) : undefined;
    return key && shown ? { key, shown } : undefined;
  }

  private enqueue<T>(step: () => Promise<T>): Promise<T> {
    const run = this.tail.then(step);
    this.tail = run.catch(() => undefined);
    return run;
  }
}
