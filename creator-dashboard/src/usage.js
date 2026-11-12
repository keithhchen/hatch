// Usage: a port over the dashboard `request` helper plus the pure view model the Usage section renders.
// Every number comes from Registry's ledger; nothing here is estimated or filled in.
const ROOT = "/v1/creator/usage";
export const USAGE_SURFACES = ["studio", "chat_api", "chat_web"];
export const SURFACE_COLOR = { studio: "var(--web-yolk)", chat_api: "var(--web-blue)", chat_web: "var(--web-pass)" };
const INTL = { en: "en", zh: "zh-CN", ja: "ja-JP" };

export class UsageClient {
  #request;
  constructor(request) { this.#request = request; }
  get() { return this.#request(ROOT); }
}

export const formatTokens = (locale, value) => new Intl.NumberFormat(INTL[locale] ?? "en", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);

/** What the section shows for one report: per-surface totals, stacked daily bars scaled to the busiest day, and the cap if there is one. */
export function usageView(report) {
  const month = report?.month_to_date ?? {};
  const days = (report?.daily ?? []).map((day) => ({ day: day.day, parts: USAGE_SURFACES.map((surface) => ({ surface, tokens: day[surface] ?? 0 })), total: USAGE_SURFACES.reduce((sum, surface) => sum + (day[surface] ?? 0), 0) }));
  const busiest = Math.max(0, ...days.map((day) => day.total));
  const limit = report?.cap?.monthly_tokens ?? null;
  const total = month.total ?? 0;
  return {
    total,
    empty: total === 0 && busiest === 0,
    surfaces: USAGE_SURFACES.map((surface) => ({ surface, tokens: month[surface] ?? 0 })),
    days, busiest,
    cap: limit ? { limit, used: total, ratio: Math.min(1, total / limit), over: total >= limit } : null
  };
}
