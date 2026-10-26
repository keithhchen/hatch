import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { latestThinkingText } from "../domain/activity.js";
import { Shimmer } from "./Shimmer.jsx";

export function ThinkingTicker({ content }) {
  const text = latestThinkingText(content, 50);
  if (!text) return null;
  return <span className="web-chat__activity-thinking-preview">
    <span className="web-chat__thinking-ticker-track">
      <span className="web-chat__thinking-ticker-copy">{text}</span>
      <span className="web-chat__thinking-ticker-copy" aria-hidden="true">{text}</span>
    </span>
  </span>;
}

const toolTitleKeys = Object.freeze({ requested: "toolRunningTitle", completed: "toolCompleteTitle", failed: "toolFailedTitle", cancelled: "toolCancelledTitle" });
const skillRunTitleKeys = Object.freeze({ requested: "skillRunRequestedTitle", completed: "skillRunCompleteTitle", failed: "skillRunFailedTitle", cancelled: "skillRunCancelledTitle" });

/** One title strategy per activity kind; hosts translate the keys. */
export const activityPresentations = Object.freeze({
  thinking: (entry, { t }) => ({ title: t(entry.streaming ? "thinkingRunningTitle" : "thinkingCompleteTitle") }),
  tool: (entry, { t }) => ({ title: entry.content.activityMessage?.trim() || t(toolTitleKeys[entry.status] ?? "toolRunningTitle", { name: entry.title }) }),
  skill: (entry, { t }) => ({ title: t(entry.status === "invoked" ? "skillInvokedTitle" : "skillActivatedTitle", { name: entry.title }) }),
  skill_run: (entry, { t }) => ({ title: t(skillRunTitleKeys[entry.status] ?? "skillRunRunningTitle", { name: entry.title }) })
});

function present(entry, t) {
  const presentation = activityPresentations[entry.kind];
  if (!presentation) throw new Error(`Unsupported chat activity kind: ${entry.kind}`);
  return presentation(entry, { t });
}

/** A quiet row that opens every step of an activity group in a modal. */
export function ActivityModal({ entries, isLastItem, t, errorText, loadToolDetail }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const dialogRef = useRef(null);
  const lastEntry = entries.at(-1);
  const triggerTitle = isLastItem ? present(lastEntry, t).title : t("activityProcessed");
  const thinkingPreview = isLastItem && lastEntry.kind === "thinking" ? lastEntry.content : "";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return <>
    <button type="button" className={`web-chat__activity-trigger${isLastItem ? " web-chat__activity-trigger--live" : ""}`} aria-haspopup="dialog" onClick={() => { setHasOpened(true); setOpen(true); }}>
      <span className="web-chat__activity-dot" aria-hidden="true" />
      {isLastItem
        ? <span className="web-chat__activity-trigger-label"><Shimmer as="span" className="web-chat__activity-trigger-title">{triggerTitle}</Shimmer>{thinkingPreview ? <ThinkingTicker content={thinkingPreview} /> : null}</span>
        : <span className="web-chat__activity-trigger-label"><span>{triggerTitle}</span></span>}
      <ChevronRight aria-hidden="true" />
    </button>
    <dialog ref={dialogRef} className="web-chat__activity-modal" aria-label={t("activityDetails")} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <header className="web-chat__activity-modal-header">
        <h2>{t("activityDetails")}</h2>
        <button type="button" aria-label={t("close")} onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
      </header>
      {hasOpened ? <div className="web-chat__activity-modal-items">
        {entries.map(activity => <ActivityBlock key={activity.id} entry={activity} t={t} errorText={errorText} loadToolDetail={loadToolDetail} expandable={false} />)}
      </div> : null}
    </dialog>
  </>;
}

export function ActivityBlock({ entry, t, errorText, loadToolDetail, expandable = true }) {
  const { title } = present(entry, t);
  if (!expandable) return <div className="web-chat__activity-block" data-status={entry.status ?? (entry.streaming ? "requested" : "completed")}>
    <div className="web-chat__activity-heading web-chat__activity-heading--static">
      <span className="web-chat__activity-dot" aria-hidden="true" />
      <strong>{title}</strong>
    </div>
  </div>;
  return <details className="web-chat__activity-block">
    <summary className="web-chat__activity-heading">
      <strong>{title}</strong>
      <ChevronDown aria-hidden="true" />
    </summary>
    {entry.content ? <div className="web-chat__activity-content">{entry.kind === "thinking"
      ? entry.content
      : <ToolDetails content={entry.content} status={entry.status} t={t} errorText={errorText} loadToolDetail={loadToolDetail} />}</div> : null}
  </details>;
}

/** Tool input/output; full detail is fetched once when only a reference is stored. */
export function ToolDetails({ content, status, t, errorText, loadToolDetail }) {
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const requestedDetailRef = useRef(null);
  const detailRunId = content.detailRef?.run_id;
  const detailToolCallId = content.detailRef?.tool_call_id;
  useEffect(() => {
    const terminal = ["completed", "failed", "cancelled"].includes(status);
    if (!terminal || !detailRunId || !detailToolCallId || content.result !== undefined || content.error !== undefined
      || requestedDetailRef.current === `${detailRunId}:${detailToolCallId}`) return;
    requestedDetailRef.current = `${detailRunId}:${detailToolCallId}`;
    setDetailLoading(true);
    setDetailError("");
    let active = true;
    loadToolDetail({ run_id: detailRunId, tool_call_id: detailToolCallId }).then(payload => {
      if (active) setDetail(payload.tool);
    }).catch(cause => {
      if (active) setDetailError(cause.message);
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [loadToolDetail, detailRunId, detailToolCallId, content.result, content.error, status]);
  const argumentsValue = detail?.arguments ?? content.arguments;
  const resultValue = detail?.result ?? content.result;
  return <>
    {content.error ? <p className="web-chat__tool-error">{errorText(content.error)}</p> : null}
    {detailLoading ? <p className="web-chat__tool-note" role="status">{t("loadingToolDetails")}</p> : null}
    {detailError ? <p className="web-chat__tool-error" role="alert">{detailError}</p> : null}
    <ToolValue label={t("arguments")} value={argumentsValue ?? {}} t={t} />
    {resultValue !== undefined ? <ToolValue label={t("result")} value={resultValue} t={t} /> : null}
  </>;
}

const toolValueText = value => typeof value === "string" ? value : JSON.stringify(value, null, 2);

/** Tool input/output as readable label/value rows instead of raw JSON. */
function ToolValue({ label, value, t }) {
  const rows = value && typeof value === "object" && !Array.isArray(value) ? Object.entries(value) : null;
  return <section className="web-chat__tool-value">
    <h3>{label}</h3>
    {rows
      ? rows.length
        ? <dl>{rows.map(([key, item]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{toolValueText(item)}</dd></div>)}</dl>
        : <p>{t("noDetails")}</p>
      : <p>{toolValueText(value)}</p>}
  </section>;
}
