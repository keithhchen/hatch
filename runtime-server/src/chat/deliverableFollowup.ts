import type { ProductCapabilities } from "../agentBox/capabilities.js";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import { log } from "../observability/log.js";
import type { Prompts } from "../prompts.js";

/** A Product that must end with an HTML report page: a Run that ends without one is followed by a request to finish it. */
export const DELIVERABLE_HTML_CAPABILITY = "deliverable_html";
/** The key of the follow-up to a Run: derived from it, so a second attempt (a restart, another instance) is the same message. */
export const DELIVERABLE_FOLLOWUP_PREFIX = "deliverable-followup:";
export const deliverableFollowupKey = (runId: string): string => `${DELIVERABLE_FOLLOWUP_PREFIX}${runId}`;
/** Follow-ups in a row, with nobody else writing in between; after that the conversation is left alone and logged. */
export const MAX_DELIVERABLE_FOLLOWUPS = 2;

export type DeliverableFollowupDeps = {
  capabilities: ProductCapabilities;
  repository: Pick<ConversationRepository, "getConversation" | "listRuns">;
  /** Whether the conversation's buyer published a page since the conversation began. */
  hasPage(conversation: ConversationRecord): Promise<boolean>;
  prompts: Prompts;
  /** Posts the follow-up as a user message and starts its Run, under `key`. */
  start(conversation: ConversationRecord, key: string, content: string): Promise<unknown>;
};

export class DeliverableFollowups {
  constructor(private readonly deps: DeliverableFollowupDeps) {}

  /** Never throws: it runs after a reply and must not disturb it. */
  async afterReply(run: ConversationRunRecord): Promise<void> {
    const { capabilities, repository, hasPage, prompts, start } = this.deps;
    try {
      const conversation = await repository.getConversation(run.conversationId);
      if (!conversation || !await capabilities.has(conversation.productId, DELIVERABLE_HTML_CAPABILITY) || await hasPage(conversation)) return;
      const ordered = (await repository.listRuns(run.conversationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (ordered.at(-1)?.id !== run.id) return; // someone wrote since: nobody is waiting for this Run
      let followups = 0;
      for (let i = ordered.length - 1; i >= 0 && ordered[i]!.clientMessageId.startsWith(DELIVERABLE_FOLLOWUP_PREFIX); i--) followups++;
      if (followups >= MAX_DELIVERABLE_FOLLOWUPS) return log.error("deliverable_followup_cap", { run_id: run.id, conversation_id: run.conversationId });
      await start(conversation, deliverableFollowupKey(run.id), await prompts.get("deliverable-followup"));
    } catch (error) {
      // Busy means a message is already being answered: that Run's end will come back here.
      if ((error as { code?: string }).code === "conversation_busy") return;
      log.error("deliverable_followup_failed", { run_id: run.id, conversation_id: run.conversationId, error });
    }
  }
}
