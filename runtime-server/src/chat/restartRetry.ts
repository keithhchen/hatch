import { randomUUID } from "node:crypto";
import type { ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import { log } from "../observability/log.js";

/** The key of the answer-again Run that follows an interrupted one: derived from it, so a second attempt is the same Run. */
export const RESTART_RETRY_PREFIX = "restart-retry:";
export const restartRetryKey = (interruptedRunId: string): string => `${RESTART_RETRY_PREFIX}${interruptedRunId}`;
/** A reply interrupted by a restart is started again at most this many times in a row; after that its partial reply stays quietly. */
export const MAX_RESTART_RETRIES = 2;

/** How long the buyer's snapshot keeps reporting an interrupted reply as being started again, when its retry has not appeared. */
export const RETRY_PENDING_MS = 2 * 60_000;

/**
 * Whether `run`, the interrupted Run, is still owed an automatic retry: it is the conversation's latest Run, was cut off by a
 * restart, and fewer than MAX_RESTART_RETRIES retries have been started in a row. `runs` is every Run of the conversation.
 */
export function owesRestartRetry(runs: ConversationRunRecord[], run: ConversationRunRecord): boolean {
  if (run.status !== "interrupted" || run.failure?.code !== "run_interrupted") return false;
  const ordered = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (ordered.at(-1)?.id !== run.id) return false;
  let retries = 0;
  for (let i = ordered.length - 1; i >= 0 && ordered[i]!.clientMessageId.startsWith(RESTART_RETRY_PREFIX); i--) retries++;
  return retries < MAX_RESTART_RETRIES;
}

/** The snapshot's word for a Run a restart interrupted whose retry has not started yet: the reply is still being worked on. */
export function retryPending(runs: ConversationRunRecord[], run: ConversationRunRecord, now: Date = new Date()): boolean {
  return owesRestartRetry(runs, run) && now.getTime() - new Date(run.completedAt ?? 0).getTime() < RETRY_PENDING_MS;
}

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
      const runs = await this.deps.repository.listRuns(run.conversationId);
      if (!owesRestartRetry(runs, run)) return;
      await this.deps.start(run, restartRetryKey(run.id), `run_${randomUUID().replaceAll("-", "")}`);
    } catch (error) {
      // Busy or not retryable means somebody else got there first or the buyer moved on: nothing to do.
      const code = (error as { code?: string }).code;
      if (code === "conversation_busy" || code === "run_not_retryable") return;
      log.error("restart_retry_not_started", { run_id: run.id, conversation_id: run.conversationId, error });
    }
  }
}
