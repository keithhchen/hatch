import type { EventCursor } from "../surfaces/contract.js";
import { MAX_PAGE, type Conversation, type ConversationStatus, type PublicMessage } from "./conversation.js";
import { START, type EventLog } from "./eventLog.js";

export type Snapshot = {
  cursor: EventCursor;
  status: ConversationStatus;
  messages: PublicMessage[];
  /** What the running turn has said so far and not yet finished saying. */
  partial: string;
};

/** How far back to look for the end of the last message when building partial output. */
const PARTIAL_WINDOW = 2000;

const partialOutput = async (log: EventLog, key: string, head: EventCursor): Promise<string> => {
  const events = (await log.after(key, String(Math.max(Number(START), Number(head) - PARTIAL_WINDOW)), PARTIAL_WINDOW)).filter(entry => Number(entry.cursor) <= Number(head));
  const types = events.map(entry => entry.event.type);
  const settled = Math.max(types.lastIndexOf("message_end"), types.lastIndexOf("run_end"));
  return events.slice(settled + 1).map(entry => entry.event.type === "delta" ? String(entry.event.text ?? "") : "").join("");
};

/**
 * History, state, partial output and the cursor they are consistent with.
 * The log head is read before and after history; when it moved, the read is repeated,
 * so every event after `cursor` is one the history may not yet reflect.
 */
export async function snapshotOf(conversation: Conversation, log: EventLog): Promise<Snapshot> {
  const key = await conversation.feedKey();
  if (!key) return { cursor: START, status: await conversation.status(), messages: [], partial: "" };
  for (let attempt = 0; ; attempt++) {
    const cursor = await log.head(key);
    const { status, messages } = await conversation.messages(undefined, MAX_PAGE);
    if (attempt >= 4 || await log.head(key) === cursor) return { cursor, status, messages, partial: status.state === "running" ? await partialOutput(log, key, cursor) : "" };
  }
}
