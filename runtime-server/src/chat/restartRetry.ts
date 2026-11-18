import { randomUUID } from "node:crypto";
import type { ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import { log } from "../observability/log.js";

/** The key of the answer-again Run that follows an interrupted one: derived from it, so a second attempt is the same Run. */
export const RESTART_RETRY_PREFIX = "restart-retry:";
export const restartRetryKey = (interruptedRunId: string): string => `${RESTART_RETRY_PREFIX}${interruptedRunId}`;
/** A reply interrupted by a restart is started again at most this many times in a row; after that its partial reply stays quietly. */
export const MAX_RESTART_RETRIES = 2;

/**
 * A restart interrupts the Runs it was executing. The buyer is not told: the reply is started again from their latest
 * message, as an answer-again Run. Only the latest Run is answered again (a newer message or Run means nobody is waiting
 * for this one), and the retry's own key makes a second attempt, from any instance, a replay.
 */
export class RestartRetrier {
  constructor(private readonly deps: {
    repository: Pick<ConversationRepository, "listRuns" | "restartInterruptedRuns">;
    /** Conversations with their own retrier (report mode) are left to it. */
    skip?(conversationId: string): Promise<boolean>;
    /** Starts the answer-again Run: the same path as the buyer's own "answer again". */
    start(run: ConversationRunRecord, key: string, runId: string): Promise<unknown>;
    /** Interruptions older than this are left alone. */
    windowMs?: number;
    pollMs?: number;
    clock?: () => Date;
  }) {}

  private timer: NodeJS.Timeout | undefined;

  /**
   * The durable side: the Runs a restart interrupted and nobody answered, read from the database. A process that died between
   * ending a Run and starting its retry is made up for here, by any instance; a retry that already exists makes this a no-op.
   */
  async tick(): Promise<void> {
    const { repository, clock = () => new Date(), windowMs = 10 * 60_000 } = this.deps;
    let runs: ConversationRunRecord[];
    try { runs = await repository.restartInterruptedRuns(new Date(clock().getTime() - windowMs)); }
    catch (error) { log.error("restart_retry_scan_failed", { error }); return; }
    for (const run of runs) await this.afterInterrupted(run);
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.deps.pollMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  async afterInterrupted(run: ConversationRunRecord): Promise<void> {
    try {
      if (await this.deps.skip?.(run.conversationId)) return;
      const runs = (await this.deps.repository.listRuns(run.conversationId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      if (runs.at(-1)?.id !== run.id) return;
      let retries = 0;
      for (let i = runs.length - 1; i >= 0 && runs[i]!.clientMessageId.startsWith(RESTART_RETRY_PREFIX); i--) retries++;
      if (retries >= MAX_RESTART_RETRIES) return;
      await this.deps.start(run, restartRetryKey(run.id), `run_${randomUUID().replaceAll("-", "")}`);
    } catch (error) {
      // Busy or not retryable means somebody else got there first or the buyer moved on: nothing to do.
      const code = (error as { code?: string }).code;
      if (code === "conversation_busy" || code === "run_not_retryable") return;
      log.error("restart_retry_not_started", { run_id: run.id, conversation_id: run.conversationId, error });
    }
  }
}
