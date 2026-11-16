import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAnalytics } from "./analytics/AnalyticsProvider.jsx";
import { ownAgentOpened } from "./analytics/events.js";
import { ArrowUp, X } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { ChatError, ConversationController, FreeChatMeter, resolveCreatorIdentity } from "@hatch/chat";
import { ChatView, TaskBriefDropdown, useChatState } from "@hatch/chat/react";
import { WebChatEgg } from "./webChatGate.jsx";
import { ProductAccessGate, useProductAccess } from "./productAccess.jsx";
import { WebChatShell, useFocusTrap } from "./WebChatShell.jsx";
import { useLocale } from "./locale.jsx";
import { BrowserImageAttachments, UnavailableToolExecutor, WebConversationTransport, browserDictation } from "./webChatClient.js";
import { webChatErrorText, webChatT } from "./webChatI18n.js";
import { WebChatRoute } from "./webChatRoute.js";
import "./webChat.css";

// Web shows thinking and tool activity; skill activity stays Desktop-only for now.
const WEB_ACTIVITY_KINDS = Object.freeze(["thinking", "tool"]);
const attachments = new BrowserImageAttachments();

function WebChatWorkspace({ controller, dictate, access, productId, navigate, profile, onSignOut, t, locale }) {
  const state = useChatState(controller);
  const { conversations, conversationCursor, conversationId, error } = state;
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefAnswers, setBriefAnswers] = useState({});
  const briefTriggerRef = useRef(null);
  const briefDialogRef = useRef(null);
  const errorText = useCallback(cause => webChatErrorText(cause, locale), [locale]);
  const identity = resolveCreatorIdentity({ access });
  const agentName = t("expertAi", { name: identity.creatorName });
  const briefFields = identity.briefSpec?.fields ?? [];
  const selectedConversation = conversations.find(item => item.id === conversationId);

  const selectConversation = useCallback(id => {
    navigate(id ? WebChatRoute.conversationPath(productId, id) : WebChatRoute.productPath(productId));
  }, [navigate, productId]);

  useEffect(() => {
    const firstConversation = conversations[0];
    if (conversationId || !firstConversation) return;
    navigate(WebChatRoute.conversationPath(productId, firstConversation.id), { replace: true });
  }, [conversationId, conversations, navigate, productId]);

  const closeBrief = useCallback(() => setBriefOpen(false), []);
  useFocusTrap(briefOpen, briefDialogRef, "button:not(:disabled), textarea:not(:disabled), input:not(:disabled)", closeBrief);

  useEffect(() => {
    if (!briefOpen) briefTriggerRef.current?.focus({ preventScroll: true });
  }, [briefOpen]);

  const createConversation = async answers => {
    const conversation = await controller.createConversation(answers);
    setBriefOpen(false);
    selectConversation(conversation.id);
  };

  const newConversation = (event, trigger = event?.currentTarget ?? null) => {
    // Once free messages are used up the dock shows the paywall instead.
    if (controller.freeChat.getSnapshot().locked) return;
    if (briefFields.length) {
      briefTriggerRef.current = trigger;
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

  const brief = briefOpen ? <div className="web-chat__brief-backdrop"><form ref={briefDialogRef} className="web-chat__brief" role="dialog" aria-modal="true" aria-labelledby="web-chat-brief-title" onSubmit={submitBrief}>
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
    </form></div> : null;

  return <WebChatShell identity={identity} agentName={agentName} conversations={conversations} selectedId={conversationId} hasMore={Boolean(conversationCursor)}
    onLoadMore={() => void controller.loadMoreConversations().catch(controller.fail)} onSelect={selectConversation} onNew={newConversation} newLabel={t("newChat")}
    headerExtra={selectedConversation?.brief_snapshot ? <TaskBriefDropdown key={conversationId} snapshot={selectedConversation.brief_snapshot} t={t} /> : null}
    inert={briefOpen} profile={profile} onSignOut={onSignOut} t={t} locale={locale} overlay={brief}>
    {header => <ChatView controller={controller} identity={identity} agentName={agentName} t={t} errorText={errorText} attachments={attachments}
      header={header} loadingIndicator={<WebChatEgg size={34} className="web-chat-egg--bob" />} onNewConversation={newConversation}
      activityKinds={WEB_ACTIVITY_KINDS} dictate={dictate} inert={briefOpen} />}
  </WebChatShell>;
}

export default function WebChatPage({ productId, conversationId: routedConversationId, request, navigate, profile, onSignOut }) {
  const { locale } = useLocale();
  const t = useCallback((key, values) => webChatT(locale, key, values), [locale]);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const routedConversationRef = useRef(routedConversationId);
  routedConversationRef.current = routedConversationId;
  const accessState = useProductAccess(productId, request);
  const access = accessState.access;
  const [workspace, setWorkspace] = useState(null);
  const [chatError, setChatError] = useState(null);

  useEffect(() => {
    if (!access) return undefined;
    let live = true;
    setWorkspace(null);
    setChatError(null);
    const controller = new ConversationController({
      // Owned Agents have no entitlement: the Runtime authorizes the owner by product_id.
      transport: new WebConversationTransport(request, access.entitlement_id ? { entitlement_id: access.entitlement_id } : { product_id: productId }),
      attachments,
      tools: new UnavailableToolExecutor(),
      draftScope: productId,
      // Owners chat with their own Agent freely; customers meet the expert's free-chat limit.
      freeChat: new FreeChatMeter(access.entitlement_id ? access.product?.pricing ?? null : null),
      describeError: cause => webChatErrorText(cause, localeRef.current)
    });
    controller.open(routedConversationRef.current ?? "");
    controller.loadLibrary()
      .then(() => { if (live) setWorkspace({ controller, access, dictate: browserDictation(request) }); })
      .catch(cause => { if (live) setChatError(cause); });
    return () => {
      live = false;
      controller.dispose();
    };
  }, [access, productId, request]);

  const analytics = useAnalytics();
  const ownerChat = Boolean(workspace) && !workspace.access.entitlement_id;
  useEffect(() => { if (ownerChat) analytics.track(ownAgentOpened({ agentId: productId })); }, [analytics, ownerChat, productId]);

  useEffect(() => {
    workspace?.controller.open(routedConversationId ?? "");
  }, [workspace, routedConversationId]);

  if (workspace) return <WebChatWorkspace {...workspace} productId={productId} navigate={navigate} profile={profile} onSignOut={onSignOut} t={t} locale={locale} />;
  return <ProductAccessGate state={chatError ? { status: "error", error: chatError } : accessState} productId={productId} navigate={navigate} profile={profile} onSignOut={onSignOut} t={t} locale={locale} />;
}
