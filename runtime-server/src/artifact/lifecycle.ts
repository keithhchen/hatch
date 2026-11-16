import type { ProductAnalytics } from "../analytics/port.js";
import { reportFailed } from "../analytics/events.js";
import type { ConversationRecord, ConversationRunRecord, RunEnding } from "../conversationRepository.js";
import { log } from "../observability/log.js";
import type { ReportRepository } from "./ports.js";

/**
 * Where a report's status follows its conversation: the first accepted message makes it 'generating'; a Run that ends with no
 * report published schedules the next attempt, and after the last one fails the report. Chat conversations have no report
 * row, so nothing here touches them. Every write is keyed by the Run, so a late end of an older attempt changes nothing.
 */
export class ArtifactLifecycle {
  constructor(private readonly reports: ReportRepository, private readonly analytics?: ProductAnalytics, private readonly clock: () => Date = () => new Date()) {}

  async runAccepted(conversation: Pick<ConversationRecord, "id">, run: Pick<ConversationRunRecord, "id">): Promise<void> {
    try { await this.reports.begin(conversation.id, run.id, this.clock()); }
    catch (error) { log.error("artifact_report_begin_failed", { conversationId: conversation.id, error }); }
  }

  async runEnded(run: Pick<ConversationRunRecord, "id">, ending: RunEnding): Promise<void> {
    try {
      const reason = ("failure" in ending ? ending.failure.message : "The agent finished without publishing a report.").slice(0, 500);
      const record = await this.reports.runEnded(run.id, reason, this.clock());
      if (record?.status === "failed") this.analytics?.capture(record.ownerAccountId, reportFailed("failure" in ending ? ending.failure.code : "no_report"));
    } catch (error) { log.error("artifact_report_end_failed", { runId: run.id, error }); }
  }

  /** An attempt that could not even start ends like one that ran and failed. */
  attemptNotStarted(runId: string, error: unknown): Promise<void> {
    return this.runEnded({ id: runId }, { status: "failed", failure: { code: "retry_not_started", message: error instanceof Error ? error.message : String(error) } } as RunEnding);
  }
}
