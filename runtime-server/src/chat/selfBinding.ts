import { createHash } from "node:crypto";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import type { ResolvedAgentCorpus } from "../agentCorpus.js";
import type { ConnectionDirectory } from "./contactBinding.js";
import type { ConversationRef } from "./gateway.js";
import { ChatError } from "./principal.js";

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

/**
 * Gives the account that linked a `self` Connection its own Product on IM. The binding is that account, authorized as it is
 * everywhere else: the Product must be its own. The conversation is the account's, one per thread.
 */
export class SelfBinder {
  constructor(
    private readonly connections: ConnectionDirectory,
    private readonly products: { resolveByProduct(productId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus> },
    private readonly repository: Pick<ConversationRepository, "createConversation">
  ) {}

  async conversationFor(accountId: string, ref: Extract<ConversationRef, { kind: "thread" }>, signal?: AbortSignal): Promise<ConversationRecord> {
    const connection = await this.connections.get(ref.connectionId);
    if (!connection || connection.state !== "active") throw new ChatError("connection_unavailable", "This channel connection is not active.", 409);
    if (connection.audience !== "self" || connection.target.kind !== "product" || connection.ownerAccountId !== accountId) {
      throw new ChatError("connection_not_shared", "This connection does not serve this account.", 403);
    }
    const { corpus, digest } = await this.products.resolveByProduct(connection.target.productId, signal);
    if (corpus.creator.id !== accountId) throw new ChatError("entitlement_required", "This Product is not yours.", 403);
    const key = `thread:${ref.connectionId}:${ref.threadId}`;
    const created = await this.repository.createConversation({
      ownerAccountId: accountId, creatorId: corpus.creator.id, agentId: corpus.product.id, productId: corpus.product.id, corpusDigest: digest,
      id: `conversation:${shortHash([accountId, corpus.product.id, ref.threadId].join("\u0000"))}:${shortHash(key)}`,
      publicId: `conv_${shortHash(key)}`,
      clientRequestId: key
    });
    return created.conversation;
  }
}
