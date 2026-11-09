import type { Pool } from "pg";
import { MemoryEventLog, type EventLog } from "./eventLog.js";
import { MemoryMessageLedger, type MessageLedger } from "./ledger.js";
import { PostgresEventLog } from "./postgresEventLog.js";
import { PostgresMessageLedger } from "./postgresLedger.js";

/** What conversations keep beyond a process: the event log and the idempotency ledger. */
export type ConversationPorts = { eventLog: EventLog; ledger: MessageLedger };

/** In Postgres when the Registry has a database, shared by every process; otherwise in this process only. */
export async function openConversationPorts(pool?: Pool): Promise<ConversationPorts> {
  return pool
    ? { eventLog: await PostgresEventLog.open(pool), ledger: await PostgresMessageLedger.open(pool) }
    : { eventLog: new MemoryEventLog(), ledger: new MemoryMessageLedger() };
}
