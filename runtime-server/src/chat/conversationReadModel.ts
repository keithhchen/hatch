import type { ConversationHistoryOptions, ConversationHistoryPage } from "../conversationHistory.js";
import type { ConversationRepository, QueuedMessage } from "../conversationRepository.js";
import { publicJournalPayload } from "./messageLedger.js";
import type { RuntimeStore, VisibleConversationMessage } from "../store.js";

/**
 * A message as every client reads it. `id` is the one it was stored under: its client's key for a user message,
 * `<run_id>:<n>` for a reply. `accepted_at` is when the server took it in. `state` is "queued" for a message that joined
 * a running Run and is not yet in the transcript: it is already the conversation's, and never lost.
 */
export type ReadMessage = VisibleConversationMessage & { id: string; accepted_at: string; state?: "queued" };
export type ConversationReadPage = Omit<ConversationHistoryPage, "messages"> & { messages: ReadMessage[] };

/** What a conversation looks like, paged, for every client: Studio's page, Product web, the CLI and IM alike. */
export interface ConversationReadModel {
  /** The newest page, or the one before `beforeCursor`. Only the newest page carries queued messages. */
  page(conversationId: string, options?: ConversationHistoryOptions): Promise<ConversationReadPage>;
}

const queuedAsMessage = (queued: QueuedMessage): ReadMessage => {
  const { attachments, typed, content } = publicJournalPayload({ message: queued.message }).message as QueuedMessage["message"];
  return {
    id: queued.clientMessageId, run_id: queued.runId, role: "user", content: typed ?? content ?? "",
    timestamp: queued.acceptedAt, accepted_at: queued.acceptedAt, state: "queued",
    ...(attachments?.length ? { attachments: attachments.map((attachment) => "text" in attachment ? (({ text: _text, ...reference }) => reference)(attachment) : attachment) } : {})
  };
};

/** The transcript's visible history plus what the journal has accepted and the transcript does not yet hold. */
export class ChatConversationReadModel implements ConversationReadModel {
  constructor(private readonly deps: {
    history: Pick<RuntimeStore, "readVisibleConversationPage">;
    repository: Pick<ConversationRepository, "queuedMessages">;
  }) {}

  async page(conversationId: string, options: ConversationHistoryOptions = {}): Promise<ConversationReadPage> {
    // Queued first: a message claimed in between is then in the page too and is dropped below, never in neither.
    const queued = options.beforeCursor === undefined ? await this.deps.repository.queuedMessages(conversationId) : [];
    const page = await this.deps.history.readVisibleConversationPage(conversationId, options);
    const committed = page.messages.map((message): ReadMessage => ({ ...message, id: message.id!, accepted_at: message.timestamp }));
    const held = new Set(committed.map((message) => message.id));
    return { ...page, messages: [...committed, ...queued.filter((message) => !held.has(message.clientMessageId)).map(queuedAsMessage)] };
  }
}
