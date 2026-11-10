/**
 * A conversation with something that works for the Expert: a Product worker or the Assistant.
 * Outside agents see every conversation through this one port and this one message shape.
 */
import type { RunFailure } from "../factoryAgents/runFailure.js";
import type { ClientAttributes } from "../surfaces/contract.js";

export type { RunFailure };

export type PublicMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  created_at: string;
  /** "queued": the message joined a running turn and is not yet read by the model. Absent once it is. */
  state?: "queued";
  attachments?: Array<{ type: "image" | "file" | "audio"; name: string; asset_id?: string; bytes?: number }>;
};

/** An asset the upload side has finished with. Bytes live in the workspace at `path`; the model reads them there. */
export type ReadyAsset = { id: string; kind: "image" | "file" | "audio"; name: string; mimeType: string; bytes: number; sha256: string; path: string; transcript?: string };

/** What a client sent, with every attachment already resolved to a ready asset. */
export type SendInput = {
  /** Assigned by the host; it is the message id in history. */
  id: string;
  text: string;
  attachments: ReadyAsset[];
  client: ClientAttributes;
  /** The client's idempotency key. Without one a repeated send is a new message. */
  key?: string;
};

export type ConversationState = "idle" | "running" | "failed";
/** `runId` names the Run in progress; it is not the conversation, and a conversation has many Runs. `error` is why the last Run failed. */
export type ConversationStatus = { state: ConversationState; error?: RunFailure; runId?: string };
/** `runId` is the Run that took the message, when the conversation can say. */
export type Sent = { conversationId: string; message: PublicMessage; queued: boolean; runId?: string };
export type ConversationEvent = { type: string; [key: string]: unknown };
export type Unsubscribe = () => void;

export interface Conversation {
  status(): Promise<ConversationStatus>;
  /** Oldest first. Without `after`, the latest `limit`; with it, the first `limit` messages after that id. */
  messages(after?: string, limit?: number): Promise<{ status: ConversationStatus; messages: PublicMessage[] }>;
  /** Atomic: the message steers the running turn or starts one, and is never lost. */
  send(input: SendInput): Promise<Sent>;
  /** Key of this conversation's event log; nothing until the conversation exists. */
  feedKey(): Promise<string | undefined>;
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
