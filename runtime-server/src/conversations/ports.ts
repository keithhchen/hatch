import type { Pool } from "pg";
import { ConversationError, type ConversationEvent, type Unsubscribe } from "./conversation.js";
import type { EventLog, LoggedEvent } from "./eventLog.js";
import type { Claim, MessageLedger } from "./ledger.js";
import { PostgresEventLog } from "./postgresEventLog.js";
import { PostgresMessageLedger } from "./postgresLedger.js";

/** What conversations keep beyond a process: the event log and the idempotency ledger. */
export type ConversationPorts = { eventLog: EventLog; ledger: MessageLedger };

const unavailable = () => new ConversationError(503, "conversations_unavailable", "Conversations need the Registry database, and none is configured.");

/** The port of a Registry without a database. It says so on every use; it keeps nothing. */
class UnavailableEventLog implements EventLog {
  async append(): Promise<never> { throw unavailable(); }
  async after(): Promise<LoggedEvent[]> { throw unavailable(); }
  async head(): Promise<never> { throw unavailable(); }
  async commit<T>(_key: string, _event: ConversationEvent, _work: () => Promise<T>): Promise<never> { throw unavailable(); }
  async consistent(): Promise<never> { throw unavailable(); }
  onAppend(): Unsubscribe { return () => undefined; }
}

class UnavailableLedger implements MessageLedger {
  async claim(): Promise<Claim> { throw unavailable(); }
  async settle(): Promise<never> { throw unavailable(); }
  async release(): Promise<never> { throw unavailable(); }
}

/** In Postgres, shared by every process. Without a database, ports that report unavailability: never a copy in this process's memory. */
export async function openConversationPorts(pool?: Pool): Promise<ConversationPorts> {
  return pool
    ? { eventLog: await PostgresEventLog.open(pool), ledger: await PostgresMessageLedger.open(pool) }
    : { eventLog: new UnavailableEventLog(), ledger: new UnavailableLedger() };
}
