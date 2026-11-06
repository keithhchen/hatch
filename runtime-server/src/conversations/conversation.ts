/**
 * A conversation with something that works for the Expert: a Product worker or the Assistant.
 * Outside agents see every conversation through this one port and this one message shape.
 */
export type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  attachments?: Array<{ type: "image"; name: string }>;
};

export type ConversationState = "idle" | "running" | "failed";
export type ConversationStatus = { state: ConversationState; error?: string };
export type Sent = { conversationId: string; message: PublicMessage; queued: boolean };
export type ConversationEvent = { type: string; [key: string]: unknown };
/** Subscribers get events until they call the returned function. */
export type Unsubscribe = () => void;

export interface Conversation {
  status(): Promise<ConversationStatus>;
  /** Oldest first. Without `after`, the latest `limit`; with it, the first `limit` messages after that id. */
  messages(after?: string, limit?: number): Promise<{ status: ConversationStatus; messages: PublicMessage[] }>;
  send(content: string): Promise<Sent>;
  events(listener: (event: ConversationEvent) => void): Promise<Unsubscribe>;
  stop(): Promise<void>;
}

/** An error the API shows as is: status, machine-readable code and a message for people. */
export class ConversationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) { super(message); }
}

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 500;

/** One page of an ordered list, by cursor. An unknown cursor is the caller's mistake. */
export function page<T extends { id: string }>(all: T[], after?: string, limit = DEFAULT_PAGE): T[] {
  const size = Math.min(Math.max(Math.trunc(limit) || DEFAULT_PAGE, 1), MAX_PAGE);
  if (after === undefined) return all.slice(-size);
  const index = all.findIndex(item => item.id === after);
  if (index < 0) throw new ConversationError(400, "unknown_cursor", `No message with id ${after} in this conversation.`);
  return all.slice(index + 1, index + 1 + size);
}

/** Events that leave the process: no internal session ids and no duplicate voice relays. */
export function publicEvent(event: { type?: string; sessionId?: string; accountId?: string; [key: string]: unknown }): ConversationEvent | undefined {
  if (!event.type || event.type.startsWith("voice.")) return undefined;
  const { sessionId: _session, accountId: _account, ...rest } = event;
  return rest as ConversationEvent;
}
