import { randomUUID } from "node:crypto";
import type { ConversationBinding, ConversationRecord, ConversationRepository, ThreadKey } from "../conversationRepository.js";

type Repository = Pick<ConversationRepository, "createConversation" | "getConversation" | "threadConversation" | "adoptThread" | "moveThread">;

const requestId = (kind: string, { connectionId, threadId, principalId }: ThreadKey, ...rest: string[]) => [kind, connectionId, threadId, principalId, ...rest].join(":");

/**
 * The conversation a chat thread is in now. One pointer per (connection, thread, principal) says which; `/new` moves it and the
 * old conversation stays as history. Nothing about a conversation's id is derived from the thread.
 */
export class ThreadConversations {
  constructor(private readonly repository: Repository) {}

  /** Where the thread is, made on first use. A pointer to a conversation of another Product (the Connection was retargeted) is moved. */
  async current(key: ThreadKey, binding: ConversationBinding): Promise<ConversationRecord> {
    const id = await this.repository.threadConversation(key);
    const pointed = id ? await this.repository.getConversation(id) : undefined;
    if (pointed && pointed.creatorId === binding.creatorId && pointed.agentId === binding.agentId) return pointed;
    // A fixed request id per thread and Product, so concurrent first messages make one conversation.
    const { conversation } = await this.create(binding, requestId("start", key, binding.agentId));
    if (pointed) { await this.repository.moveThread(key, conversation.id); return conversation; }
    const winner = await this.repository.adoptThread(key, conversation.id);
    return winner === conversation.id ? conversation : (await this.repository.getConversation(winner)) ?? conversation;
  }

  /**
   * A fresh conversation for the thread. `startedBy` is the event that asked, and names the conversation: asked again, it is the same one.
   * The pointer moves to it when it is new. Asked again (a retry after a failure), it moves only if the pointer is still behind it:
   * an old event repeated never takes the thread back from a newer conversation.
   */
  async restart(key: ThreadKey, binding: ConversationBinding, startedBy: string): Promise<ConversationRecord> {
    const { conversation, created } = await this.create(binding, requestId("new", key, startedBy));
    if (!created) {
      const id = await this.repository.threadConversation(key);
      const pointed = id && id !== conversation.id ? await this.repository.getConversation(id) : undefined;
      if (id === conversation.id || (pointed && pointed.createdAt >= conversation.createdAt)) return conversation;
    }
    await this.repository.moveThread(key, conversation.id);
    return conversation;
  }

  private create(binding: ConversationBinding, clientRequestId: string) {
    return this.repository.createConversation({ ...binding, id: `conversation:${randomUUID()}`, publicId: `conv_${randomUUID().replaceAll("-", "")}`, clientRequestId });
  }
}
