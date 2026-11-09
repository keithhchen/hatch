import { createHash } from "node:crypto";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import type { AgentCorpus, ResolvedAgentCorpus } from "../agentCorpus.js";
import type { Connection, Principal } from "../surfaces/contract.js";
import type { PrincipalLimits } from "./chatService.js";
import { ChatError, principalKey, type ContactPrincipal } from "./principal.js";
import { productRequiresLocalTools } from "./toolSurface.js";
import type { ConversationRef } from "./gateway.js";

/** Where Connections live. The channel layer owns the table; the Chat API only reads it. */
export interface ConnectionDirectory {
  get(connectionId: string): Promise<Connection | undefined>;
}

export type BoundContact = {
  conversation: ConversationRecord;
  corpus: ResolvedAgentCorpus;
  requiresLocalTools: boolean;
};

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

/**
 * Gives a contact the Product its Connection answers with. The binding depends
 * on the Connection and the Product's live release, never on an order or purchase,
 * and the contact's conversations are owned by (connection, contact) alone.
 */
export class ContactBinder {
  constructor(
    private readonly connections: ConnectionDirectory,
    private readonly products: { resolveByProduct(productId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus> },
    private readonly repository: Pick<ConversationRepository, "createConversation" | "getConversation">
  ) {}

  async bind(principal: ContactPrincipal, ref: ConversationRef, signal?: AbortSignal): Promise<BoundContact> {
    const connection = await this.connections.get(principal.connectionId);
    if (!connection || connection.state !== "active") throw new ChatError("connection_unavailable", "This channel connection is not active.", 409);
    // `org` members and `public` customers are both contacts; only the owner's `self` Connection acts as an account.
    if (connection.audience === "self" || connection.target.kind !== "product") {
      throw new ChatError("connection_not_shared", "This connection does not serve contacts.", 403);
    }
    const corpus = await this.products.resolveByProduct(connection.target.productId, signal);
    const owner = principalKey(principal);
    const binding = {
      ownerAccountId: owner,
      creatorId: corpus.corpus.creator.id,
      agentId: corpus.corpus.product.id,
      productId: corpus.corpus.product.id,
      corpusDigest: corpus.digest
    };
    const requiresLocalTools = productRequiresLocalTools(corpus.corpus as AgentCorpus);
    if (ref.kind === "conversation") {
      const existing = await this.repository.getConversation(ref.id);
      if (!existing || existing.ownerAccountId !== owner || existing.productId !== binding.productId) {
        throw new ChatError("conversation_not_found", "Conversation was not found.", 404);
      }
      return { conversation: existing, corpus, requiresLocalTools };
    }
    if (ref.connectionId !== principal.connectionId) throw new ChatError("conversation_not_found", "Conversation was not found.", 404);
    const key = `thread:${ref.connectionId}:${ref.threadId}:${principal.contactId}`;
    const created = await this.repository.createConversation({
      ...binding,
      id: `conversation:${shortHash([owner, binding.creatorId, binding.productId, ref.threadId].join("\u0000"))}:${shortHash(key)}`,
      publicId: `conv_${shortHash(key)}`,
      clientRequestId: key
    });
    return { conversation: created.conversation, corpus, requiresLocalTools };
  }
}

/** A contact may send a bounded number of messages to a Product: the repository counts them. */
export class SentMessageLimits implements PrincipalLimits {
  constructor(
    private readonly repository: Pick<ConversationRepository, "countSentMessages">,
    private readonly maxMessages: number
  ) {}

  async check(principal: Principal, conversation: ConversationRecord): Promise<void> {
    if (principal.kind !== "contact") return;
    if (await this.repository.countSentMessages(conversation) >= this.maxMessages) {
      throw new ChatError("contact_limit_reached", "This contact has reached the message limit.", 429);
    }
  }
}
