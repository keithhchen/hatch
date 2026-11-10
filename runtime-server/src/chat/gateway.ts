import type { ClientAttributes, ContentPart, Principal } from "../surfaces/contract.js";

/** A conversation the channel layer addresses: by id, or by the thread it lives in. */
export type ConversationRef =
  | { kind: "conversation"; id: string }
  | { kind: "thread"; connectionId: string; threadId: string };

/** What `send` accepted. A channel keeps `runId` to learn how the Run went. */
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
 * Where a Run stands, read from durable state: any process may ask at any time, also after a restart of either side.
 * `compactionId` names the compaction in progress, so a notice is sent once per compaction.
 */
export type RunProgress = { ended: false; compactionId?: string } | { ended: true; reply: FinalReply };

/**
 * The one contract between the channel layer and Chat. Transport-free: the channel adapter owns verification,
 * deduplication of platform events, and delivery of the reply. Chat implements it in its own process
 * (ServiceChatGateway); the Registry reaches it over a service-authenticated HTTP adapter of the same shape.
 */
/** A stored upload: the asset, and the kind the content turned out to be, which is the type of the part that refers to it. */
export type UploadedRef = { assetId: string; kind: Exclude<ContentPart, { type: "text" }>["type"] };

export interface ChatGateway {
  /**
   * Steers the conversation's active Run or starts one, atomically. `messageId` is the key a retry reuses, such as the
   * platform's event id: a repeat yields the same message and Run.
   */
  send(principal: Principal, conversation: ConversationRef, client: ClientAttributes, messageId: string, parts: ContentPart[]): Promise<SentMessage>;
  /** Stores a file in the conversation's scope and returns the asset a message refers to. Its kind, decided by the content, is the type of the part that carries it. */
  upload(principal: Principal, conversation: ConversationRef, input: { name: string; bytes: Buffer }): Promise<UploadedRef>;
  /** Undefined for a Run that does not exist. One reply per Run, however many messages joined it. */
  progress(runId: string): Promise<RunProgress | undefined>;
}
