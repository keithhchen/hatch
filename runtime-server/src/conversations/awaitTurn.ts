import type { Conversation, ConversationStatus, PublicMessage } from "./conversation.js";
import { MAX_PAGE } from "./conversation.js";

export type TurnOutcome = { status: ConversationStatus; reply?: PublicMessage };
export type AwaitOptions = {
  /** The message just sent. Only what comes after it counts as the reply. */
  sentId: string;
  /** The last message id before sending. */
  after?: string;
  timeoutMs: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** What the conversation said after `sent`, as one reply: a turn may speak more than once. */
const joined = (replies: PublicMessage[]): PublicMessage => ({ ...replies.at(-1)!, text: replies.map(r => r.text).join("\n\n") });

/**
 * Hold until the turn that took `sentId` is over, or the time is up. Works over any Conversation:
 * it only reads messages and status, so it needs no knowledge of how a turn runs.
 * Done means: the message is in history, nothing is running, and the reply (if any) came after it.
 */
export async function awaitTurn(conversation: Conversation, options: AwaitOptions): Promise<TurnOutcome> {
  const { sentId, after, timeoutMs, pollMs = 500, sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms)), now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const { status, messages } = await conversation.messages(after, MAX_PAGE);
    const sent = messages.findIndex(message => message.id === sentId);
    const replies = sent < 0 ? [] : messages.slice(sent + 1).filter(message => message.role === "assistant");
    if (sent >= 0 && status.state !== "running") return replies.length ? { status, reply: joined(replies) } : { status };
    if (now() >= deadline) return { status };
    await sleep(pollMs);
  }
}
