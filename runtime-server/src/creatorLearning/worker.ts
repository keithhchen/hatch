import type { CreatorFactory } from "./engine.js";
import type { CreatorFactoryRepository, FactoryRunRecord } from "./repository.js";
import type { FactoryExecutionControl, FactoryRunState } from "./types.js";
import { requireQuestionBatchId } from "./questionBatch.js";

export type CreatorFactoryWorkerOptions = {
  workerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
  retryBaseMs?: number;
};

export class CreatorFactoryWorker {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly retryBaseMs: number;

  constructor(
    private readonly repository: CreatorFactoryRepository,
    private readonly factory: CreatorFactory,
    private readonly options: CreatorFactoryWorkerOptions
  ) {
    if (!options.workerId.trim()) throw new Error("Creator Factory workerId is required");
    this.leaseMs = options.leaseMs ?? 10 * 60_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(5_000, Math.floor(this.leaseMs / 3));
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
  }

  async workOnce(stopSignal?: AbortSignal): Promise<FactoryRunRecord | undefined> {
    const claimed = await this.repository.claim({ workerId: this.options.workerId, leaseMs: this.leaseMs });
    if (!claimed) return undefined;
    return this.executeClaimed(claimed, stopSignal);
  }

  /**
   * Start one newly-created run immediately. The durable repository row is
   * still the recovery boundary, but a user command no longer waits for the
   * polling worker to notice it. Claiming is targeted so an older queued run
   * cannot steal the direct-start slot.
   */
  async startRun(runId: string, stopSignal?: AbortSignal): Promise<FactoryRunRecord | undefined> {
    const claimed = await this.repository.claim({
      workerId: this.options.workerId,
      leaseMs: this.leaseMs,
      runId
    });
    if (!claimed) return undefined;
    void this.executeClaimed(claimed, stopSignal).catch(() => {
      // executeClaimed persists the failure state. Keep this fire-and-forget
      // boundary from becoming an unhandled rejection in the HTTP process.
    });
    return claimed;
  }

  private async executeClaimed(claimed: FactoryRunRecord, stopSignal?: AbortSignal): Promise<FactoryRunRecord> {
    if (!claimed.leaseToken) throw new Error(`Claimed Factory run ${claimed.id} has no lease token`);

    let heartbeatError: unknown;
    const execution = new AbortController();
    const abortForStop = (): void => execution.abort(stopSignal?.reason ?? new Error("Creator Factory worker is stopping"));
    if (stopSignal?.aborted) abortForStop();
    else stopSignal?.addEventListener("abort", abortForStop, { once: true });
    const loseLease = (error: unknown): void => {
      heartbeatError = error;
      execution.abort(error instanceof Error ? error : new Error(String(error)));
    };
    const heartbeat = this.heartbeatMs > 0 ? setInterval(() => {
      void this.repository.heartbeat({
        runId: claimed.id,
        workerId: this.options.workerId,
        leaseToken: claimed.leaseToken!,
        leaseMs: this.leaseMs
      }).catch(loseLease);
    }, this.heartbeatMs) : undefined;
    heartbeat?.unref();

    const control: FactoryExecutionControl = {
      signal: execution.signal,
      beforeCommit: async () => {
        try {
          await this.repository.assertLease({
            runId: claimed.id,
            workerId: this.options.workerId,
            leaseToken: claimed.leaseToken!
          });
        } catch (error) {
          loseLease(error);
          throw error;
        }
      }
    };

    try {
      const state = await this.advance(claimed, control);
      if (heartbeatError) throw heartbeatError;
      if (execution.signal.aborted) throw execution.signal.reason ?? new Error("Creator Factory execution was aborted");
      if (heartbeat) clearInterval(heartbeat);
      return await this.repository.complete({
        runId: claimed.id,
        workerId: this.options.workerId,
        leaseToken: claimed.leaseToken,
        state
      });
    } catch (error) {
      if (heartbeat) clearInterval(heartbeat);
      const message = error instanceof Error ? error.message : String(error);
      // A process shutdown is an expected hand-off to the durable recovery
      // consumer, not a provider failure. Requeue it immediately so a deploy
      // or graceful restart does not turn a direct run into a multi-minute
      // user-visible queue delay. Real provider/lease failures retain the
      // bounded exponential backoff.
      const delay = stopSignal?.aborted
        ? 0
        : Math.min(5 * 60_000, this.retryBaseMs * (2 ** Math.min(claimed.attempts - 1, 6)));
      try {
        return await this.repository.fail({
          runId: claimed.id,
          workerId: this.options.workerId,
          leaseToken: claimed.leaseToken,
          error: message,
          retryDelayMs: delay
        });
      } catch {
        throw error;
      }
    } finally {
      stopSignal?.removeEventListener("abort", abortForStop);
    }
  }

  async runUntilStopped(options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const pollMs = options.pollMs ?? 1_000;
    while (!options.signal?.aborted) {
      const result = await this.workOnce(options.signal);
      if (!result) await abortableDelay(pollMs, options.signal);
    }
  }

  private async advance(record: FactoryRunRecord, control: FactoryExecutionControl): Promise<FactoryRunState> {
    const local = await this.loadLocalState(record.id);
    if (!local) {
      if (record.state) {
        return {
          ...record.state,
          stage: "needs_attention",
          retryStage: undefined,
          lastError: "Factory artifact directory is missing; refusing to regenerate a previously started run"
        };
      }
      return this.factory.start(record.input, control);
    }

    if (record.pendingAnswers && local.stage === "awaiting_creator_answers") {
      const submittedBatchId = record.pendingAnswers.questionBatchId?.trim();
      if (!submittedBatchId) {
        throw new Error(`Factory run ${record.id} has pending Creator answers without a run-scoped Question batch ID`);
      }
      let recordedBatchId: string;
      try {
        recordedBatchId = requireQuestionBatchId(record.id, record.state?.artifacts.currentQuestionBatch);
      } catch {
        throw new Error(`Factory run ${record.id} has pending Creator answers for a stale or unknown Question batch`);
      }
      if (submittedBatchId !== recordedBatchId) {
        throw new Error(`Factory run ${record.id} has pending Creator answers for a stale or unknown Question batch`);
      }
      let currentBatchId: string;
      try {
        currentBatchId = requireQuestionBatchId(record.id, local.artifacts.currentQuestionBatch);
      } catch {
        throw new Error(`Factory run ${record.id} local state has no pending Question batch`);
      }
      if (submittedBatchId !== currentBatchId) {
        // The file graph already consumed this submission and advanced to a
        // fresh question batch before the prior DB completion failed. Sync the
        // newer checkpoint instead of replaying old answers into new Questions.
        return local;
      }
      const answers = record.pendingAnswers.answers ?? record.pendingAnswers.answerMarkdown;
      if (!answers) throw new Error(`Factory run ${record.id} has no usable pending Creator answers`);
      return this.factory.submitCreatorAnswers(record.id, answers, submittedBatchId, control);
    }
    if (local.stage === "needs_attention" && local.retryStage) {
      return this.factory.retry(record.id, control);
    }
    if (local.stage === "awaiting_creator_answers" || local.stage === "review_required" || local.stage === "ready" || local.stage === "needs_attention") {
      return local;
    }
    return this.factory.resume(record.id, control);
  }

  private async loadLocalState(runId: string): Promise<FactoryRunState | undefined> {
    try {
      return await this.factory.status(runId);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    const abort = (): void => {
      clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
