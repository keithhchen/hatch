import React, { useEffect, useState } from "react";
import { InlineAlert } from "@hatch/ui";
import { Download, Lock } from "lucide-react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { reportFileOpened, reportViewed } from "./analytics/events.js";
import { formatElapsed, isWaiting } from "./artifactForm.js";
import { WebChatEgg } from "./webChatGate.jsx";
import { webChatErrorText } from "./webChatI18n.js";

const POLL_MS = 5000;

/** The report of one conversation, always read from the server: on load, on refresh, after a long absence. */
export function ArtifactReportPage({ api, conversationId, productId, onDraft, debug, t, locale }) {
  const analytics = useAnalytics();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const status = report?.status;
  const waiting = report ? isWaiting(report) : false;

  useEffect(() => {
    let live = true;
    let timer;
    const poll = async () => {
      try {
        const next = await api.report(conversationId);
        if (!live) return;
        setReport(next);
        setError(null);
        if (next.status === "draft") { onDraft(); return; }
        if (!isWaiting(next)) return;
      } catch (cause) {
        if (!live) return;
        setError(cause);
      }
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, conversationId, onDraft]);

  useEffect(() => {
    if (!waiting) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting]);

  useEffect(() => {
    if (status) analytics.track(reportViewed({ agentId: productId, status, unlocked: report.unlocked === true }));
  }, [analytics, productId, status, report?.unlocked]);

  const file = (name, label) => <a className={`web-chat__button web-chat__button--${name === "full.pdf" ? "yolk" : "ink"}`} href={api.reportFileUrl(conversationId, name)} target="_blank" rel="noopener" onClick={() => analytics.track(reportFileOpened({ agentId: productId, name }))}><Download aria-hidden="true" />{label}</a>;
  const startedAt = Date.parse(report?.started_at ?? "");

  return <div className="web-chat__messages"><div className="web-chat__thread artifact__report">
    {!report ? (error
      ? <InlineAlert tone="error" title={t("artifactStatusUnavailable")}>{webChatErrorText(error, locale)}</InlineAlert>
      : <div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /></div>) : null}
    {waiting ? <div className="artifact__generating">
      <div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /><span>{t("artifactGenerating")}</span></div>
      {Number.isNaN(startedAt) ? null : <span className="artifact__elapsed">{t("artifactElapsed", { time: formatElapsed(now - startedAt) })}</span>}
      {error ? <InlineAlert tone="warning" title={t("artifactStatusUnavailable")}>{webChatErrorText(error, locale)}</InlineAlert> : null}
      {debug ? <div className="artifact__debug">
        <b>{report.stage}{report.attempt > 1 ? ` · attempt ${report.attempt}` : ""}</b>
        <ol>{(report.steps ?? []).map((step, index) => <li key={index}><time>{step.at}</time> {step.stage}{step.detail ? ` — ${step.detail}` : ""}</li>)}</ol>
      </div> : null}
    </div> : null}
    {status === "failed" ? <InlineAlert tone="error" title={t("artifactFailedTitle")}>{report.error ?? ""}<br />{t("artifactReference", { id: conversationId })}</InlineAlert> : null}
    {status === "ready" ? <>
      {report.unlocked ? null : <figure className="artifact__preview">
        {report.files?.preview ? <img src={api.reportFileUrl(conversationId, "preview.png")} alt={t("artifactPreviewAlt")} /> : null}
        <figcaption><Lock aria-hidden="true" />{t("artifactLocked")}</figcaption>
      </figure>}
      <div className="artifact__downloads">
        {report.files?.free_pdf ? file("free.pdf", t("artifactDownloadFree")) : null}
        {report.files?.full_pdf ? file("full.pdf", t("artifactDownloadFull")) : null}
      </div>
    </> : null}
  </div></div>;
}
