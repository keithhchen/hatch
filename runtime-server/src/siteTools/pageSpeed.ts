import { callJson, requireString, SiteToolError, type Fetch, type SiteLookup } from "./ports.js";

type Audit = { title?: string; displayValue?: string; numericValue?: number; details?: { type?: string; overallSavingsMs?: number } };
const METRICS = { lcp: "largest-contentful-paint", fcp: "first-contentful-paint", cls: "cumulative-layout-shift", tbt: "total-blocking-time", speed_index: "speed-index" };

/** Page speed lab test of a URL, cut down to the score, the core metrics and the five biggest savings. */
export class PageSpeed implements SiteLookup<{ url?: unknown; strategy?: unknown }> {
  constructor(private readonly fetcher: Fetch, private readonly key: string) {}

  async run(args: { url?: unknown; strategy?: unknown }, signal?: AbortSignal) {
    const url = requireString(args.url, "url");
    const strategy = args.strategy === undefined ? "mobile" : args.strategy;
    if (strategy !== "mobile" && strategy !== "desktop") throw new SiteToolError("invalid_call", "strategy is mobile or desktop.");
    const query = new URLSearchParams({ url, strategy, key: this.key, category: "performance" });
    const body = await callJson(this.fetcher, `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query}`, {}, 120_000, signal) as
      { lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, Audit>; finalUrl?: string } };
    const lighthouse = body?.lighthouseResult;
    const score = lighthouse?.categories?.performance?.score;
    if (!lighthouse || typeof score !== "number") throw new SiteToolError("no_result", "The test returned no performance score for this page.");
    const audits = lighthouse.audits ?? {};
    const metrics = Object.fromEntries(Object.entries(METRICS).map(([name, id]) => [name, { display: audits[id]?.displayValue, value: audits[id]?.numericValue }]));
    const opportunities = Object.values(audits)
      .filter(audit => audit.details?.type === "opportunity" && (audit.details.overallSavingsMs ?? 0) > 0)
      .sort((a, b) => b.details!.overallSavingsMs! - a.details!.overallSavingsMs!)
      .slice(0, 5).map(audit => ({ title: audit.title, display: audit.displayValue }));
    return { url: lighthouse.finalUrl ?? url, strategy, performance_score: Math.round(score * 100), metrics, opportunities };
  }
}
