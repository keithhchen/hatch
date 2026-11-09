import type { ClientAttributes, ContentPart, Principal } from "../surfaces/contract.js";

/** A conversation the channel layer addresses: by id, or by the thread it lives in. */
export type ConversationRef =
  | { kind: "conversation"; id: string }
  | { kind: "thread"; connectionId: string; threadId: string };

/** What `send` accepted. A channel keeps `runId` to await the reply. */
export type SentMessage = {
  outcome: "started" | "steered" | "replayed";
  conversationId: string;
  runId: string;
  messageId: string;
};

export type FinalReply = {
  runId: string;
  status: "completed" | "failed" | "cancelled" | "interrupted";
  /** The assistant's final text; empty unless the Run completed. */
  text: string;
  reason?: string;
};

/**
 * What the channel layer calls. Transport-free: the channel adapter owns
 * verification, deduplication of platform events, and delivery of the reply.
 * `messageId` is the key a retry reuses, such as the platform's event id.
 */
export interface ChatGateway {
  send(principal: Principal, conversation: ConversationRef, client: ClientAttributes, messageId: string, parts: ContentPart[]): Promise<SentMessage>;
  /** Resolves when the Run ends, one reply per Run, however many messages joined it. */
  finalReply(sent: SentMessage, options?: { signal?: AbortSignal; pollMs?: number }): Promise<FinalReply>;
}
