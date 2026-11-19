import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Menu, Plus, X } from "lucide-react";
import { CreatorHeading } from "@hatch/chat/react";
import { conversationTitle } from "./webChatI18n.js";
import { WebBrand } from "./WebBrand.jsx";
import { WebChatAccountControls, libraryLink } from "./productAgent.jsx";
import { documentLanguage } from "./locale.jsx";
import "./webChat.css";

function conversationDate(value, locale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(documentLanguage(locale), { month: "short", day: "numeric" }).format(date);
}

/** Keeps focus inside an open modal surface and closes it on Escape. */
export function useFocusTrap(open, containerRef, selector, onEscape, { trapOutside = false } = {}) {
  useEffect(() => {
    if (!open) return undefined;
    const handle = event => {
      if (event.key === "Escape") { onEscape(); return; }
      if (event.key !== "Tab") return;
      const controls = containerRef.current?.querySelectorAll(selector);
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      const outside = trapOutside && !containerRef.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open, containerRef, selector, onEscape, trapOutside]);
}

const isMobileLayout = () => window.matchMedia("(max-width: 760px)").matches;


/**
 * The Product page every conversation type shares: sidebar (brand, back, new, recent list, account), header with the
 * Product's heading, and the main region. `children(header)` renders that main region, which owns where the header goes.
 * A chat fills it with a thread; an artifact fills it with a form or a report.
 */
export function WebChatShell({ identity, agentName, conversations, selectedId, hasMore, onLoadMore, onSelect, onNew, newLabel, headerExtra, inert, overlay, profile, onSignOut, navigate, t, locale, children }) {
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const mobileSidebarTriggerRef = useRef(null);
  const mobileSidebarRef = useRef(null);
  const mobileSidebarWasOpenRef = useRef(false);
  const closeSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  useFocusTrap(mobileSidebarOpen, mobileSidebarRef, "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])", closeSidebar, { trapOutside: true });

  useEffect(() => {
    if (mobileSidebarOpen) {
      mobileSidebarWasOpenRef.current = true;
      mobileSidebarRef.current?.querySelectorAll("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])")?.[0]?.focus({ preventScroll: true });
    } else if (mobileSidebarWasOpenRef.current) {
      mobileSidebarWasOpenRef.current = false;
      if (isMobileLayout()) mobileSidebarTriggerRef.current?.focus({ preventScroll: true });
    }
  }, [mobileSidebarOpen]);

  useEffect(() => {
    const mobileLayout = window.matchMedia("(max-width: 760px)");
    const closeOnDesktop = event => { if (!event.matches) setMobileSidebarOpen(false); };
    mobileLayout.addEventListener("change", closeOnDesktop);
    return () => mobileLayout.removeEventListener("change", closeOnDesktop);
  }, []);

  const back = libraryLink(profile, t);
  const select = id => { setMobileSidebarOpen(false); onSelect(id); };
  const create = event => {
    // Where focus returns when what "new" opens closes again.
    const trigger = mobileSidebarWasOpenRef.current && isMobileLayout() ? mobileSidebarTriggerRef.current : event?.currentTarget ?? null;
    setMobileSidebarOpen(false);
    onNew(event, trigger);
  };

  const header = <header className="web-chat__header">
    <button type="button" ref={mobileSidebarTriggerRef} className="web-chat__icon-button web-chat__mobile-menu" aria-label={t("openMenu")} aria-expanded={mobileSidebarOpen} aria-controls="web-chat-mobile-sidebar" onClick={() => setMobileSidebarOpen(true)}><Menu aria-hidden="true" /></button>
    <CreatorHeading identity={identity} agentName={agentName} />
    {headerExtra}
  </header>;

  return <div className="web-chat">
    {mobileSidebarOpen ? <button type="button" className="web-chat__sidebar-backdrop" aria-label={t("closeMenu")} onClick={closeSidebar} /> : null}
    <aside id="web-chat-mobile-sidebar" ref={mobileSidebarRef} className={`web-chat__sidebar${mobileSidebarOpen ? " web-chat__sidebar--mobile-open" : ""}`} role={mobileSidebarOpen ? "dialog" : undefined} aria-modal={mobileSidebarOpen || undefined} aria-label={t("conversationHistory")} inert={inert}>
      <div className="web-chat__sidebar-top">
        <WebBrand href="/" className="web-chat__brand" />
        {mobileSidebarOpen ? <button type="button" className="web-chat__icon-button" aria-label={t("closeMenu")} onClick={closeSidebar}><X aria-hidden="true" /></button> : null}
      </div>
      <a href={back.href} className="web-chat__back"><ArrowLeft aria-hidden="true" /><span>{back.label}</span></a>
      <button type="button" className="web-chat__new" onClick={create}>
        <Plus aria-hidden="true" /><span>{newLabel}</span>
      </button>
      <h2 className="web-chat__section-heading">{t("recentConversations")}</h2>
      <nav className="web-chat__conversation-list" aria-label={t("conversationHistory")}>
        {conversations.map(item => (
          <button type="button" key={item.id} className="web-chat__conversation" aria-pressed={item.id === selectedId} onClick={() => select(item.id)}>
            <span className="web-chat__conversation-title">{conversationTitle(item, t)}</span>
            <time className="web-chat__conversation-date" dateTime={item.created_at}>{conversationDate(item.created_at, locale)}</time>
          </button>
        ))}
        {conversations.length === 0 ? <p className="web-chat__list-empty">{t("conversationsEmpty")}</p> : null}
        {hasMore ? <button type="button" className="web-chat__load-more" onClick={onLoadMore}><span>{t("loadEarlierConversations")}</span><ChevronDown aria-hidden="true" /></button> : null}
      </nav>
      <WebChatAccountControls profile={profile} onSignOut={onSignOut} navigate={navigate} t={t} />
    </aside>
    {children(header)}
    {overlay}
  </div>;
}
