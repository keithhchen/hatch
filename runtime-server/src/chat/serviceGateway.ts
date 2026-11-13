import { randomUUID } from "node:crypto";
import type { ConversationRecord, ConversationRepository } from "../conversationRepository.js";
import type { VisibleConversationMessage } from "../store.js";
import type { ClientAttributes, ContentPart, Principal } from "../surfaces/contract.js";
import type { PartsReader } from "./assets.js";
import type { ChatService } from "./chatService.js";
import type { ChatGateway, ConversationRef, RunProgress, SentMessage, UploadedRef } from "./gateway.js";
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
  /** A fresh conversation in the thread; the old one stays. Absent where a principal has one conversation only. */
  restart?(principal: Principal, ref: Extract<ConversationRef, { kind: "thread" }>, key: string): Promise<ConversationRecord>;
}

/** Stores a file the way the conversation's scope requires. Chat has one; a Runtime without an asset service has none. */
export interface Uploads {
  upload(conversation: ConversationRecord, input: { name: string; bytes: Buffer }): Promise<{ asset_id: string; kind: UploadedRef["kind"] }>;
}

export class ServiceChatGateway<Scope> implements ChatGateway {
  constructor(private readonly deps: {
    chat: ChatService<Scope>;
    binders: Record<Principal["kind"], PrincipalBinder<Scope>>;
    parts: PartsReader;
    uploads?: Uploads;
    repository: Pick<ConversationRepository, "findRun" | "latestRunStateCursor" | "snapshot">;
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
    return { outcome: submission.outcome, conversationId: bound.conversation.id, runId: submission.run.id, messageId, acceptedAt: submission.acceptedAt };
  }

  async restart(principal: Principal, ref: Extract<ConversationRef, { kind: "thread" }>, key: string): Promise<{ conversationId: string }> {
    const binder = this.deps.binders[principal.kind];
    if (!binder.restart) throw new ChatError("restart_unavailable", "This conversation cannot be restarted.", 409);
    return { conversationId: (await binder.restart(principal, ref, key)).id };
  }

  async upload(principal: Principal, ref: ConversationRef, input: { name: string; bytes: Buffer }): Promise<UploadedRef> {
    if (!this.deps.uploads) throw new ChatError("attachments_unavailable", "This Runtime cannot take attachments.", 501);
    const { conversation } = await this.deps.binders[principal.kind].bind(principal, ref);
    const { asset_id: assetId, kind } = await this.deps.uploads.upload(conversation, input);
    return { assetId, kind };
  }

  async progress(runId: string): Promise<RunProgress | undefined> {
    const run = await this.deps.repository.findRun(runId);
    if (!run) return undefined;
    if (!TERMINAL_STATUSES.has(run.status)) {
      if (run.status !== "compacting") return { ended: false };
      // The durable id Chat announced after the Run entered `compacting`; absent until that journal event lands, and the next ask finds it.
      const after = await this.deps.repository.latestRunStateCursor(run.id) ?? 0;
      const started = (await this.deps.repository.snapshot(run.conversationId, after)).events.find(event => event.type === "compaction.started" && event.runId === run.id);
      const compactionId = started?.payload.compaction_id;
      return typeof compactionId === "string" ? { ended: false, compactionId } : { ended: false };
    }
    const text = run.status === "completed" ? finalAssistantText(await this.deps.history.readVisibleConversation(run.conversationId), run.id) : "";
    return { ended: true, reply: { runId: run.id, status: run.status as "completed", text, ...(run.failure ? { reason: run.failure.message } : {}) } };
  }
}
