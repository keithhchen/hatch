import type { AccessCodes, DueCode } from "../accessCodes/accessCodes.js";
import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import { log } from "../observability/log.js";
import { codeIntakeKey } from "./codePages.js";

/** Actions taken per code conversation, in all: the first start, the retries and the follow-ups together. */
export const MAX_CODE_ATTEMPTS = 6;
/** The wait after attempt 0, 1, 2, ...; the last one repeats. */
export const BACKOFF_MS = [10_000, 30_000, 60_000, 120_000];
const ACTIVE = new Set(["queued", "running", "waiting_for_tool", "compacting"]);

export const codeRetryKey = (code: string, attempt: number) => `code-retry:${code}:${attempt}`;
export const codeFollowupKey = (code: string, attempt: number) => `code-followup:${code}:${attempt}`;

export type ReconcilerDeps = {
  codes: Pick<AccessCodes, "due" | "claim" | "conclude">;
  repository: Pick<ConversationRepository, "getConversation" | "listRuns">;
  /** The signed link of the page the code's buyer published since the conversation began. */
  reportUrl(conversation: ConversationRecord): Promise<string | undefined>;
  /** Starts the Run of the Brief under `key`: the same key again is the same Run. */
  start(conversation: ConversationRecord, key: string): Promise<unknown>;
  /** Starts an answer-again Run after the failed or interrupted `run`, under `key`. */
  retry(conversation: ConversationRecord, run: ConversationRunRecord, key: string): Promise<unknown>;
  /** Posts the deliverable follow-up message and starts its Run, under `key`. */
  followup(conversation: ConversationRecord, key: string): Promise<unknown>;
  clock?: () => Date;
  pollMs?: number;
};

/**
 * Every spent code's conversation ends in exactly one terminal state, a published report or a visible failure (`outcome` on the code's
 * row), and never stalls silently. Each pass takes at most one action per non-terminal conversation, chosen from what its Runs are:
 * none: start it; failed or interrupted: retry; completed without a report: ask for it; active: leave it (the Run supervisor ends
 * a Run whose lease expired, which makes it interrupted); report published: ready; attempts used up: failed.
 * An action is claimed first by a conditional write on (code, attempts), so two passes or two instances never both act, and its key
 * carries the attempt, so a crash between claim and action leaves the next pass to the same state and the same key.
 */
export class CodeConversations {
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<void> | undefined;
  private again = false;

  constructor(private readonly deps: ReconcilerDeps) {}

  /** One pass. Passes never overlap in this process: one asked for while another runs is run once more right after it. */
  tick(): Promise<void> {
    if (this.flight) { this.again = true; return this.flight; }
    this.flight = (async () => { do { this.again = false; await this.pass(); } while (this.again); })().finally(() => { this.flight = undefined; });
    return this.flight;
  }

  /** A Run ended: look now instead of at the next tick. */
  nudge(): void { void this.tick().catch((error) => log.error("code_reconcile_failed", { error })); }

  start(): void {
    this.timer ??= setInterval(() => this.nudge(), this.deps.pollMs ?? 10_000);
    this.timer.unref();
  }

  stop(): void { clearInterval(this.timer); this.timer = undefined; }

  private async pass(): Promise<void> {
    const now = (this.deps.clock ?? (() => new Date()))();
    let due: DueCode[];
    try { due = await this.deps.codes.due(now, 200); } catch (error) { return log.error("code_reconcile_scan_failed", { error }); }
    for (const item of due) {
      try { await this.reconcile(item, now); } catch (error) { log.error("code_reconcile_failed", { code: item.code, conversation_id: item.conversationId, error }); }
    }
  }

  private async reconcile(item: DueCode, now: Date): Promise<void> {
    const { codes, repository, reportUrl } = this.deps;
    const conversation = await repository.getConversation(item.conversationId);
    if (!conversation) return;
    if (await reportUrl(conversation)) return codes.conclude(item.code, "ready");
    const runs = (await repository.listRuns(conversation.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const last = runs.at(-1);
    if (last && ACTIVE.has(last.status)) return;
    if (last?.status === "cancelled" || item.attempts >= MAX_CODE_ATTEMPTS) {
      log.error("code_conversation_failed", { code: item.code, conversation_id: conversation.id, product_id: item.productId, attempts: item.attempts, last_run: last?.id, last_status: last?.status });
      return codes.conclude(item.code, "failed");
    }
    const nextAt = new Date(now.getTime() + BACKOFF_MS[Math.min(item.attempts, BACKOFF_MS.length - 1)]!);
    if (!await codes.claim(item.code, item.attempts, nextAt)) return;
    try {
      if (!last) await this.deps.start(conversation, codeIntakeKey(item.code));
      else if (last.status === "completed") await this.deps.followup(conversation, codeFollowupKey(item.code, item.attempts));
      else await this.deps.retry(conversation, last, codeRetryKey(item.code, item.attempts));
    } catch (error) {
      // Busy or not retryable: somebody else got there first. Anything else is tried again after the backoff, within the budget.
      const code = (error as { code?: string }).code;
      if (code !== "conversation_busy" && code !== "run_not_retryable") log.error("code_reconcile_action_failed", { code: item.code, conversation_id: conversation.id, attempt: item.attempts, error });
    }
  }
}
