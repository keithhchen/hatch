import type { AssetDesk } from "./assets.js";
import type { ClientAttributes } from "../surfaces/contract.js";
import { ChatError } from "../chat/principal.js";
import { ConversationError, type Conversation, type ConversationStatus, type HistoryPage, type PublicMessage, type SendInput, type Sent } from "./conversation.js";

/** The part of the Assistant an account-level conversation needs: its conversation on Chat, and where uploads for it go. */
export interface AssistantHost {
  status(accountId: string): Promise<ConversationStatus>;
  /** What the Expert and the Assistant said, oldest first: the latest `limit`, or the first `limit` after message `after`. */
  lines(accountId: string, after?: string, limit?: number): Promise<PublicMessage[]>;
  /** The newest page of the conversation, or the one before `before`. */
  history(accountId: string, options: { limit?: number; before?: string }): Promise<HistoryPage>;
  /** Steers the running turn with the message or starts one, atomically, and says which Run took it. */
  send(accountId: string, input: SendInput): Promise<Sent>;
  stop(accountId: string): Promise<void>;
  /** Answers the conversation again after a failed Run; the same key is the same Run. */
  retry(accountId: string, input: { id: string; client: ClientAttributes }): Promise<{ run: { id: string }; outcome: "started" | "replayed" }>;
  /** What the running turn has said so far. */
  partial(accountId: string): Promise<string>;
  feedKey(accountId: string): string;
  /** The conversation's id, which is also the scope its attachments live in. */
  conversationId(accountId: string): string;
  /** Uploads and lookups of attachments for this conversation. */
  assets(): AssetDesk;
}

/** The account's Assistant chat, in the same shape as a worker's. */
export class AssistantConversation implements Conversation {
  constructor(private accountId: string, private assistant: AssistantHost) {}

  status(): Promise<ConversationStatus> { return this.assistant.status(this.accountId); }

  async messages(after?: string, limit?: number) {
    const [status, messages] = await Promise.all([this.status(), this.assistant.lines(this.accountId, after, limit)]);
    return { status, messages };
  }

  history(options: { limit?: number; before?: string }): Promise<HistoryPage> { return this.assistant.history(this.accountId, options); }

  send(input: SendInput): Promise<Sent> { return this.assistant.send(this.accountId, input); }

  async feedKey(): Promise<string | undefined> { return this.assistant.feedKey(this.accountId); }

  stop(): Promise<void> { return this.assistant.stop(this.accountId); }

  async retry(key: string, client: ClientAttributes) {
    try {
      const { run, outcome } = await this.assistant.retry(this.accountId, { id: key, client });
      return { runId: run.id, outcome };
    } catch (error) {
      throw error instanceof ChatError ? new ConversationError(error.status, error.code, error.message) : error;
    }
  }

  partial(): Promise<string> { return this.assistant.partial(this.accountId); }
}
