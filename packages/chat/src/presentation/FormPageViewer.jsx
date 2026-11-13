import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, PanelRight, PanelRightClose, X } from "lucide-react";
import { latestFormLink, linkKind } from "../domain/form-pages.js";

const shortTitle = href => { try { const url = new URL(href); return `${url.host}${url.pathname}`; } catch { return href; } };
const storageKey = conversationId => `hatch:page-panel:${conversationId}`;
const read = conversationId => {
  try { return JSON.parse(localStorage.getItem(storageKey(conversationId))) ?? {}; } catch { return {}; }
};
const write = (conversationId, state) => {
  try { localStorage.setItem(storageKey(conversationId), JSON.stringify({ page: state.page, mode: state.mode, seen: state.seen })); } catch { /* the panel works without storage */ }
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
      return write(conversationId, { ...current, page: { url: latest.url, title: shortTitle(latest.url) }, mode: "open", seen: latest.key });
    });
  }, [conversationId, latest?.key]);
  const update = patch => setState(previous => write(conversationId, { ...previous, ...patch }));
  const onClickCapture = event => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (linkKind(anchor.href, window.location.origin) === "other") return;
    event.preventDefault();
    event.stopPropagation();
    update({ page: { url: anchor.href, title: anchor.textContent || shortTitle(anchor.href) }, mode: "open" });
  };
  const setTitle = title => setState(previous => previous.page && previous.page.title !== title ? write(conversationId, { ...previous, page: { ...previous.page, title } }) : previous);
  return { page: state.page, mode: state.mode ?? "closed", setMode: mode => update({ mode }), setTitle, onClickCapture };
}

/** A floating sidebar above the whole app: open, collapsed to an edge tab, or closed (gone). Full-screen sheet on narrow screens. */
export function PagePanel({ viewer, t }) {
  const { page, mode, setMode } = viewer;
  if (!page || mode === "closed") return null;
  return createPortal(mode === "collapsed"
    ? <button type="button" className="web-chat__panel-tab" aria-label={page.title} title={page.title} onClick={() => setMode("open")}><PanelRight aria-hidden="true" /><span>{page.title}</span></button>
    : <aside className="web-chat__panel" aria-label={page.title}>
      <header className="web-chat__panel-header">
        <strong title={page.title}>{page.title}</strong>
        <a href={page.url} target="_blank" rel="noopener noreferrer" aria-label={t("openInNewTab")}><ExternalLink aria-hidden="true" /></a>
        <button type="button" aria-label={t("collapse")} onClick={() => setMode("collapsed")}><PanelRightClose aria-hidden="true" /></button>
        <button type="button" aria-label={t("close")} onClick={() => setMode("closed")}><X aria-hidden="true" /></button>
      </header>
      <iframe key={page.url} src={page.url} title={page.title} loading="lazy" onLoad={event => { try { const title = event.currentTarget.contentDocument?.title?.trim(); if (title) viewer.setTitle(title); } catch { /* cross-origin page keeps its link title */ } }} sandbox="allow-scripts allow-same-origin allow-forms" />
    </aside>, document.body);
}

/**
 * Keeps `--web-chat-reserve` (the height of the composer band, from the viewport bottom) on the document,
 * so the floating page panel stops above the composer. Attach the ref to the host's composer container.
 */
export function useComposerReserve(ref) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--web-chat-reserve", `${Math.max(0, Math.round(window.innerHeight - element.getBoundingClientRect().top)) + 8}px`);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); root.style.removeProperty("--web-chat-reserve"); };
  }, [ref]);
}
