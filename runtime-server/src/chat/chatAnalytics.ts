import { anonymous, firstMessageSent, messageSent, replyFailed, type ChatChannel } from "../analytics/events.js";
import type { AnalyticsEvent, ProductAnalytics } from "../analytics/port.js";
import { safely } from "../analytics/safe.js";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import type { ClientAttributes, Principal } from "../surfaces/contract.js";

/** Where a buyer's message came from: a contact or an IM client is IM, the Responses API (client `mcp`) is the API, everything else is the web. */
export const channelOf = (client: ClientAttributes | undefined, principal: Pick<Principal, "kind">): ChatChannel =>
  principal.kind === "contact" || client?.client === "im" || client?.client === "dm" ? "im" : client?.client === "mcp" ? "api" : "web";

/**
 * What a Product's buyer chat tells analytics: each message, the first of a conversation, and a reply that failed.
 * The distinct id is the buyer's account; a contact, who has none, is its owner id with no person profile.
 */
export class ChatAnalytics {
  private readonly analytics: ProductAnalytics;

  constructor(analytics: ProductAnalytics | undefined, private readonly repository: Pick<ConversationRepository, "countUserMessages" | "getConversation">) {
    this.analytics = safely(analytics);
  }

  /**
   * A message the conversation accepted. Send-and-forget: it returns at once and counts in the background, so the
   * message's request never waits on analytics. `n` is the message's index: the count, which now includes it, less one.
   */
  messageAccepted(input: { conversation: ConversationRecord; principal: Principal; client: ClientAttributes }): void {
    void this.repository.countUserMessages(input.conversation.id).then(count => this.accepted(input, count - 1), () => undefined);
  }

  private accepted(input: { conversation: ConversationRecord; principal: Principal; client: ClientAttributes }, n: number): void {
    const { conversation, principal, client } = input;
    if (n < 0) return;
    const channel = channelOf(client, principal);
    const agentId = conversation.productId;
    if (n === 0) this.send(conversation, principal, firstMessageSent(agentId, channel));
    this.send(conversation, principal, messageSent(agentId, channel, n));
  }

  /** A Run that ended in failure: `client` is the latest this process was told of for the conversation. */
  async runFailed(run: ConversationRunRecord, reason: string, client: ClientAttributes | undefined): Promise<void> {
    const conversation = await this.repository.getConversation(run.conversationId).catch(() => undefined);
    if (!conversation) return;
    const principal = { kind: conversation.ownerAccountId.startsWith("contact:") ? "contact" : "account" } as const;
    this.send(conversation, principal, replyFailed(conversation.productId, channelOf(client, principal), reason));
  }

  private send(conversation: ConversationRecord, principal: Pick<Principal, "kind">, event: AnalyticsEvent): void {
    this.analytics.capture(conversation.ownerAccountId, principal.kind === "contact" ? anonymous(event) : event);
  }
}
