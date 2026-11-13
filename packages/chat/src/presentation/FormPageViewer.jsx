import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { latestFormLink, linkKind } from "../domain/form-pages.js";

/**
 * In-page viewer state: a form page link in the latest message opens once (closing sticks),
 * and a click on any Hatch link inside the message container opens it here instead of navigating.
 */
export function useFormPageViewer(messages, conversationId) {
  const [page, setPage] = useState(null);
  const handled = useRef("");
  useEffect(() => { setPage(null); }, [conversationId]);
  const latest = latestFormLink(messages, window.location.origin);
  useEffect(() => {
    if (!latest || handled.current === latest.key) return;
    handled.current = latest.key;
    setPage({ url: latest.url, title: latest.url });
  }, [latest?.key]);
  const onClickCapture = event => {
    const anchor = event.target.closest?.("a[href]");
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (linkKind(anchor.href, window.location.origin) === "other") return;
    event.preventDefault();
    event.stopPropagation();
    setPage({ url: anchor.href, title: anchor.textContent || anchor.href });
  };
  return { page, close: () => setPage(null), onClickCapture };
}

export function FormPageViewer({ page, onClose, closeLabel }) {
  if (!page) return null;
  return <aside className="web-chat__page-viewer" aria-label={page.title}>
    <button type="button" className="web-chat__page-viewer-close" aria-label={closeLabel} onClick={onClose}><X aria-hidden="true" /></button>
    <iframe key={page.url} src={page.url} title={page.title} loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms" />
  </aside>;
}
