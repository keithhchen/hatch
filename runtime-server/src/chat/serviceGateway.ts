import { randomUUID } from "node:crypto";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import { clientMessageInputDigest, type ConversationMessage } from "../protocol.js";
import type { VisibleConversationMessage } from "../store.js";
import type { ClientAttributes, ContentPart, Principal } from "../surfaces/contract.js";
import type { ChatService } from "./chatService.js";
import type { ChatGateway, ConversationRef, FinalReply, SentMessage } from "./gateway.js";
import { ChatError } from "./principal.js";
import { finalAssistantText, waitForTerminalRun } from "./runResult.js";

export type BoundPrincipal<Scope> = {
  conversation: ConversationRecord;
  scope: Scope;
  corpusDigest: string;
  requiresLocalTools: boolean;
};

/** Turns a principal and a conversation reference into something a Run can execute. One per principal kind. */
export interface PrincipalBinder<Scope> {
  bind(principal: Principal, ref: ConversationRef): Promise<BoundPrincipal<Scope>>;
}

/** Turns message parts into the canonical user message and the digest that makes a retry safe. */
export interface PartsReader {
  read(parts: ContentPart[], conversation: ConversationRecord): Promise<{ message: ConversationMessage; digest: string }>;
}

/** Text only. Attachments need the asset service, which is not wired here: refuse rather than drop them. */
export class TextPartsReader implements PartsReader {
  async read(parts: ContentPart[]): Promise<{ message: ConversationMessage; digest: string }> {
    const unsupported = parts.find((part) => part.type !== "text");
    if (unsupported) throw new ChatError("parts_unsupported", `Message parts of type ${unsupported.type} are not available yet.`, 400);
    const content = parts.map((part) => (part as { text: string }).text).join("\n");
    return { message: { role: "user", content }, digest: clientMessageInputDigest({ content }) };
  }
}

export class ServiceChatGateway<Scope> implements ChatGateway {
  constructor(private readonly deps: {
    chat: ChatService<Scope>;
    binders: Record<Principal["kind"], PrincipalBinder<Scope>>;
    parts: PartsReader;
    repository: Pick<ConversationRepository, "getRun">;
    history: { readVisibleConversation(conversationId: string): Promise<VisibleConversationMessage[]> };
  }) {}

  async send(principal: Principal, ref: ConversationRef, client: ClientAttributes, messageId: string, parts: ContentPart[]): Promise<SentMessage> {
    const bound = await this.deps.binders[principal.kind].bind(principal, ref);
    const { message, digest } = await this.deps.parts.read(parts, bound.conversation);
    const submission = await this.deps.chat.submit({
      principal, client, message: async () => message, digest, ...bound,
      clientMessageId: messageId,
      runId: `run_${randomUUID().replaceAll("-", "")}`
    });
    return { outcome: submission.outcome, conversationId: bound.conversation.id, runId: submission.run.id, messageId };
  }

  async finalReply(sent: SentMessage, options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<FinalReply> {
    const run = await waitForTerminalRun(() => this.deps.repository.getRun(sent.conversationId, sent.runId), Number.POSITIVE_INFINITY, options.pollMs ?? 250, options.signal);
    if (!run) throw new ChatError("run_not_found", `Run ${sent.runId} was not found.`, 404);
    const text = run.status === "completed" ? finalAssistantText(await this.deps.history.readVisibleConversation(sent.conversationId), run.id) : "";
    return { runId: run.id, status: run.status as FinalReply["status"], text, ...(run.interruptedReason ? { reason: run.interruptedReason } : {}) };
  }
}
