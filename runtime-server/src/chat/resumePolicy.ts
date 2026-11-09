import type { ConversationRunRecord } from "../conversationRepository.js";
import type { ConversationMessage } from "../protocol.js";
import type { ResumeDecision, ResumePolicy } from "./runSupervisor.js";
import type { ToolRecovery } from "./toolRecovery.js";

/**
 * A Run whose executor disappeared continues from its transcript. Only one that may have repeated a
 * side effect is interrupted; the ToolRecovery policy decides, and the executor carries out the rest.
 */
export class TranscriptResumePolicy implements ResumePolicy {
  constructor(
    private readonly history: { readConversation(conversationId: string): Promise<ConversationMessage[]> },
    private readonly recovery: Pick<ToolRecovery, "plan">
  ) {}

  async decide(run: ConversationRunRecord): Promise<ResumeDecision> {
    const plan = await this.recovery.plan(run, await this.history.readConversation(run.conversationId));
    return plan.kind === "interrupt" ? { interrupt: plan.reason } : "restart";
  }
}
