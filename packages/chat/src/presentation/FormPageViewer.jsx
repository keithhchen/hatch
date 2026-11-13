import React, { useEffect, useState } from "react";
import { ExternalLink, PanelRight, X } from "lucide-react";
import { latestFormLink, linkKind } from "../domain/form-pages.js";

const storageKey = conversationId => `hatch:page-panel:${conversationId}`;
const read = conversationId => {
  try { return JSON.parse(localStorage.getItem(storageKey(conversationId))) ?? {}; } catch { return {}; }
};
const write = (conversationId, state) => {
  try { localStorage.setItem(storageKey(conversationId), JSON.stringify({ page: state.page, open: state.open, seen: state.seen })); } catch { /* the panel works without storage */ }
  return state;
};

/**
 * Side-panel state for one conversation: the form page link in the latest message opens it once
 * (closing sticks), a click on any Hatch link in the message container opens it, and open/closed
 * is remembered per conversation.
 */
export function useFormPageViewer(messages, conversationId) {
  const [state, setState] = useState(() => ({ ...read(conversationId), id: conversationId }));
  const latest = latestFormLink(messages, window.location.origin);
  useEffect(() => {
    setState(previous => {
      const current = previous.id === conversationId ? previous : { ...read(conversationId), id: conversationId };
      if (!latest || current.seen === latest.key) return current;
      return write(conversationId, { ...current, page: { url: latest.url, title: latest.url }, open: true, seen: latest.key });
    });
  }, [conversationId, latest?.key]);
  const update = patch => setState(previous => write(conversationId, { ...previous, ...patch }));
  const onClickCapture = event => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (linkKind(anchor.href, window.location.origin) === "other") return;
    event.preventDefault();
    event.stopPropagation();
    update({ page: { url: anchor.href, title: anchor.textContent || anchor.href }, open: true });
  };
  const open = Boolean(state.page && state.open);
  return { page: state.page, open, toggle: () => update({ open: !open }), onClickCapture };
}

/** The chat beside its page panel: a right-hand split on wide screens, a full-screen sheet on narrow ones. */
export function PageSplit({ viewer, t, children }) {
  const { page, open } = viewer;
  return <div className="web-chat__split">
    {children}
    {page ? <button type="button" className="web-chat__panel-toggle" aria-label={t("pagePanel")} aria-pressed={open} onClick={viewer.toggle}><PanelRight aria-hidden="true" /></button> : null}
    {open ? <aside className="web-chat__panel" aria-label={page.title}>
      <header className="web-chat__panel-header">
        <strong title={page.title}>{page.title}</strong>
        <a href={page.url} target="_blank" rel="noopener noreferrer" aria-label={t("openInNewTab")}><ExternalLink aria-hidden="true" /></a>
        <button type="button" aria-label={t("close")} onClick={viewer.toggle}><X aria-hidden="true" /></button>
      </header>
      <iframe key={page.url} src={page.url} title={page.title} loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms" />
    </aside> : null}
  </div>;
}
