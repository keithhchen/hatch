import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, ChevronDown, ChevronUp, CircleAlert, Image, LoaderCircle, Menu, Paperclip, Plus, RotateCw, Square, X } from "lucide-react";
import { Avatar, HatchBrand } from "@hatch/ui";
import { WebChatImageViewer } from "./components/WebChatImageViewer.jsx";
import { Shimmer } from "./components/Shimmer.jsx";
import { WebChatThinkingTicker } from "./components/WebChatThinkingTicker.jsx";
import { WebChatMessageResponse } from "./WebChatMessageResponse.jsx";
import { BuyerAccountMenu } from "./BuyerAccountControls.jsx";
import { useLocale, documentLanguage } from "./locale.jsx";
import { BrowserImageAttachments, WebChatClient } from "./webChatClient.js";
import { WebChatPresentationError, webChatErrorText, webChatT } from "./webChatI18n.js";
import { WebChatSnapshotReconciler } from "./webChatSnapshotReconciler.js";
import { groupTimelineEntries, PendingWebSubmission, WebChatTimeline } from "./webChatTimeline.js";
import { WebChatRoute } from "./webChatRoute.js";
import "./webChat.css";

function conversationDate(value, locale) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(documentLanguage(locale), { month: "short", day: "numeric" }).format(date);
}

function isImeConfirmation(event) {
  return event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
}

function TaskBriefDropdown({ snapshot, t }) {
  const detailsRef = useRef(null);
  const [mobilePanelPosition, setMobilePanelPosition] = useState(null);

  const updateMobilePanelPosition = useCallback(() => {
    const details = detailsRef.current;
    if (!details?.open || !window.matchMedia("(max-width: 760px)").matches) {
      setMobilePanelPosition(null);
      return;
    }

    const anchor = details.querySelector("summary").getBoundingClientRect();
    const container = details.getBoundingClientRect();
    const margin = 14;
    const width = Math.min(430, window.innerWidth - margin * 2);
    const height = Math.min(window.innerHeight * 0.66, 560);
    const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
    const top = Math.max(margin, Math.min(anchor.bottom + 10, window.innerHeight - height - margin));
    setMobilePanelPosition({ left: left - container.left, top: top - container.top, width });
  }, []);

  useEffect(() => {
    const closeOnOutsidePointer = event => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target)) {
        details.open = false;
        setMobilePanelPosition(null);
      }
    };
    const closeOnEscape = event => {
      const details = detailsRef.current;
      if (event.key !== "Escape" || !details?.open) return;
      details.open = false;
      setMobilePanelPosition(null);
      details.querySelector("summary")?.focus();
    };
    const reposition = () => updateMobilePanelPosition();
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [updateMobilePanelPosition]);

  if (!snapshot?.fields?.length) return null;
  return <details ref={detailsRef} className="web-chat__task-brief" onToggle={updateMobilePanelPosition}>
    <summary aria-label={t("taskBrief")}><span>{t("taskBrief")}</span><ChevronDown aria-hidden="true" /></summary>
    <div className="web-chat__task-brief-panel" style={mobilePanelPosition ? { left: `${mobilePanelPosition.left}px`, top: `${mobilePanelPosition.top}px`, width: `${mobilePanelPosition.width}px` } : undefined} role="group" aria-label={t("taskBrief")}><dl className="web-chat__task-brief-fields">
      {snapshot.fields.map(field => <div className="web-chat__task-brief-field" key={field.id}>
        <dt>{field.label}</dt>
        <dd>{field.value || t("notProvided")}</dd>
      </div>)}
    </dl></div>
  </details>;
}

function WebChatAccountControls({ profile, navigate, onSignOut, className = "" }) {
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
      <BuyerAccountMenu user={profile} onSignOut={() => void signOut()} signingOut={signingOut} showLanguageOptions />
    </div>
    {error ? <p className="web-chat__account-error" role="alert">{webChatErrorText(error, locale)}</p> : null}
  </>;
}

function WebChatTimelineEntry({ entry, client, conversationId, locale, t, isAnimating = false, isLastItem = true }) {
  if (entry.kind === "text") {
    return <div className="web-chat__content" key={entry.id}><WebChatMessageResponse isAnimating={isAnimating}>{entry.content}</WebChatMessageResponse></div>;
  }
  if (entry.kind === "status") {
    return <div className="web-chat__runtime-status" key={entry.id}><span>{entry.content}</span></div>;
  }
  if (entry.kind === "activity_group") return <WebChatActivityModal key={entry.id} entries={entry.entries} isLastItem={isLastItem} client={client} conversationId={conversationId} locale={locale} t={t} />;
  if (entry.kind === "thinking" || entry.kind === "tool") return <WebChatActivityModal key={entry.id} entries={[entry]} isLastItem={isLastItem} client={client} conversationId={conversationId} locale={locale} t={t} />;
  return <WebChatActivityBlock key={entry.id} entry={entry} client={client} conversationId={conversationId} locale={locale} t={t} />;
}

