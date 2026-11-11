import type { EventCursor } from "../surfaces/contract.js";
import { MAX_PAGE, type Conversation, type ConversationStatus, type PublicMessage } from "./conversation.js";
import { START, type EventLog } from "./eventLog.js";

export type Snapshot = {
  cursor: EventCursor;
  status: ConversationStatus;
  messages: PublicMessage[];
  /** The Run in progress, when there is one. */
  run_id?: string;
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
 * History, state, partial output and the cursor they are consistent with: a message is in `messages`
 * or in the events after `cursor`, never both and never neither. The log holds writers back meanwhile.
 */
export async function snapshotOf(conversation: Conversation, log: EventLog): Promise<Snapshot> {
  const key = await conversation.feedKey();
  if (!key) return { cursor: START, status: await conversation.status(), messages: [], partial: "" };
  return log.consistent(key, async cursor => {
    const { status, messages } = await conversation.messages(undefined, MAX_PAGE);
    const partial = status.state !== "running" ? "" : conversation.partial ? await conversation.partial() : await partialOutput(log, key, cursor);
    return { cursor, status, messages, ...(status.runId ? { run_id: status.runId } : {}), partial };
  });
}
