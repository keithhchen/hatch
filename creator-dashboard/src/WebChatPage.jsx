import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, ChevronDown, Menu, Plus, RotateCw, X } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { ChatError, ConversationController, resolveCreatorIdentity } from "@hatch/chat";
import { ChatView, CreatorHeading, TaskBriefDropdown, useChatState } from "@hatch/chat/react";
import { WebBrand } from "./WebBrand.jsx";
import { WebChatEgg, WebChatGate } from "./webChatGate.jsx";
import { BuyerAccountMenu } from "./BuyerAccountControls.jsx";
import { useLocale, documentLanguage } from "./locale.jsx";
import { BrowserImageAttachments, UnavailableToolExecutor, WebConversationTransport } from "./webChatClient.js";
import { webChatErrorText, webChatT } from "./webChatI18n.js";
import { WebChatRoute } from "./webChatRoute.js";
import "./webChat.css";

// Web shows thinking and tool activity; skill activity stays Desktop-only for now.
const WEB_ACTIVITY_KINDS = Object.freeze(["thinking", "tool"]);
const attachments = new BrowserImageAttachments();

function conversationDate(value, locale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(documentLanguage(locale), { month: "short", day: "numeric" }).format(date);
}

function WebChatAccountControls({ profile, onSignOut, className = "" }) {
  const { locale } = useLocale();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(null);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      await onSignOut();
    } catch (cause) {
      setError(cause);
    } finally {
      setSigningOut(false);
    }
  }

  return <>
    <div className={`buyer-account-controls buyer-account-controls--chat ${className}`.trim()}>
      <BuyerAccountMenu user={profile} onSignOut={() => void signOut()} signingOut={signingOut} showLanguageOptions showName />
    </div>
    {error ? <p className="web-chat__account-error" role="alert">{webChatErrorText(error, locale)}</p> : null}
  </>;
}

