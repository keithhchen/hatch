import { randomUUID } from "node:crypto";
import { log } from "../observability/log.js";
import type { ArtifactLifecycle } from "./lifecycle.js";
import type { ReportRecord, ReportRepository } from "./ports.js";

/** An attempt claimed but never started is claimed again after this. */
export const CLAIM_LEASE_MS = 10 * 60_000;

/**
 * Nobody types again in a report conversation, so a Run that failed, was interrupted by a restart, or finished without a report is
 * started again: this polls the report rows (durable, so it survives restarts and works on any instance) for attempts that are due,
 * claims each by compare-and-set, and starts a fresh Run of the same conversation.
 */
export class ArtifactRetrier {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: {
    reports: ReportRepository;
    lifecycle: ArtifactLifecycle;
    /** Starts a new Run of the conversation under this Run id. */
    start(record: ReportRecord, runId: string): Promise<void>;
    clock?: () => Date;
    pollMs?: number;
  }) {}

  async tick(): Promise<number> {
    const { reports, lifecycle, start, clock = () => new Date() } = this.deps;
    let started = 0;
    for (const due of await reports.due(clock())) {
      const runId = `run_${randomUUID().replaceAll("-", "")}`;
      const claimed = await reports.claim(due.conversationId, due.attempt, runId, clock(), CLAIM_LEASE_MS);
      if (!claimed) continue; // another instance took it
      try { await start(claimed, runId); started++; }
      catch (error) { log.error("artifact_retry_not_started", { conversationId: claimed.conversationId, attempt: claimed.attempt, error }); await lifecycle.attemptNotStarted(runId, error); }
    }
    return started;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick().catch((error) => log.error("artifact_retry_tick_failed", { error })), this.deps.pollMs ?? 15_000);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }
}
