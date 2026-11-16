import React, { useCallback, useEffect, useRef, useState } from "react";
import { InlineAlert } from "@hatch/ui";
import { Lock } from "lucide-react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { reportViewed } from "./analytics/events.js";
import { formatElapsed, isWaiting } from "./artifactForm.js";
import { WebChatEgg } from "./webChatGate.jsx";
import { webChatErrorText } from "./webChatI18n.js";

const POLL_MS = 5000;
/** The free view shows the free sections only; the blurred pages under it stand for the paid part. */
const FREE_VIEW_CSS = "section[data-locked]{display:none!important}";

/** The report's own HTML, framed: it runs nothing (the server's policy), and the frame grows to its full height. */
function ReportFrame({ src, hideLocked, title }) {
  const frame = useRef(null);
  const [height, setHeight] = useState(0);
  const fit = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.documentElement) return;
    if (hideLocked && !doc.querySelector("style[data-hatch=free-view]")) {
      const style = doc.createElement("style");
      style.dataset.hatch = "free-view";
      style.textContent = FREE_VIEW_CSS;
      doc.head.appendChild(style);
    }
    setHeight(doc.documentElement.scrollHeight);
    const observer = new ResizeObserver(() => setHeight(doc.documentElement.scrollHeight));
    observer.observe(doc.body);
    frame.current.addEventListener("load", () => observer.disconnect(), { once: true });
  }, [hideLocked]);
  return <iframe ref={frame} className="artifact__frame" src={src} title={title} sandbox="allow-same-origin" onLoad={fit} style={{ height: height || 600 }} />;
}

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
      {report.files?.full_html
        ? <ReportFrame src={api.reportFileUrl(conversationId, "full.html")} title={t("artifactReportTitle")} />
        : <>
          <ReportFrame src={api.reportFileUrl(conversationId, "free.html")} title={t("artifactReportTitle")} hideLocked />
          <figure className="artifact__preview">
            <img src={api.reportFileUrl(conversationId, "preview.png")} alt={t("artifactPreviewAlt")} />
            <figcaption><Lock aria-hidden="true" />{t("artifactLocked")}</figcaption>
          </figure>
        </>}
    </> : null}
  </div></div>;
}
