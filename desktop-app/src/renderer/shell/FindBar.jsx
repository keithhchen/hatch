import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useObservable } from "../observable.js";
import { useDesktop } from "./context.js";

const SCOPE = ".web-chat__thread";
const highlights = globalThis.CSS?.highlights;

/** Text ranges matching `query` (case-insensitive) inside the thread. */
export function findRanges(root, query) {
  if (!root || !query) return [];
  const needle = query.toLocaleLowerCase();
  const ranges = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const haystack = node.data.toLocaleLowerCase();
    for (let index = haystack.indexOf(needle); index >= 0; index = haystack.indexOf(needle, index + needle.length)) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * ⌘F: find in the visible conversation. Matches are painted with the CSS
 * Custom Highlight API, so the page selection and the input's focus are
 * never disturbed.
 */
export function FindBar() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState([]);
  const [index, setIndex] = useState(0);
  const open = ui.overlay === "find";

  useEffect(() => { if (open) inputRef.current?.focus(); else { setQuery(""); highlights?.delete("hatch-find"); highlights?.delete("hatch-find-current"); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const ranges = findRanges(document.querySelector(SCOPE), query.trim());
    setMatches(ranges);
    setIndex(0);
    if (highlights && globalThis.Highlight) highlights.set("hatch-find", new Highlight(...ranges));
  }, [open, query, ui.selection?.conversationId]);
  useEffect(() => {
    const current = matches[index];
    if (!current) { highlights?.delete("hatch-find-current"); return; }
    if (highlights && globalThis.Highlight) highlights.set("hatch-find-current", new Highlight(current));
    current.startContainer.parentElement?.scrollIntoView({ block: "center" });
  }, [matches, index]);

  if (!open) return null;
  const step = direction => setIndex(current => matches.length ? (current + direction + matches.length) % matches.length : 0);
  return <div className="desk-find" role="search">
    <input ref={inputRef} type="search" aria-label={t("find.placeholder")} placeholder={t("find.placeholder")} value={query}
      onChange={event => setQuery(event.target.value)}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        if (event.key === "Escape") { event.preventDefault(); app.closeOverlay(); }
      }} />
    <span className="desk-find__count" aria-live="polite">{query.trim() ? matches.length ? `${index + 1}/${matches.length}` : t("find.noMatch") : ""}</span>
    <button type="button" className="desk-icon-button" aria-label={t("find.previous")} disabled={!matches.length} onClick={() => step(-1)}><ChevronUp aria-hidden="true" /></button>
    <button type="button" className="desk-icon-button" aria-label={t("find.next")} disabled={!matches.length} onClick={() => step(1)}><ChevronDown aria-hidden="true" /></button>
    <button type="button" className="desk-icon-button" aria-label={t("close")} onClick={() => app.closeOverlay()}><X aria-hidden="true" /></button>
  </div>;
}
