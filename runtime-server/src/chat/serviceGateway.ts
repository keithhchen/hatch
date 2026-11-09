import { randomUUID } from "node:crypto";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import type { VisibleConversationMessage } from "../store.js";
import type { ClientAttributes, ContentPart, Principal } from "../surfaces/contract.js";
import type { PartsReader } from "./assets.js";
import type { ChatService } from "./chatService.js";
import type { ChatGateway, ConversationRef, RunProgress, SentMessage } from "./gateway.js";
import { ChatError } from "./principal.js";
import { finalAssistantText, TERMINAL_STATUSES } from "./runResult.js";

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

/** Stores a file the way the conversation's scope requires. Chat has one; a Runtime without an asset service has none. */
export interface Uploads {
  upload(conversation: ConversationRecord, input: { name: string; bytes: Buffer }): Promise<{ asset_id: string }>;
}

export class ServiceChatGateway<Scope> implements ChatGateway {
  constructor(private readonly deps: {
    chat: ChatService<Scope>;
    binders: Record<Principal["kind"], PrincipalBinder<Scope>>;
    parts: PartsReader;
    uploads?: Uploads;
    repository: Pick<ConversationRepository, "findRun" | "latestRunStateCursor">;
    history: { readVisibleConversation(conversationId: string): Promise<VisibleConversationMessage[]> };
  }) {}

  async send(principal: Principal, ref: ConversationRef, client: ClientAttributes, messageId: string, parts: ContentPart[]): Promise<SentMessage> {
    const bound = await this.deps.binders[principal.kind].bind(principal, ref);
    const { message, digest, bind } = await this.deps.parts.prepare(parts, bound.conversation, messageId);
    const submission = await this.deps.chat.submit({
      principal, client, message, digest, ...(bind ? { bind } : {}), ...bound,
      clientMessageId: messageId,
      runId: `run_${randomUUID().replaceAll("-", "")}`
    });
    return { outcome: submission.outcome, conversationId: bound.conversation.id, runId: submission.run.id, messageId };
  }

  async upload(principal: Principal, ref: ConversationRef, input: { name: string; bytes: Buffer }): Promise<{ assetId: string }> {
    if (!this.deps.uploads) throw new ChatError("attachments_unavailable", "This Runtime cannot take attachments.", 501);
    const { conversation } = await this.deps.binders[principal.kind].bind(principal, ref);
    return { assetId: (await this.deps.uploads.upload(conversation, input)).asset_id };
  }

  async progress(runId: string): Promise<RunProgress | undefined> {
    const run = await this.deps.repository.findRun(runId);
    if (!run) return undefined;
    if (!TERMINAL_STATUSES.has(run.status)) {
      // The cursor of the Run's latest state change names this compaction: the next one has another.
      return run.status === "compacting" ? { ended: false, compactionId: `${run.id}:${await this.deps.repository.latestRunStateCursor(run.id)}` } : { ended: false };
    }
    const text = run.status === "completed" ? finalAssistantText(await this.deps.history.readVisibleConversation(run.conversationId), run.id) : "";
    return { ended: true, reply: { runId: run.id, status: run.status as "completed", text, ...(run.interruptedReason ? { reason: run.interruptedReason } : {}) } };
  }
}
