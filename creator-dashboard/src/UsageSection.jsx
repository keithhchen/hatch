import React, { useEffect, useMemo, useState } from "react";
import { InlineAlert } from "@hatch/ui";
import { SURFACE_COLOR, UsageClient, formatTokens, usageView } from "./usage.js";
import { friendlyError, LoadingState } from "./studioShellKit.jsx";

const LABELS = { studio: "sxuStudio", chat_api: "sxuChatApi", chat_web: "sxuChatWeb" };
const BAR = 10;
const HEIGHT = 96;

/** The signed-in Expert's token usage this month and over the last 30 days. Real ledger data only. */
export function UsageSection({ request, t, locale }) {
  const client = useMemo(() => new UsageClient(request), [request]);
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { let live = true; client.get().then((next) => { if (live) setReport(next); }, (cause) => { if (live) setError(friendlyError(cause, t)); }); return () => { live = false; }; }, [client, t]);
  const view = useMemo(() => (report ? usageView(report) : null), [report]);
  const count = (tokens) => formatTokens(locale, tokens);

  return <section id="usage" className="sx-usage" aria-labelledby="sx-usage-title">
    <div className="sx-section-head"><h2 id="sx-usage-title">{t("sxUsage")}</h2></div>
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    {!view ? (error ? null : <LoadingState t={t} />) : view.empty ? <div className="sx-empty"><h2>{t("sxuEmpty")}</h2></div> : <div className="sx-card sx-usage__card">
      <div className="sx-usage__total"><strong>{count(view.total)}</strong><span>{t("sxuMonth")}</span></div>
      {view.cap ? <div className="sx-usage__cap">
        <div className="sx-usage__track" role="progressbar" aria-valuemin={0} aria-valuemax={view.cap.limit} aria-valuenow={view.cap.used} aria-label={t("sxuCap")}>
          <span data-over={view.cap.over} style={{ width: `${view.cap.ratio * 100}%` }} />
        </div>
        <span>{t("sxuCapOf", count(view.cap.used), count(view.cap.limit))}</span>
      </div> : null}
      <ul className="sx-usage__surfaces">
        {view.surfaces.map(({ surface, tokens }) => <li key={surface}><i style={{ background: SURFACE_COLOR[surface] }} /><span>{t(LABELS[surface])}</span><strong>{count(tokens)}</strong></li>)}
      </ul>
      <svg className="sx-usage__chart" viewBox={`0 0 ${view.days.length * BAR} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label={t("sxuDaily")}>
        {view.days.map((day, index) => {
          let top = HEIGHT;
          return <g key={day.day}>
            <title>{`${day.day}: ${count(day.total)}`}</title>
            {day.parts.filter((part) => part.tokens > 0).map((part) => { const height = (part.tokens / view.busiest) * HEIGHT; top -= height; return <rect key={part.surface} x={index * BAR + 1} y={top} width={BAR - 2} height={height} rx="1.5" fill={SURFACE_COLOR[part.surface]} />; })}
          </g>;
        })}
      </svg>
      <div className="sx-usage__axis"><span>{view.days[0]?.day}</span><span>{view.days.at(-1)?.day}</span></div>
    </div>}
  </section>;
}
