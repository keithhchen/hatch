import type { ConversationBinding, ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import type { ResolvedAgentCorpus } from "../agentCorpus.js";
import type { ConnectionDirectory } from "./contactBinding.js";
import type { ConversationRef } from "./gateway.js";
import { ChatError } from "./principal.js";
import { ThreadConversations } from "./threadConversations.js";

/**
 * Gives the account that linked a `self` Connection its own Product on IM. The binding is that account, authorized as it is
 * everywhere else: the Product must be its own. The conversation is the account's, one per thread at a time: `/new` starts another and keeps the old.
 */
export class SelfBinder {
  private readonly threads: ThreadConversations;
  constructor(
    private readonly connections: ConnectionDirectory,
    private readonly products: { resolveByProduct(productId: string, signal?: AbortSignal): Promise<ResolvedAgentCorpus> },
    private readonly repository: Pick<ConversationRepository, "createConversation" | "getConversation" | "threadConversation" | "adoptThread" | "moveThread" | "rebindConversation">
  ) { this.threads = new ThreadConversations(repository); }

  async conversationFor(accountId: string, ref: Extract<ConversationRef, { kind: "thread" }>, signal?: AbortSignal): Promise<ConversationRecord> {
    const { binding, key } = await this.resolve(accountId, ref, signal);
    return this.threads.current(key, binding);
  }

  /** Starts a fresh conversation in this thread; the old one stays as history. Repeating the same `startedBy` changes nothing. */
  async restart(accountId: string, ref: Extract<ConversationRef, { kind: "thread" }>, startedBy: string, signal?: AbortSignal): Promise<ConversationRecord> {
    const { binding, key } = await this.resolve(accountId, ref, signal);
    return this.threads.restart(key, binding, startedBy);
  }

  private async resolve(accountId: string, ref: Extract<ConversationRef, { kind: "thread" }>, signal?: AbortSignal) {
    const connection = await this.connections.get(ref.connectionId);
    if (!connection || connection.state !== "active") throw new ChatError("connection_unavailable", "This channel connection is not active.", 409);
    if (connection.audience !== "self" || connection.target.kind !== "product" || connection.ownerAccountId !== accountId) {
      throw new ChatError("connection_not_shared", "This connection does not serve this account.", 403);
    }
    const { corpus, digest } = await this.products.resolveByProduct(connection.target.productId, signal);
    if (corpus.creator.id !== accountId) throw new ChatError("entitlement_required", "This Product is not yours.", 403);
    const binding: ConversationBinding = { ownerAccountId: accountId, creatorId: corpus.creator.id, agentId: corpus.product.id, productId: corpus.product.id, corpusDigest: digest };
    return { binding, key: { connectionId: ref.connectionId, threadId: ref.threadId, principalId: accountId } };
  }
}
