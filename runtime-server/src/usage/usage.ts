import type { Usage } from "@earendil-works/pi-ai";
import type { Log } from "../observability/log.js";

/** Who spent the tokens: Chat over the API, Chat in an app or channel, or the Expert building in Studio. */
export const USAGE_SURFACES = ["studio", "chat_api", "chat_web"] as const;
export type UsageSurface = typeof USAGE_SURFACES[number];

export type TokenCount = { input: number; cachedInput: number; output: number; reasoning: number };
export type SurfaceTokens = Record<UsageSurface, TokenCount>;

/** One completed model call. `id` is the call's own identity: recording the same id twice counts once. */
export type UsageEvent = {
  id: string;
  accountId: string;
  surface: UsageSurface;
  apiKeyId?: string;
  productId?: string;
  runId?: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  at?: Date;
};

/** The one way a model call's usage enters the ledger. */
export interface UsageRecorder { record(event: UsageEvent): Promise<void> }

export type DailyUsage = { day: string; usage: SurfaceTokens };

/** What an account has spent. Days are UTC; `from` and `to` are inclusive YYYY-MM-DD. */
export interface UsageReader {
  monthToDate(accountId: string, now?: Date): Promise<SurfaceTokens>;
  daily(accountId: string, from: string, to: string): Promise<DailyUsage[]>;
  /** Every model call of one Run, summed: what the Run spent. */
  forRun(runId: string): Promise<TokenCount>;
}

export const emptyTokens = (): TokenCount => ({ input: 0, cachedInput: 0, output: 0, reasoning: 0 });
export const emptySurfaces = (): SurfaceTokens => ({ studio: emptyTokens(), chat_api: emptyTokens(), chat_web: emptyTokens() });
export const billableTokens = (count: TokenCount): number => count.input + count.output;
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);
export const monthStart = (now: Date): string => `${utcDay(now).slice(0, 7)}-01`;

/** The monthly token cap for every account; unset or not a positive integer means no cap. Enforcement reads this, the dashboard shows it. */
export function monthlyTokenCap(env: NodeJS.ProcessEnv): number | null {
  const cap = Number(env.HATCH_MONTHLY_TOKEN_CAP?.trim());
  return Number.isSafeInteger(cap) && cap > 0 ? cap : null;
}

/** Who pays for a run's model calls, attributed once per run and carried to every call. */
export type UsageAttribution = { accountId: string; surface: UsageSurface; apiKeyId?: string; productId?: string; runId?: string };

/** How a host decides, from its own scope, who pays for a Run. A Responses API Run says `chat_api` and its key here. */
export type UsageAttributor<Scope> = (scope: Scope, run: { id: string }) => UsageAttribution;
export type UsageRecording<Scope> = { recorder: UsageRecorder; attribute: UsageAttributor<Scope> };

/** The surface and key a conversation's scope carries; a scope that says nothing is web or app chat. */
export type UsageScope = { creatorId: string; productId: string; usageSurface?: UsageSurface; apiKeyId?: string };
export const payerByScope = (scope: UsageScope): string => scope.creatorId;
export const attributeByScope: UsageAttributor<UsageScope> = (scope, run) => ({
  accountId: payerByScope(scope), surface: scope.usageSurface ?? "chat_web", productId: scope.productId, runId: run.id,
  ...(scope.apiKeyId ? { apiKeyId: scope.apiKeyId } : {})
});

/** Adds days of usage up: the month to date is the sum of its days. */
export function sumDays(days: DailyUsage[]): SurfaceTokens {
  const total = emptySurfaces();
  for (const { usage } of days) for (const surface of USAGE_SURFACES) for (const key of Object.keys(total[surface]) as Array<keyof TokenCount>) total[surface][key] += usage[surface][key];
  return total;
}

/** A finished model call as the pi runtime reports it. */
export type ModelCall = { id: string; model: string; usage: Usage };

/**
 * An attribution bound to a recorder. Recording never breaks a run: a failure is logged with the run id and dropped,
 * the run's own transcript still holds the usage. Input counts the whole prompt, the cached part included.
 */
export type UsageSink = (call: ModelCall) => Promise<void>;
export function usageSink(recorder: UsageRecorder | undefined, attribution: UsageAttribution, log: Pick<Log, "error">): UsageSink {
  return async ({ id, model, usage }) => {
    if (!recorder) return;
    try {
      await recorder.record({
        ...attribution, id, model,
        inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
        cachedInputTokens: usage.cacheRead,
        outputTokens: usage.output,
        reasoningTokens: usage.reasoning ?? 0
      });
    } catch (error) {
      log.error("usage_record_failed", { run_id: attribution.runId, account_id: attribution.accountId, error });
    }
  };
}

/** The shape the creator dashboard reads: tokens are input + output, per surface, with every day of the range present. */
export async function usageReport(reader: UsageReader, accountId: string, from: string, to: string, cap: number | null, now = new Date()) {
  const tokens = (surfaces: SurfaceTokens) => ({
    studio: billableTokens(surfaces.studio), chat_api: billableTokens(surfaces.chat_api), chat_web: billableTokens(surfaces.chat_web)
  });
  const month = await reader.monthToDate(accountId, now);
  const byDay = new Map((await reader.daily(accountId, from, to)).map(({ day, usage }) => [day, usage]));
  const daily: Array<{ day: string } & ReturnType<typeof tokens>> = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += 86_400_000) {
    const day = utcDay(new Date(at));
    daily.push({ day, ...tokens(byDay.get(day) ?? emptySurfaces()) });
  }
  const sums = tokens(month);
  return {
    month_to_date: { ...sums, total: sums.studio + sums.chat_api + sums.chat_web, split: month },
    cap: { monthly_tokens: cap, remaining_tokens: cap === null ? null : Math.max(0, cap - sums.studio - sums.chat_api - sums.chat_web) },
    daily
  };
}
