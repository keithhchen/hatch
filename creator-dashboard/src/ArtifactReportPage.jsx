import React, { useEffect, useRef, useState } from "react";
import { InlineAlert } from "@hatch/ui";
import { BookOpen, FileCheck, Globe, Lightbulb, Lock, PenLine, ScanSearch } from "lucide-react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { reportFileOpened, reportViewed } from "./analytics/events.js";
import { REPORT_STEPS, formatElapsed, isMissingReport, isWaiting, reportStep } from "./artifactForm.js";
import { WebChatEgg } from "./webChatGate.jsx";
import { webChatErrorText } from "./webChatI18n.js";

const POLL_MS = 5000;
const ESTIMATE_MINUTES = 6;
/** One animated glyph per step; the animation is the step's own motion (a page turning, a globe turning, a pen writing). */
const STEP_GLYPHS = { reading: BookOpen, consulting: Lightbulb, researching: Globe, writing: PenLine, proofreading: ScanSearch, rendering: FileCheck };
/** A PDF shown as its pages, drawn by pdf.js at the column's width: the same pages a download would give. Read straight from its object-store link. */
function PdfPages({ src, title, failed }) {
  const box = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let doc;
    (async () => {
      const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      doc = await pdfjs.getDocument({ url: src, withCredentials: src.startsWith("/") }).promise;
      const host = box.current;
      if (cancelled || !host) return;
      host.replaceChildren();
      const ratio = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages && !cancelled; n += 1) {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: (host.clientWidth / page.getViewport({ scale: 1 }).width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.className = "artifact__page";
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        host.appendChild(canvas);
        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
      }
    })().catch((cause) => { if (!cancelled) setError(cause); });
    return () => { cancelled = true; void doc?.destroy(); };
  }, [src]);
  return <>
    <div ref={box} className="artifact__pages" role="document" aria-label={title} />
    {error ? <InlineAlert tone="error" title={failed} /> : null}
  </>;
}

const LOCKED_REST = "/assets/web/report-locked.webp";

/** The summary page as printed, and under it a blurred stand-in for the rest of the report with the unlock control over it. */
function LockedSummary({ summaryUrl, onUnlock, unlocking, t }) {
  return <figure className="artifact__summary">
    <img className="artifact__summary-page" src={summaryUrl} alt={t("artifactSummaryAlt")} />
    <div className="artifact__rest">
      <img src={LOCKED_REST} alt="" aria-hidden="true" />
      <button type="button" className="web-chat__button web-chat__button--yolk" onClick={onUnlock} disabled={unlocking}><Lock aria-hidden="true" />{t("artifactUnlock")}</button>
    </div>
  </figure>;
}

/** The report of one conversation, always read from the server: on load, on refresh, after a long absence. */
export function ArtifactReportPage({ api, conversationId, productId, onDraft, onDownload, debug, t, locale }) {
  const analytics = useAnalytics();
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [round, setRound] = useState(0);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState(null);
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
        if (isMissingReport(cause)) return;
      }
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [api, conversationId, onDraft, round]);

  useEffect(() => {
    if (!waiting) return undefined;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [waiting]);

  useEffect(() => {
    if (status) analytics.track(reportViewed({ agentId: productId, status, unlocked: report.unlocked === true }));
  }, [analytics, productId, status, report?.unlocked]);

  // Once the full report is ready its download sits in the page header, where it stays in reach while the reader scrolls.
  const fullReady = status === "ready" && report?.phase === "full";
  useEffect(() => {
    if (!fullReady) return undefined;
    onDownload?.({ href: api.reportFileUrl(conversationId, "full.pdf", { download: 1 }), track: () => analytics.track(reportFileOpened({ agentId: productId, name: "full.pdf" })) });
    return () => onDownload?.(null);
  }, [fullReady, api, conversationId, productId, analytics, onDownload]);

  const unlock = async () => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      setReport(await api.unlockReport(conversationId));
      setRound(count => count + 1); // the full report is being written: poll again
    } catch (cause) { setUnlockError(cause); }
    setUnlocking(false);
  };

  const startedAt = Date.parse(report?.started_at ?? "");

  return <div className="web-chat__messages"><div className="web-chat__thread artifact__report">
    {!report ? (isMissingReport(error)
      ? <InlineAlert tone="error" title={t("artifactReportNotFound")} />
      : error
      ? <InlineAlert tone="error" title={t("artifactStatusUnavailable")}>{webChatErrorText(error, locale)}</InlineAlert>
      : <div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /></div>) : null}
    {waiting ? <div className="artifact__generating">
      <div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /><span>{t(report.phase === "full" ? "artifactGeneratingFull" : "artifactGenerating")}</span></div>
      {(() => {
        const name = REPORT_STEPS[reportStep(report) - 1];
        const Glyph = STEP_GLYPHS[name];
        return <div className="artifact__step" key={name} role="status">
          <span className={`artifact__glyph artifact__glyph--${name}`}><Glyph size={22} strokeWidth={1.75} aria-hidden /></span>
          <span>{t(`artifactStep_${name}`)}</span>
        </div>;
      })()}
      <span className="artifact__elapsed">{t("artifactEstimate", { minutes: ESTIMATE_MINUTES })}{Number.isNaN(startedAt) ? "" : ` · ${t("artifactElapsed", { time: formatElapsed(now - startedAt) })}`}</span>
      {error ? <InlineAlert tone="warning" title={t("artifactStatusUnavailable")}>{webChatErrorText(error, locale)}</InlineAlert> : null}
      {debug ? <div className="artifact__debug">
        <b>{report.stage}{report.attempt > 1 ? ` · attempt ${report.attempt}` : ""}</b>
        <ol>{(report.steps ?? []).map((step, index) => <li key={index}><time>{step.at}</time> {step.stage}{step.detail ? ` — ${step.detail}` : ""}</li>)}</ol>
      </div> : null}
    </div> : null}
    {status === "failed" ? <InlineAlert tone="error" title={t("artifactFailedTitle")}>{report.error ?? ""}<br />{t("artifactReference", { id: conversationId })}</InlineAlert> : null}
    {fullReady ? <PdfPages src={report.pdf_url ?? api.reportFileUrl(conversationId, "full.pdf")} title={t("artifactReportTitle")} failed={t("artifactStatusUnavailable")} /> : null}
    {status === "ready" && report.phase === "summary" ? <>
      <LockedSummary summaryUrl={api.reportFileUrl(conversationId, "summary.png")} onUnlock={unlock} unlocking={unlocking} t={t} />
      {unlockError ? <InlineAlert tone="error" title={t("artifactUnlockFailed")}>{webChatErrorText(unlockError, locale)}</InlineAlert> : null}
    </> : null}
  </div></div>;
}
