import type { ConversationRunRecord } from "../conversationRepository.js";
import type { VisibleConversationMessage } from "../store.js";
import { isReadOnlyTool } from "../tools.js";
import type { ResumeDecision, ResumePolicy } from "./runSupervisor.js";

export type ToolCallRecord = { name: string; locality?: "server" | "client" };

/** What a Run has already called. */
export interface RunToolLog {
  callsOf(run: ConversationRunRecord): Promise<ToolCallRecord[]>;
}

/** Reads the calls from the conversation's own history. */
export class HistoryToolLog implements RunToolLog {
  constructor(private readonly history: { readVisibleConversation(conversationId: string): Promise<VisibleConversationMessage[]> }) {}

  async callsOf(run: ConversationRunRecord): Promise<ToolCallRecord[]> {
    return (await this.history.readVisibleConversation(run.conversationId))
      .flatMap((message) => message.tool_calls ?? [])
      .filter((call) => call.run_id === run.id)
      .map((call) => ({ name: call.name, ...(call.locality ? { locality: call.locality } : {}) }));
  }
}

/**
 * A Run that only read can restart from its last user message. One that may have
 * changed something is interrupted: running it again would repeat the effect.
 */
export class ReadOnlyRestartPolicy implements ResumePolicy {
  constructor(private readonly log: RunToolLog, private readonly isReadOnly: (tool: string) => boolean = isReadOnlyTool) {}

  async decide(run: ConversationRunRecord): Promise<ResumeDecision> {
    if (run.status === "waiting_for_tool") return { interrupt: "The Runtime restarted while waiting for a local tool. Send the message again." };
    const risky = (await this.log.callsOf(run)).find((call) => call.locality === "client" || !this.isReadOnly(call.name));
    return risky ? { interrupt: `The Runtime restarted after ${risky.name}, which may have had an effect. Send the message again to continue.` } : "restart";
  }
}