/** Keeps focus inside an open modal surface and closes it on Escape. */
function useFocusTrap(open, containerRef, selector, onEscape, { trapOutside = false } = {}) {
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

function WebChatWorkspace({ controller, access, productId, navigate, profile, onSignOut, t, locale }) {
  const state = useChatState(controller);
  const { conversations, conversationCursor, conversationId, error } = state;
  const [briefOpen, setBriefOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [briefAnswers, setBriefAnswers] = useState({});
  const briefTriggerRef = useRef(null);
  const briefDialogRef = useRef(null);
  const mobileSidebarTriggerRef = useRef(null);
  const mobileSidebarRef = useRef(null);
  const mobileSidebarWasOpenRef = useRef(false);
  const errorText = useCallback(cause => webChatErrorText(cause, locale), [locale]);
  const identity = resolveCreatorIdentity({ access });
  const agentName = t("expertAi", { name: identity.creatorName });
  const briefFields = identity.briefSpec?.fields ?? [];
  const selectedConversation = conversations.find(item => item.id === conversationId);

  const selectConversation = useCallback(id => {
    setMobileSidebarOpen(false);
    navigate(id ? WebChatRoute.conversationPath(productId, id) : WebChatRoute.productPath(productId));
  }, [navigate, productId]);

  useEffect(() => {
    const firstConversation = conversations[0];
    if (conversationId || !firstConversation) return;
    navigate(WebChatRoute.conversationPath(productId, firstConversation.id), { replace: true });
  }, [conversationId, conversations, navigate, productId]);

  const closeBrief = useCallback(() => setBriefOpen(false), []);
  const closeSidebar = useCallback(() => setMobileSidebarOpen(false), []);
  useFocusTrap(briefOpen, briefDialogRef, "button:not(:disabled), textarea:not(:disabled), input:not(:disabled)", closeBrief);
  useFocusTrap(mobileSidebarOpen, mobileSidebarRef, "button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])", closeSidebar, { trapOutside: true });

  useEffect(() => {
    if (!briefOpen) briefTriggerRef.current?.focus({ preventScroll: true });
  }, [briefOpen]);

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

  const createConversation = async answers => {
    const conversation = await controller.createConversation(answers);
    setBriefOpen(false);
    selectConversation(conversation.id);
  };

  const newConversation = event => {
    setMobileSidebarOpen(false);
    if (briefFields.length) {
      briefTriggerRef.current = mobileSidebarWasOpenRef.current && isMobileLayout() ? mobileSidebarTriggerRef.current : event?.currentTarget ?? null;
      setBriefAnswers({});
      setBriefOpen(true);
      return;
    }
    void createConversation().catch(controller.fail);
  };

  const submitBrief = event => {
    event.preventDefault();
    const missing = briefFields.find(field => field.required && !String(briefAnswers[field.id] ?? "").trim());
    if (missing) { controller.fail(new ChatError("missingBriefField", { field: missing.label })); return; }
    void createConversation(briefFields.map(field => ({ field_id: field.id, value: String(briefAnswers[field.id] ?? "") }))).catch(controller.fail);
  };

  const header = <header className="web-chat__header">
    <button type="button" ref={mobileSidebarTriggerRef} className="web-chat__icon-button web-chat__mobile-menu" aria-label={t("openMenu")} aria-expanded={mobileSidebarOpen} aria-controls="web-chat-mobile-sidebar" onClick={() => setMobileSidebarOpen(true)}><Menu aria-hidden="true" /></button>
    <CreatorHeading identity={identity} agentName={agentName} />
    {selectedConversation?.brief_snapshot ? <TaskBriefDropdown key={conversationId} snapshot={selectedConversation.brief_snapshot} t={t} /> : null}
  </header>;

  return <div className="web-chat">
    {mobileSidebarOpen ? <button type="button" className="web-chat__sidebar-backdrop" aria-label={t("closeMenu")} onClick={closeSidebar} /> : null}
    <aside id="web-chat-mobile-sidebar" ref={mobileSidebarRef} className={`web-chat__sidebar${mobileSidebarOpen ? " web-chat__sidebar--mobile-open" : ""}`} role={mobileSidebarOpen ? "dialog" : undefined} aria-modal={mobileSidebarOpen || undefined} aria-label={t("conversationHistory")} inert={briefOpen}>
      <div className="web-chat__sidebar-top">
        <WebBrand href="/explore" className="web-chat__brand" />
        {mobileSidebarOpen ? <button type="button" className="web-chat__icon-button" aria-label={t("closeMenu")} onClick={closeSidebar}><X aria-hidden="true" /></button> : null}
      </div>
      <a href="/library" className="web-chat__back"><ArrowLeft aria-hidden="true" /><span>{t("backToLibrary")}</span></a>
      <button type="button" className="web-chat__new" onClick={newConversation}>
        <Plus aria-hidden="true" /><span>{t("newChat")}</span>
      </button>
      <h2 className="web-chat__section-heading">{t("recentConversations")}</h2>
      <nav className="web-chat__conversation-list" aria-label={t("conversationHistory")}>
        {conversations.map(item => (
          <button type="button" key={item.id} className="web-chat__conversation" aria-pressed={item.id === conversationId} onClick={() => selectConversation(item.id)}>
            <span className="web-chat__conversation-title">{item.title || t("newConversation")}</span>
            <time className="web-chat__conversation-date" dateTime={item.created_at}>{conversationDate(item.created_at, locale)}</time>
          </button>
        ))}
        {conversations.length === 0 ? <p className="web-chat__list-empty">{t("conversationsEmpty")}</p> : null}
        {conversationCursor ? <button type="button" className="web-chat__load-more" onClick={() => void controller.loadMoreConversations().catch(controller.fail)}><span>{t("loadEarlierConversations")}</span><ChevronDown aria-hidden="true" /></button> : null}
      </nav>
      <WebChatAccountControls profile={profile} onSignOut={onSignOut} />
    </aside>
    <ChatView controller={controller} identity={identity} agentName={agentName} t={t} errorText={errorText} attachments={attachments}
      header={header} loadingIndicator={<WebChatEgg size={34} className="web-chat-egg--bob" />} onNewConversation={newConversation}
      activityKinds={WEB_ACTIVITY_KINDS} inert={briefOpen} />
    {briefOpen ? <div className="web-chat__brief-backdrop"><form ref={briefDialogRef} className="web-chat__brief" role="dialog" aria-modal="true" aria-labelledby="web-chat-brief-title" onSubmit={submitBrief}>
      <button type="button" className="web-chat__icon-button web-chat__brief-close" aria-label={t("close")} onClick={closeBrief}><X aria-hidden="true" /></button>
      <div className="web-chat__brief-head"><Avatar src={identity.creatorAvatarUrl} name={identity.creatorName} size="medium" /><span className="web-pill">{agentName}</span></div>
      <h2 id="web-chat-brief-title">{t("startNewTask")}</h2>
      <p className="web-chat__brief-intro">{t("briefIntro", { agent: agentName })}</p>
      {briefFields.map((field, index) => <label key={field.id}>
        <span className="web-chat__brief-label">{field.label}{field.required ? <em>{t("required")}</em> : null}</span>
        <textarea autoFocus={index === 0} required={field.required} maxLength={32000} value={briefAnswers[field.id] ?? ""} onChange={event => setBriefAnswers(current => ({ ...current, [field.id]: event.target.value }))} />
      </label>)}
      {error ? <p className="web-chat__brief-error" role="alert">{errorText(error)}</p> : null}
      <div className="web-chat__brief-actions">
        <button type="button" className="web-chat__button" onClick={closeBrief}>{t("later")}</button>
        <button type="submit" className="web-chat__button web-chat__button--yolk"><span>{t("startConversation")}</span><ArrowUp aria-hidden="true" /></button>
      </div>
    </form></div> : null}
  </div>;
}

export default function WebChatPage({ productId, conversationId: routedConversationId, request, navigate, profile, onSignOut }) {
  const { locale } = useLocale();
  const t = useCallback((key, values) => webChatT(locale, key, values), [locale]);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const routedConversationRef = useRef(routedConversationId);
  routedConversationRef.current = routedConversationId;
  const [workspace, setWorkspace] = useState(null);
  const [publicProduct, setPublicProduct] = useState(null);
  const [status, setStatus] = useState("checkingSubscription");
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    let controller = null;
    setWorkspace(null);
    setPublicProduct(null);
    setError(null);
    setStatus("checkingSubscription");
    request("/v1/user/product-access").then(async payload => {
      const entitlement = payload.creator_agents?.find(entry => entry.product_id === productId);
      if (!entitlement) {
        const detail = await request(`/v1/public/products/${encodeURIComponent(productId)}`);
        if (!detail.product) throw new Error("Public product detail is missing");
        if (live) setPublicProduct(detail.product);
        return;
      }
      controller = new ConversationController({
        transport: new WebConversationTransport(request, { entitlement_id: entitlement.entitlement_id }),
        attachments,
        tools: new UnavailableToolExecutor(),
        draftScope: productId,
        describeError: cause => webChatErrorText(cause, localeRef.current)
      });
      controller.open(routedConversationRef.current ?? "");
      await controller.loadLibrary();
      if (live) setWorkspace({ controller, access: entitlement });
    }).catch(cause => { if (live) { setError(cause); setStatus("unableToOpenChat"); } });
    return () => {
      live = false;
      controller?.dispose();
    };
  }, [productId, request]);

  useEffect(() => {
    workspace?.controller.open(routedConversationId ?? "");
  }, [workspace, routedConversationId]);

  if (workspace) return <WebChatWorkspace {...workspace} productId={productId} navigate={navigate} profile={profile} onSignOut={onSignOut} t={t} locale={locale} />;

  const identity = resolveCreatorIdentity({ product: publicProduct });
  const libraryLink = <a href="/library" className="web-chat__button">{t("backToLibrary")}</a>;
  const account = <WebChatAccountControls profile={profile} onSignOut={onSignOut} />;
  if (error) return <div className="web-chat web-chat--gate">
    <WebChatGate alert account={account} pill={t("unavailablePill")} title={t("unableToOpenChat")} body={webChatErrorText(error, locale)} actions={<>
      {error.code === "agent_unavailable" ? null : <button type="button" className="web-chat__button web-chat__button--ink" onClick={() => location.reload()}><RotateCw aria-hidden="true" />{t("retry")}</button>}
      {libraryLink}
    </>} />
  </div>;
  if (publicProduct) return <div className="web-chat web-chat--gate">
    <WebChatGate account={account} pill={t("noAccessPill")} title={t("noAccessTitle", { name: identity.creatorName })}
      visual={<div className="web-chat__preview">
        <div className="web-chat__preview-head">
          <Avatar src={identity.creatorAvatarUrl} name={identity.creatorName} size="medium" />
          <div><b>{identity.productName}</b><small>{t("expertAi", { name: identity.creatorName })}</small></div>
        </div>
        {identity.promise ? <p className="web-chat__preview-bubble">{identity.promise}</p> : null}
      </div>}
      actions={<>
        <button type="button" className="web-chat__button web-chat__button--yolk" onClick={() => navigate(`/products/${encodeURIComponent(productId)}`)}>{t("subscribeToExpertProduct", { name: identity.creatorName })}</button>
        {libraryLink}
      </>} />
  </div>;
  return <div className="web-chat web-chat--gate"><WebChatGate busy account={account} body={t(status)} /></div>;
}