function WebChatActivityModal({ entries, isLastItem, client, conversationId, locale, t }) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const dialogRef = useRef(null);
  const lastEntry = entries.at(-1);
  const lastPresentation = activityPresentations[lastEntry.kind](lastEntry, { locale, t });
  const triggerTitle = isLastItem ? lastPresentation.title : t("activityProcessed");
  const thinkingPreview = isLastItem && lastEntry.kind === "thinking" ? lastEntry.content : "";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return <>
    <button type="button" className={`web-chat__activity-trigger${isLastItem ? "" : " web-chat__activity-trigger--processed"}`} aria-haspopup="dialog" onClick={() => { setHasOpened(true); setOpen(true); }}>
      {isLastItem
        ? <span className="web-chat__activity-trigger-label"><Shimmer as="span" className="web-chat__activity-trigger-title">{triggerTitle}</Shimmer>{thinkingPreview ? <WebChatThinkingTicker content={thinkingPreview} /> : null}</span>
        : <span className="web-chat__activity-trigger-label"><span>{triggerTitle}</span></span>}
    </button>
    <dialog ref={dialogRef} className="web-chat__activity-modal" aria-label={t("activityDetails")} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <header className="web-chat__activity-modal-header">
        <h2>{t("activityDetails")}</h2>
        <button type="button" aria-label={t("close")} onClick={() => setOpen(false)}><X aria-hidden="true" /></button>
      </header>
      {hasOpened ? <div className="web-chat__activity-modal-items">
        {entries.map(activity => <WebChatActivityBlock key={activity.id} entry={activity} client={client} conversationId={conversationId} locale={locale} t={t} />)}
      </div> : null}
    </dialog>
  </>;
}

const activityPresentations = Object.freeze({
  thinking: (entry, { t }) => ({
    title: t(entry.streaming ? "thinkingRunningTitle" : "thinkingCompleteTitle")
  }),
  tool: (entry, { t }) => {
    const titleKeys = {
      requested: "toolRunningTitle",
      completed: "toolCompleteTitle",
      failed: "toolFailedTitle",
      cancelled: "toolCancelledTitle"
    };
    return {
      title: t(titleKeys[entry.status] ?? "toolRunningTitle", { name: entry.title })
    };
  }
});

function WebChatActivityBlock({ entry, client, conversationId, locale, t }) {
  const present = activityPresentations[entry.kind];
  if (!present) throw new Error(`Unsupported Web Chat activity kind: ${entry.kind}`);
  const presentation = present(entry, { locale, t });
  return <details className="web-chat__activity-block">
    <summary className="web-chat__activity-heading">
      <strong>{presentation.title}</strong>
      <ChevronDown aria-hidden="true" />
    </summary>
    {entry.content ? <div className="web-chat__activity-content">{entry.kind === "thinking"
      ? entry.content
      : <WebChatToolDetails content={entry.content} status={entry.status} client={client} conversationId={conversationId} locale={locale} t={t} />}</div> : null}
  </details>;
}

function WebChatToolDetails({ content, status, client, conversationId, locale, t }) {
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
    client.toolDetail(conversationId, detailRunId, detailToolCallId).then(payload => {
      if (active) setDetail(payload.tool);
    }).catch(cause => {
      if (active) setDetailError(cause.message);
    }).finally(() => {
      if (active) setDetailLoading(false);
    });
    return () => { active = false; };
  }, [client, conversationId, detailRunId, detailToolCallId, content.result, content.error, status]);
  const argumentsValue = detail?.arguments ?? content.arguments;
  const resultValue = detail?.result ?? content.result;
  return <>
    {content.error ? <p className="web-chat__tool-error">{webChatErrorText(content.error, locale)}</p> : null}
    {detailLoading ? <span role="status">{t("loadingToolDetails")}</span> : null}
    {detailError ? <span role="alert">{detailError}</span> : null}
    <div>{t("arguments")}: {JSON.stringify(argumentsValue ?? {}, null, 2)}</div>
    {resultValue !== undefined ? <div>{t("result")}: {JSON.stringify(resultValue, null, 2)}</div> : null}
  </>;
}

