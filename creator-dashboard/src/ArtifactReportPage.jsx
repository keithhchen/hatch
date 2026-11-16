import React, { useEffect, useRef, useState } from "react";
import { InlineAlert } from "@hatch/ui";
import { Lock } from "lucide-react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { reportFileOpened, reportViewed } from "./analytics/events.js";
import { formatElapsed, isWaiting } from "./artifactForm.js";
import { WebChatEgg } from "./webChatGate.jsx";
import { webChatErrorText } from "./webChatI18n.js";

const POLL_MS = 5000;
/** A PDF shown as its pages, drawn by pdf.js at the column's width: the same pages a download would give. */
function PdfPages({ src, title, failed }) {
  const box = useRef(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let doc;
    (async () => {
      const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      doc = await pdfjs.getDocument({ url: src, withCredentials: true }).promise;
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

/** The preview image: page 1 as printed, then the next pages blurred. The unlock control sits just below page 1. */
function ReportPreview({ src, alt, children }) {
  const [top, setTop] = useState(null);
  const placed = (event) => {
    const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
    if (width && height) setTop(`${((width * Math.SQRT2) / height) * 100}%`); // an A4 page is √2 as tall as it is wide
  };
  return <figure className="artifact__preview">
    <img src={src} alt={alt} onLoad={placed} />
    {top ? <figcaption style={{ top }}>{children}</figcaption> : null}
  </figure>;
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
        ? <PdfPages src={api.reportFileUrl(conversationId, "full.pdf")} title={t("artifactReportTitle")} failed={t("artifactStatusUnavailable")} />
        : <ReportPreview src={api.reportFileUrl(conversationId, "preview.png")} alt={t("artifactPreviewAlt")}>
          {report.files?.full_pdf
            ? <a className="web-chat__button web-chat__button--yolk" href={api.reportFileUrl(conversationId, "full.pdf")} download onClick={() => analytics.track(reportFileOpened({ agentId: productId, name: "full.pdf" }))}><Lock aria-hidden="true" />{t("artifactUnlock")}</a>
            : <span className="artifact__locked"><Lock aria-hidden="true" />{t("artifactLocked")}</span>}
        </ReportPreview>}
    </> : null}
  </div></div>;
}
