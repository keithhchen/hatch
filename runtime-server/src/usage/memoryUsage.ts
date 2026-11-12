import { emptySurfaces, monthStart, sumDays, utcDay, type DailyUsage, type SurfaceTokens, type UsageEvent, type UsageReader, type UsageRecorder } from "./usage.js";

/** The ledger in memory: for a process without a database, and for tests. */
export class InMemoryUsageLedger implements UsageRecorder, UsageReader {
  private readonly ids = new Set<string>();
  private readonly days = new Map<string, Map<string, SurfaceTokens>>();

  async record(event: UsageEvent): Promise<void> {
    if (this.ids.has(event.id)) return;
    this.ids.add(event.id);
    const byDay = this.days.get(event.accountId) ?? new Map<string, SurfaceTokens>();
    this.days.set(event.accountId, byDay);
    const day = utcDay(event.at ?? new Date());
    const surfaces = byDay.get(day) ?? emptySurfaces();
    byDay.set(day, surfaces);
    const count = surfaces[event.surface];
    count.input += event.inputTokens;
    count.cachedInput += event.cachedInputTokens;
    count.output += event.outputTokens;
    count.reasoning += event.reasoningTokens;
  }

  async daily(accountId: string, from: string, to: string): Promise<DailyUsage[]> {
    return [...this.days.get(accountId) ?? []]
      .filter(([day]) => day >= from && day <= to)
      .map(([day, usage]) => ({ day, usage: structuredClone(usage) }))
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  async monthToDate(accountId: string, now = new Date()): Promise<SurfaceTokens> {
    return sumDays(await this.daily(accountId, monthStart(now), utcDay(now)));
  }
}
