import type { EventCursor } from "../surfaces/contract.js";
import { MAX_PAGE, type Conversation, type ConversationStatus, type HistoryPage, type PublicMessage } from "./conversation.js";
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

/** A snapshot of a conversation that pages back: whether earlier messages exist, and where they begin. */
export type View = Snapshot & Pick<HistoryPage, "has_more" | "before_cursor">;

/** How far back to look for the end of the last message when building partial output. */
const PARTIAL_WINDOW = 2000;

const partialOutput = async (log: EventLog, key: string, head: EventCursor): Promise<string> => {
  const events = (await log.after(key, String(Math.max(Number(START), Number(head) - PARTIAL_WINDOW)), PARTIAL_WINDOW)).filter(entry => Number(entry.cursor) <= Number(head));
  const types = events.map(entry => entry.event.type);
  const settled = Math.max(types.lastIndexOf("message_end"), types.lastIndexOf("run_end"));
  return events.slice(settled + 1).map(entry => entry.event.type === "delta" ? String(entry.event.text ?? "") : "").join("");
};

type Read = () => Promise<{ status: ConversationStatus; messages: PublicMessage[] } & Partial<Pick<HistoryPage, "has_more" | "before_cursor">>>;

/**
 * What `read` returns, with the partial output and the cursor they are consistent with: a message is in `messages`
 * or in the events after `cursor`, never both and never neither. The log holds writers back meanwhile.
 */
async function consistentRead(conversation: Conversation, log: EventLog, read: Read) {
  const key = await conversation.feedKey();
  if (!key) return { cursor: START, status: await conversation.status(), messages: [] as PublicMessage[], partial: "" };
  return log.consistent(key, async cursor => {
    const { status, messages, ...paging } = await read();
    const partial = status.state !== "running" ? "" : conversation.partial ? await conversation.partial() : await partialOutput(log, key, cursor);
    return { cursor, status, messages, ...(status.runId ? { run_id: status.runId } : {}), partial, ...paging };
  });
}

/** History, state, partial output and the cursor they are consistent with. */
export function snapshotOf(conversation: Conversation, log: EventLog): Promise<Snapshot> {
  return consistentRead(conversation, log, () => conversation.messages(undefined, MAX_PAGE));
}

/** `snapshotOf` for a page that reads on: the newest `limit` messages and where the earlier ones begin. */
export async function viewOf(conversation: Conversation, log: EventLog, limit?: number): Promise<View> {
  const snapshot = await consistentRead(conversation, log, async () => {
    if (!conversation.history) return { ...(await conversation.messages(undefined, limit)), has_more: false };
    const [status, page] = await Promise.all([conversation.status(), conversation.history({ limit })]);
    return { status, ...page };
  });
  return { has_more: false, ...snapshot };
}
