import type { EventCursor } from "../surfaces/contract.js";
import type { ConversationEvent, Unsubscribe } from "./conversation.js";
import type { EventLog, LoggedEvent } from "./eventLog.js";

/**
 * One EventLog over several records: a conversation whose events are kept elsewhere (the Assistant's are its Run's journal)
 * is bound by its key prefix; every other key is in the base log. Clients ask one log and never learn which answered.
 */
export class RoutedEventLog implements EventLog {
  private readonly routes: Array<{ prefix: string; log: EventLog }> = [];
  constructor(private readonly base: EventLog) {}

  bind(prefix: string, log: EventLog): void { this.routes.push({ prefix, log }); }

  private of(key: string): EventLog { return this.routes.find(route => key.startsWith(route.prefix))?.log ?? this.base; }

  append(key: string, event: ConversationEvent): Promise<EventCursor> { return this.of(key).append(key, event); }
  after(key: string, cursor: EventCursor, limit?: number): Promise<LoggedEvent[]> { return this.of(key).after(key, cursor, limit); }
  head(key: string): Promise<EventCursor> { return this.of(key).head(key); }
  commit<T>(key: string, event: ConversationEvent, work: () => Promise<T>): Promise<T> { return this.of(key).commit(key, event, work); }
  consistent<T>(key: string, read: (head: EventCursor) => Promise<T>): Promise<T> { return this.of(key).consistent(key, read); }
  onAppend(key: string, wake: () => void): Unsubscribe { return this.of(key).onAppend(key, wake); }
  live(key: string, push: (event: ConversationEvent) => void): Unsubscribe { return this.of(key).live?.(key, push) ?? (() => undefined); }
}