export default function WebChatPage({ productId, conversationId: routedConversationId, request, navigate, profile, onSignOut }) {
  const { locale } = useLocale();
  const t = useCallback((key, values) => webChatT(locale, key, values), [locale]);
  const [access, setAccess] = useState(null);
  const [publicProduct, setPublicProduct] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationCursor, setConversationCursor] = useState(null);
  const conversationId = routedConversationId ?? "";
  const [messages, setMessages] = useState([]);
  const [snapshotConversationId, setSnapshotConversationId] = useState(null);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState([]);
  const [status, setStatus] = useState({ key: "loading" });
  const [error, setError] = useState(null);
  const [activeRun, setActiveRun] = useState(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [snapshotRetryVersion, setSnapshotRetryVersion] = useState(0);
  const [liveTimeline, setLiveTimeline] = useState([]);
  const [briefOpen, setBriefOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [briefAnswers, setBriefAnswers] = useState({});
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const socketRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const runRef = useRef(null);
  const pendingSubmissionRef = useRef(null);
  const taskStartRef = useRef(null);
  const liveTimelineRef = useRef(new WebChatTimeline());
  const visibleMessagesRef = useRef([]);
  const snapshotReconcilerRef = useRef(new WebChatSnapshotReconciler());
  const conversationGenerationRef = useRef(0);
  const terminalRunRef = useRef(null);
  const messagesRef = useRef(null);
  const draftRef = useRef(null);
  const briefTriggerRef = useRef(null);
  const briefDialogRef = useRef(null);
  const mobileSidebarTriggerRef = useRef(null);
  const mobileSidebarRef = useRef(null);
  const mobileSidebarWasOpenRef = useRef(false);
  const followOutputRef = useRef(true);

  const client = useMemo(() => access ? new WebChatClient(request, access.entitlement_id) : null, [access, request]);
  const selectConversation = useCallback(id => {
    setMobileSidebarOpen(false);
    navigate(id ? WebChatRoute.conversationPath(productId, id) : WebChatRoute.productPath(productId));
  }, [navigate, productId]);
  const updateMessages = useCallback(update => {
    const next = typeof update === "function" ? update(visibleMessagesRef.current) : update;
    visibleMessagesRef.current = next;
    setMessages(next);
    return next;
  }, []);

  const updateLiveTimeline = useCallback(update => {
    const items = update(liveTimelineRef.current);
    const runId = runRef.current?.id;
    setLiveTimeline(items);
    updateMessages(current => current.map(message => message.transient && message.run_id === runId
      ? { ...message, timeline: items }
      : message));
  }, [updateMessages]);

  const statusText = status.text ?? t(status.key);
  const errorText = webChatErrorText(error, locale);
  const snapshotPending = Boolean(conversationId && snapshotConversationId !== conversationId);
  const refresh = useCallback(async (id) => {
    const generation = conversationGenerationRef.current;
    const snapshot = await client.snapshot(id);
    if (conversationRef.current !== id || generation !== conversationGenerationRef.current) {
      return { snapshot, messages: visibleMessagesRef.current, stale: true };
    }
    if (snapshot.conversation?.id !== id) throw new WebChatPresentationError("historyIdentityMismatch");
    const reconciliation = snapshotReconcilerRef.current.reconcile(id, visibleMessagesRef.current, snapshot);
    if (!reconciliation.accepted) return { snapshot, messages: reconciliation.messages, stale: true };
    setSnapshotConversationId(id);
    const snapshotConversation = snapshot.conversation;
    setConversations(current => current.some(item => item.id === id)
      ? current.map(item => item.id === id ? { ...item, ...snapshotConversation } : item)
      : [snapshotConversation, ...current]);
    setHistoryCursor(current => current ?? snapshot.before_cursor ?? null);
    const running = snapshot.runs?.find(run => ["queued", "running", "waiting_for_tool", "waiting_for_approval"].includes(run.status));
    let projectedMessages = reconciliation.messages;
    if (running && !projectedMessages.some(message => message.run_id === running.id && message.role === "assistant")) {
      projectedMessages = updateMessages([...projectedMessages, WebChatTimeline.streamingAssistantMessage(running.id)]);
      if (runRef.current?.id !== running.id) runRef.current = { id: running.id };
    } else {
      updateMessages(projectedMessages);
    }
    const terminal = terminalRunRef.current;
    const terminalMessage = terminal && projectedMessages.some(message => (
      message.run_id === terminal.id && message.role === "assistant" && !message.transient
    ));
    if (terminalMessage) {
      terminalRunRef.current = null;
      liveTimelineRef.current.reset();
      setLiveTimeline([]);
      setActiveRun(running?.id ?? null);
      setStatus({ key: running ? "agentReplying" : "connected" });
    } else if (terminal?.failed) {
      terminalRunRef.current = null;
      updateMessages(current => current.filter(message => !(message.transient && message.run_id === terminal.id && message.role === "assistant")));
      liveTimelineRef.current.reset();
      setLiveTimeline([]);
      setActiveRun(running?.id ?? null);
      setStatus({ key: running ? "agentReplying" : "connected" });
    } else if (terminal) {
      setActiveRun(terminal.id);
      setStatus({ key: "syncingReply" });
    } else {
      setActiveRun(running?.id ?? null);
      setStatus({ key: running ? "agentReplying" : "connected" });
    }
    return { snapshot, messages: projectedMessages, stale: false };
  }, [client, updateMessages]);

  const restoreSubmission = useCallback((submission, preservePending = false) => {
    if (!submission) return;
    updateMessages(current => current.filter(message => message.id !== submission.optimisticMessageId
      && !(message.transient && message.run_id === submission.runId && message.role === "assistant")));
    setDraft(submission.content);
    setImages(submission.imageFiles);
    if (runRef.current?.id === submission.runId) runRef.current = null;
    if (!preservePending && pendingSubmissionRef.current === submission) pendingSubmissionRef.current = null;
    liveTimelineRef.current.reset();
    setLiveTimeline([]);
    setActiveRun(null);
  }, [updateMessages]);

  useEffect(() => {
    let live = true;
    setAccess(null);
    setPublicProduct(null);
    setError(null);
    setConversations([]);
    setSnapshotConversationId(null);
    setStatus({ key: "checkingSubscription" });
    request("/v1/user/product-access").then(async payload => {
      const entitlement = payload.creator_agents?.find(entry => entry.product_id === productId);
      if (!entitlement) {
        const detail = await request(`/v1/public/products/${encodeURIComponent(productId)}`);
        if (!detail.product) throw new Error("Public product detail is missing");
        if (live) setPublicProduct(detail.product);
        return;
      }
      const page = await new WebChatClient(request, entitlement.entitlement_id).list();
      if (!live) return;
      setAccess(entitlement);
      setConversations(page.conversations ?? []);
      setConversationCursor(page.next_cursor ?? null);
      setStatus({ key: conversationRef.current || page.conversations?.length ? "loadingConversation" : "startChatToBegin" });
    }).catch(cause => { if (live) { setError(cause); setStatus({ key: "unableToOpenChat" }); } });
    return () => { live = false; };
  }, [productId, request]);

  useEffect(() => {
    const firstConversation = conversations[0];
    if (!access || conversationId || !firstConversation) return;
    navigate(WebChatRoute.conversationPath(productId, firstConversation.id), { replace: true });
  }, [access, conversationId, conversations, navigate, productId]);

  useEffect(() => {
    if (!client || !conversationId) return undefined;
    let live = true;
    conversationGenerationRef.current += 1;
    reconnectAttemptsRef.current = 0;
    runRef.current = null;
    terminalRunRef.current = null;
    snapshotReconcilerRef.current.reset(conversationId);
    liveTimelineRef.current.reset();
    setLiveTimeline([]);
    setHistoryCursor(null);
    setSnapshotConversationId(null);
    updateMessages([]);
    setActiveRun(null);
    setError(null);
    setStatus({ key: "loadingConversation" });
    void refresh(conversationId).catch(cause => {
      if (live && conversationRef.current === conversationId) setError(cause);
    });
    return () => { live = false; };
  }, [client, conversationId, refresh, snapshotRetryVersion, updateMessages]);

  useEffect(() => {
    if (!access || !client || !conversationId || snapshotConversationId !== conversationId) return undefined;
    let live = true;
    if (reconnectTimerRef.current) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const connection = client.openRuntime(conversationId);
    const socket = connection.socket;
    socketRef.current = connection;
    socket.onopen = () => connection.hello();
    socket.onmessage = async event => {
      const message = JSON.parse(event.data);
      if (message.type === "tool_call.request") {
        if (message.run_id === runRef.current?.id) {
          const failedTool = { ...message, locality: "client", status: "failed", error: { code: "web_local_tool_unavailable" } };
          updateLiveTimeline(timeline => timeline.upsertTool(failedTool));
          connection.toolResult(message.run_id, message.tool_call_id, { ...failedTool.error, message: webChatErrorText(failedTool.error, localeRef.current) });
        }
        return;
      }
      if (message.type === "session.ready") {
        if (message.conversation_id !== conversationId) { socket.close(); setError(new WebChatPresentationError("conversationIdentityMismatch")); return; }
        reconnectAttemptsRef.current = 0;
        try {
          const pending = pendingSubmissionRef.current;
          if (pending?.conversationId === conversationId) {
            updateMessages(current => {
              const withUser = current.some(entry => entry.run_id === pending.runId && entry.role === "user")
                ? current
                : [...current, pending.optimisticMessage()];
              return withUser.some(entry => entry.transient && entry.run_id === pending.runId && entry.role === "assistant")
                ? withUser
                : [...withUser, WebChatTimeline.streamingAssistantMessage(pending.runId)];
            });
            runRef.current = { id: pending.runId };
            connection.message({ runId: pending.runId, clientMessageId: pending.clientMessageId, content: pending.content, attachments: pending.attachments });
            setActiveRun(pending.runId);
            setStatus({ key: "sending" });
          }
          if (taskStartRef.current === conversationId) {
            taskStartRef.current = null;
            const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
            runRef.current = { id: runId };
            liveTimelineRef.current.reset();
            setLiveTimeline([]);
            updateMessages(current => [...current, WebChatTimeline.streamingAssistantMessage(runId)]);
            setActiveRun(runId);
            setStatus({ key: "sending" });
            connection.message({ runId, clientMessageId: `message_${crypto.randomUUID().replaceAll("-", "")}`, taskStart: true });
          }
        } catch (cause) { if (live) setError(cause); }
        return;
      }
      if (message.type === "message.accepted" && message.run_id === runRef.current?.id) {
        const submission = pendingSubmissionRef.current;
        pendingSubmissionRef.current = null;
        if (submission) updateMessages(current => current.map(entry => entry.id === submission.optimisticMessageId ? { ...entry, optimistic: false, provisional: true } : entry));
        setDraft(""); setImages([]);
        return;
      }
      if (message.type === "assistant.delta" && message.run_id === runRef.current?.id) {
        if (message.delta?.kind === "text") {
          updateLiveTimeline(timeline => timeline.appendText(message.delta.content));
          setStatus({ key: "agentReplying" });
        } else if (message.delta?.kind === "thinking_start") {
          updateLiveTimeline(timeline => timeline.startThinking(message.delta.contentIndex));
          setStatus({ key: "agentReplying" });
        } else if (message.delta?.kind === "thinking_delta") {
          updateLiveTimeline(timeline => timeline.appendThinking(message.delta.contentIndex, message.delta.delta));
          setStatus({ key: "agentReplying" });
        } else if (message.delta?.kind === "thinking_end") {
          updateLiveTimeline(timeline => timeline.finishThinking(message.delta.contentIndex, message.delta.content));
        } else if (message.delta?.kind === "status" && message.delta.content) {
          if (!liveTimelineRef.current.isRedundantToolStatus(message.delta.content)) {
            updateLiveTimeline(timeline => timeline.updateRuntimeStatus(message.delta.content));
            setStatus({ text: message.delta.content });
          }
        }
        return;
      }
      if (message.type === "tool_call.delta" && message.run_id === runRef.current?.id) {
        updateLiveTimeline(timeline => timeline.upsertTool(message));
        return;
      }
      if ((message.type === "approval.request" || message.type === "approval.result") && message.run_id === runRef.current?.id) {
        const toolStatus = message.type === "approval.request" ? "requested" : message.status === "denied" ? "failed" : "requested";
        const approvalTool = {
          ...message,
          locality: "client",
          status: message.type === "approval.request" ? "failed" : toolStatus,
          ...(message.type === "approval.request" ? { error: { code: "browser_approval_unavailable" } } : {}),
          ...(message.status === "denied" ? { error: message.reason ? { message: message.reason } : { code: "approval_denied" } } : {})
        };
        updateLiveTimeline(timeline => timeline.upsertTool(approvalTool));
        if (message.type === "approval.request") connection.toolResult(message.run_id, message.tool_call_id, { ...approvalTool.error, message: webChatErrorText(approvalTool.error, localeRef.current) });
        return;
      }
      if ((message.type === "turn.completed" || message.type === "turn.failed") && message.run_id === runRef.current?.id) {
        const pending = pendingSubmissionRef.current;
        if (pending?.runId === message.run_id) restoreSubmission(pending);
        else terminalRunRef.current = { id: message.run_id, failed: message.type === "turn.failed" };
        runRef.current = null;
        if (message.type === "turn.failed") setError(message.error ?? new WebChatPresentationError("replyFailed"));
        if (!pending) {
          setActiveRun(message.run_id);
          setStatus({ key: "syncingReply" });
        }
        try { await refresh(conversationId); } catch (cause) { if (live) setError(cause); }
        return;
      }
      if (message.type === "session.error") {
        const pending = pendingSubmissionRef.current;
        if (pending?.runId === runRef.current?.id) restoreSubmission(pending);
        setError(message.error ?? new WebChatPresentationError("connectionFailed"));
      }
    };
    socket.onclose = () => {
      if (!live) return;
      const pending = pendingSubmissionRef.current;
      if (pending?.conversationId === conversationId) restoreSubmission(pending, true);
      if (socketRef.current === connection) socketRef.current = null;
      if (reconnectAttemptsRef.current >= 3) return;
      const attempt = ++reconnectAttemptsRef.current;
      const delay = Math.round(400 * (2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5));
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (live && conversationRef.current === conversationId) setConnectionVersion(value => value + 1);
      }, delay);
    };
    return () => {
      live = false;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      connection.close();
      if (socketRef.current === connection) socketRef.current = null;
    };
  }, [access, client, conversationId, snapshotConversationId, refresh, connectionVersion, restoreSubmission, updateLiveTimeline, updateMessages]);

  useEffect(() => {
    const composer = draftRef.current;
    if (composer) {
      const maxHeight = Number.parseFloat(window.getComputedStyle(composer).maxHeight);
      const heightLimit = Number.isFinite(maxHeight) ? maxHeight : 190;
      composer.style.height = "auto";
      composer.style.height = `${Math.min(composer.scrollHeight, heightLimit)}px`;
      composer.style.overflowY = composer.scrollHeight > heightLimit ? "auto" : "hidden";
    }
    const viewport = messagesRef.current;
    if (viewport && followOutputRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, status, liveTimeline, draft]);

  useEffect(() => {
    if (!briefOpen) {
      briefTriggerRef.current?.focus({ preventScroll: true });
      return undefined;
    }
    const closeOnEscape = event => {
      if (event.key === "Escape") {
        setBriefOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = briefDialogRef.current?.querySelectorAll("button:not(:disabled), textarea:not(:disabled), input:not(:disabled)");
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [briefOpen]);

  useEffect(() => {
    if (!mobileSidebarOpen) {
      if (mobileSidebarWasOpenRef.current) {
        mobileSidebarWasOpenRef.current = false;
        if (window.matchMedia("(max-width: 760px)").matches) {
          mobileSidebarTriggerRef.current?.focus({ preventScroll: true });
        }
      }
      return undefined;
    }
    mobileSidebarWasOpenRef.current = true;
    const controls = mobileSidebarRef.current?.querySelectorAll("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])");
    controls?.[0]?.focus({ preventScroll: true });
    const closeOnEscape = event => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
      if (event.key !== "Tab") return;
      const focusable = mobileSidebarRef.current?.querySelectorAll("button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])");
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !mobileSidebarRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !mobileSidebarRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileSidebarOpen]);

  useEffect(() => {
    const mobileLayout = window.matchMedia("(max-width: 760px)");
    const closeOnDesktop = event => {
      if (!event.matches) setMobileSidebarOpen(false);
    };
    mobileLayout.addEventListener("change", closeOnDesktop);
    return () => mobileLayout.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!activeRun || !conversationId || runRef.current?.id === activeRun) return undefined;
    const timer = setInterval(() => { void refresh(conversationId).catch(cause => setError(cause)); }, 2000);
    return () => clearInterval(timer);
  }, [activeRun, conversationId, refresh]);

  const createConversation = async (briefAnswersInput) => {
    if (!access) return;
    setError(null);
    const result = await client.create(briefAnswersInput);
    setConversations(current => [result.conversation, ...current]);
    if (briefAnswersInput) taskStartRef.current = result.conversation.id;
    setBriefOpen(false);
    selectConversation(result.conversation.id);
  };

  const newConversation = event => {
    setMobileSidebarOpen(false);
    const fields = access?.brief_spec?.fields ?? access?.product?.brief_spec?.fields;
    if (fields?.length) {
      briefTriggerRef.current = mobileSidebarWasOpenRef.current && window.matchMedia("(max-width: 760px)").matches
        ? mobileSidebarTriggerRef.current
        : event?.currentTarget ?? null;
      setBriefAnswers({});
      setBriefOpen(true);
      return;
    }
    void createConversation().catch(cause => setError(cause));
  };

  const submitBrief = event => {
    event.preventDefault();
    const fields = access?.brief_spec?.fields ?? access?.product?.brief_spec?.fields ?? [];
    const missing = fields.find(field => field.required && !String(briefAnswers[field.id] ?? "").trim());
    if (missing) { setError(new WebChatPresentationError("missingBriefField", { field: missing.label })); return; }
    void createConversation(fields.map(field => ({ field_id: field.id, value: String(briefAnswers[field.id] ?? "") }))).catch(cause => setError(cause));
  };

  const loadHistory = async () => {
    if (!historyCursor) return;
    followOutputRef.current = false;
    const page = await client.history(conversationId, historyCursor);
    updateMessages(current => [...(page.messages ?? []), ...current]);
    setHistoryCursor(page.before_cursor ?? null);
  };

  const loadConversations = async () => {
    if (!conversationCursor) return;
    const page = await client.list(conversationCursor);
    setConversations(current => [...current, ...(page.conversations ?? []).filter(entry => !current.some(existing => existing.id === entry.id))]);
    setConversationCursor(page.next_cursor ?? null);
  };

  const send = async event => {
    event.preventDefault();
    if (!conversationId || snapshotPending || !access || activeRun || (!draft.trim() && images.length === 0)) return;
    const connection = socketRef.current;
    followOutputRef.current = true;
    setError(null);
    try {
      const pending = pendingSubmissionRef.current?.conversationId === conversationId ? pendingSubmissionRef.current : null;
      const imageFiles = pending?.imageFiles ?? [...images];
      const attachments = pending ? pending.attachments : await BrowserImageAttachments.prepareAll(imageFiles);
      const runId = pending?.runId ?? `run_${crypto.randomUUID().replaceAll("-", "")}`;
      const clientMessageId = pending?.clientMessageId ?? `message_${crypto.randomUUID().replaceAll("-", "")}`;
      const content = pending?.content ?? draft;
      const submission = pending ?? new PendingWebSubmission({ conversationId, runId, clientMessageId, content, attachments, imageFiles });
      runRef.current = { id: runId };
      pendingSubmissionRef.current = submission;
      updateMessages(current => {
        const next = current.some(message => message.id === submission.optimisticMessageId)
          ? current
          : [...current, submission.optimisticMessage()];
        return next.some(message => message.transient && message.run_id === runId && message.role === "assistant")
          ? next
          : [...next, WebChatTimeline.streamingAssistantMessage(runId)];
      });
      liveTimelineRef.current.reset();
      setLiveTimeline([]);
      setDraft("");
      setImages([]);
      if (connection?.ready) {
        connection.message({ runId, clientMessageId, content, attachments });
      } else {
        if (reconnectTimerRef.current) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        reconnectAttemptsRef.current = 0;
        setConnectionVersion(value => value + 1);
      }
      setActiveRun(runId);
      setStatus({ key: "sending" });
    } catch (cause) {
      const pending = pendingSubmissionRef.current;
      if (pending?.conversationId === conversationId) restoreSubmission(pending);
      setError(cause);
    }
  };

  const cancel = () => {
    if (!runRef.current || !socketRef.current?.ready) return;
    socketRef.current.cancel(runRef.current.id);
    setStatus({ key: "stopping" });
  };

  const product = access?.product ?? publicProduct;
  const name = product?.name ?? product?.product_name ?? product?.product?.name ?? access?.product_name ?? "Expert Agent";
  const creator = access?.creator ?? product?.creator ?? { name: product?.creator_name ?? "Hatch Expert" };
  const creatorName = creator.name ?? creator.display_name ?? product?.creator_name ?? "Hatch Expert";
  const creatorAvatarUrl = creator.avatar_url ?? access?.creator_avatar_url ?? product?.creator_avatar_url;
  const selectedConversation = conversations.find(item => item.id === conversationId);
  return <div className="web-chat" aria-busy={!access && !publicProduct && !error}>
    {mobileSidebarOpen ? <button type="button" className="web-chat__sidebar-backdrop" aria-label={t("closeMenu")} onClick={() => setMobileSidebarOpen(false)} /> : null}
    <aside id="web-chat-mobile-sidebar" ref={mobileSidebarRef} className={`web-chat__sidebar${mobileSidebarOpen ? " web-chat__sidebar--mobile-open" : ""}`} role={mobileSidebarOpen ? "dialog" : undefined} aria-modal={mobileSidebarOpen || undefined} aria-label={t("conversationHistory")} inert={briefOpen}>
      <div className="web-chat__sidebar-top">
        <HatchBrand className="web-chat__brand" logoVariant="lockup" />
        <a href="/library" className="web-chat__back" aria-label={t("backToLibrary")}><ArrowLeft aria-hidden="true" /><span>{t("backToLibrary")}</span></a>
      </div>
      <button type="button" className="web-chat__new" aria-label={t("newChat")} onClick={newConversation} disabled={!access}>
        <Plus aria-hidden="true" /><span>{t("newChat")}</span>
      </button>
      <div className="web-chat__section-heading"><span>{t("recentConversations")}</span></div>
      <nav className="web-chat__conversation-list" aria-label={t("conversationHistory")}>
        {conversations.map(item => (
          <button type="button" key={item.id} className="web-chat__conversation" aria-pressed={item.id === conversationId} onClick={() => { followOutputRef.current = true; selectConversation(item.id); }}>
            <span className="web-chat__conversation-title">{item.title || t("newConversation")}</span>
            <time className="web-chat__conversation-date" dateTime={item.created_at}>{conversationDate(item.created_at, locale)}</time>
          </button>
        ))}
        {conversations.length === 0 && access ? <p className="web-chat__list-empty">{t("conversationsEmpty")}</p> : null}
      </nav>
      {conversationCursor ? <button type="button" className="web-chat__load-more" onClick={() => void loadConversations().catch(cause => setError(cause))}><span>{t("loadEarlierConversations")}</span><ChevronDown aria-hidden="true" /></button> : null}
      <WebChatAccountControls profile={profile} navigate={navigate} onSignOut={onSignOut} />
    </aside>
    <header className="web-chat__mobile-topbar" inert={briefOpen}>
      <button type="button" ref={mobileSidebarTriggerRef} className="web-chat__mobile-menu" aria-label={t("openMenu")} aria-expanded={mobileSidebarOpen} aria-controls="web-chat-mobile-sidebar" onClick={() => setMobileSidebarOpen(true)}><Menu aria-hidden="true" /></button>
      <HatchBrand className="web-chat__mobile-brand" logoVariant="lockup" />
    </header>
    <div className="web-chat__mobile-conversation-bar" inert={briefOpen}>
      <div className="web-chat__mobile-agent">
        <Avatar className="web-chat__heading-avatar" src={creatorAvatarUrl} name={creatorName} size="medium" />
        <h1>{name}</h1>
      </div>
      {selectedConversation?.brief_snapshot ? <div className="web-chat__mobile-task-brief"><TaskBriefDropdown key={conversationId} snapshot={selectedConversation.brief_snapshot} t={t} /></div> : null}
    </div>
    <main className={`web-chat__main${error && access ? " web-chat__main--error" : ""}`} inert={briefOpen}>
      <header className="web-chat__header">
        <div className="web-chat__heading-copy"><Avatar className="web-chat__heading-avatar" src={creatorAvatarUrl} name={creatorName} size="medium" /><h1>{name}</h1></div>
        {selectedConversation?.brief_snapshot ? <div className="web-chat__header-tools"><TaskBriefDropdown key={conversationId} snapshot={selectedConversation.brief_snapshot} t={t} /></div> : null}
      </header>
      {error && access ? <div className="web-chat__error" role="alert"><CircleAlert aria-hidden="true" /><span>{errorText}</span><button type="button" onClick={() => { setError(null); if (snapshotPending) setSnapshotRetryVersion(value => value + 1); else setConnectionVersion(value => value + 1); }}><RotateCw aria-hidden="true" /><span>{t("retry")}</span></button></div> : null}
      <div className="web-chat__messages" ref={messagesRef} onScroll={event => { const element = event.currentTarget; followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 112; }} aria-label={t("chatMessages")}>
        {!snapshotPending && historyCursor ? <button type="button" className="web-chat__history" onClick={() => void loadHistory().catch(cause => setError(cause))}><span>{t("viewEarlierMessages")}</span><ChevronUp aria-hidden="true" /></button> : null}
        {!access && !publicProduct && !error ? <div className="web-chat__gate" role="status"><LoaderCircle aria-hidden="true" /><span>{statusText}</span></div> : null}
        {!access && error ? <div className="web-chat__gate web-chat__gate--error" role="alert"><CircleAlert aria-hidden="true" /><h2>{t("unableToOpenChat")}</h2><p>{errorText}</p><button type="button" onClick={() => location.reload()}><RotateCw aria-hidden="true" /><span>{t("retry")}</span></button></div> : null}
        {access && snapshotPending && !error ? <div className="web-chat__gate" role="status"><LoaderCircle aria-hidden="true" /><span>{t("loadingConversation")}</span></div> : null}
        {(access || publicProduct) && (!access || !conversationId) && messages.length === 0 && !activeRun ? <div className="web-chat__empty">
          <span className="web-chat__empty-avatar-frame"><Avatar className="web-chat__empty-avatar" src={creatorAvatarUrl} name={creatorName} size="large" /></span>
          <h2>{name}</h2>
          {product?.promise ? <p>{product.promise}</p> : null}
          {access
            ? <button type="button" className="web-chat__empty-action" onClick={newConversation}><Plus aria-hidden="true" />{t("startConversation")}</button>
            : <button type="button" className="web-chat__empty-action" onClick={() => navigate(`/products/${encodeURIComponent(productId)}`)}>{t("subscribeToExpertProduct", { name: creatorName })}</button>}
        </div> : null}
        {!snapshotPending ? messages.map(message => <article className={`web-chat__message web-chat__message--${message.role}`} key={message.renderKey ?? `${message.run_id}-${message.role}`}>
          <div className="web-chat__message-body">
            {message.role === "assistant"
                ? message.transient
                  ? message.timeline?.length
                  ? groupTimelineEntries(message.timeline).map((entry, index, timeline) => <WebChatTimelineEntry key={entry.id} entry={entry} isLastItem={index === timeline.length - 1} client={client} conversationId={conversationId} locale={locale} t={t} isAnimating />)
                  : <div className="web-chat__working"><LoaderCircle aria-hidden="true" />{statusText}</div>
                : groupTimelineEntries(WebChatTimeline.fromHistory(message)).map((entry, index, timeline) => <WebChatTimelineEntry key={entry.id} entry={entry} isLastItem={index === timeline.length - 1} client={client} conversationId={conversationId} locale={locale} t={t} />)
              : <div className="web-chat__content"><WebChatMessageResponse>{message.content || ""}</WebChatMessageResponse></div>}
            {message.attachments?.some(item => !BrowserImageAttachments.accepts(item.media_type)) ? <div className="web-chat__attachments">{message.attachments.filter(item => !BrowserImageAttachments.accepts(item.media_type)).map(item => <span key={item.attachment_id}><Paperclip aria-hidden="true" />{item.display_name}</span>)}</div> : null}
            {!message.optimistic && message.attachments?.filter(item => BrowserImageAttachments.accepts(item.media_type) && item.asset_id).map(item => {
              const src = client.assetUrl(conversationId, item.asset_id);
              return <WebChatImageViewer key={item.attachment_id} src={src} alt={item.display_name} title={t("imagePreview")} closeLabel={t("close")} viewLabel={t("viewImage")}>
                <img className="web-chat__attachment-image" alt="" src={src} />
              </WebChatImageViewer>;
            })}
          </div>
        </article>) : null}
      </div>
      {access && conversationId ? <form className="web-chat__composer" aria-busy={snapshotPending} onSubmit={send}>
        {images.length ? <div className="web-chat__images" aria-label={t("imagesToSend")}>{images.map(file => <span className="web-chat__image-chip" key={`${file.name}-${file.lastModified}`}><Paperclip aria-hidden="true" /><span title={file.name}>{file.name}</span><button type="button" aria-label={t("removeImage", { name: file.name })} onClick={() => { pendingSubmissionRef.current = null; setImages(current => current.filter(entry => entry !== file)); }} disabled={snapshotPending}><X aria-hidden="true" /></button></span>)}</div> : null}
        <textarea ref={draftRef} aria-label={t("messageAgent", { agent: name })} value={draft} onChange={event => { pendingSubmissionRef.current = null; setDraft(event.target.value); }} placeholder={t("messagePlaceholder")} disabled={snapshotPending || Boolean(activeRun)} onKeyDown={event => { if (event.key !== "Enter" || event.shiftKey || isImeConfirmation(event)) return; event.preventDefault(); void send(event); }} />
        <div className="web-chat__actions">
          <div className="web-chat__composer-tools"><label className="web-chat__attach"><Image aria-hidden="true" /><input type="file" accept="image/*" multiple aria-label={t("addImages")} onChange={event => { const selected = [...event.target.files]; if (images.length + selected.length > 8) setError(new WebChatPresentationError("imageCountLimit")); else { pendingSubmissionRef.current = null; setImages(current => [...current, ...selected]); } event.target.value = ""; }} disabled={snapshotPending || Boolean(activeRun)} /></label></div>
          {activeRun ? <button type="button" className="web-chat__stop" aria-label={t("stopReply")} onClick={cancel}><Square aria-hidden="true" /><span>{t("stopReply")}</span></button> : <button type="submit" className="web-chat__send" aria-label={t("sendMessage")} disabled={snapshotPending || (!draft.trim() && !images.length)}><span>{t("send")}</span><ArrowUp aria-hidden="true" /></button>}
        </div>
      </form> : null}
    </main>
    {briefOpen ? <div className="web-chat__brief-backdrop"><form ref={briefDialogRef} className="web-chat__brief" role="dialog" aria-modal="true" aria-labelledby="web-chat-brief-title" onSubmit={submitBrief}>
      <button type="button" className="web-chat__brief-close" aria-label={t("close")} onClick={() => setBriefOpen(false)}><X aria-hidden="true" /></button>
      <Avatar className="web-chat__brief-avatar" src={creatorAvatarUrl} name={creatorName} size="large" />
      <h2 id="web-chat-brief-title">{t("startNewTask")}</h2>
      {(access?.brief_spec?.fields ?? access?.product?.brief_spec?.fields ?? []).map((field, index) => <label key={field.id}>{field.label}{field.required ? <span aria-hidden="true"> · {t("required")}</span> : null}<textarea autoFocus={index === 0} required={field.required} maxLength={32000} value={briefAnswers[field.id] ?? ""} onChange={event => setBriefAnswers(current => ({ ...current, [field.id]: event.target.value }))} /></label>)}
      <div className="web-chat__brief-actions"><button type="button" onClick={() => setBriefOpen(false)}>{t("later")}</button><button type="submit"><span>{t("startConversation")}</span><ArrowUp aria-hidden="true" /></button></div>
    </form></div> : null}
  </div>;
}
