import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, ChevronDown, ChevronUp, CircleAlert, ImagePlus, Paperclip, Plus, RotateCw, Square, X } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { partitionAttachments } from "../domain/activity.js";
import { ACTIVITY_KINDS, ChatTimeline, groupTimelineEntries } from "../domain/timeline.js";
import { ActivityBlock, ActivityModal } from "./Activity.jsx";
import { ImageViewer } from "./ImageViewer.jsx";
import { MessageResponse } from "./MessageResponse.jsx";
import "./chat.css";

/** Subscribe a React tree to a ConversationController. */
export function useChatState(controller) {
  return useSyncExternalStore(controller.subscribe, controller.getState);
}

const isImeConfirmation = event => event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;

/** Creator avatar, Agent name and the "<creator> AI" line. */
export function CreatorHeading({ identity, agentName }) {
  return <div className="web-chat__heading">
    <Avatar className="web-chat__heading-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="medium" />
    <div className="web-chat__heading-copy"><h1>{identity.productName}</h1><small>{agentName}</small></div>
  </div>;
}

/** The submitted task brief of a Conversation, as a header pill + panel. */
export function TaskBriefDropdown({ snapshot, t }) {
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
    const close = () => { detailsRef.current.open = false; setMobilePanelPosition(null); };
    const closeOnOutsidePointer = event => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target)) close();
    };
    const closeOnEscape = event => {
      if (event.key !== "Escape" || !detailsRef.current?.open) return;
      close();
      detailsRef.current.querySelector("summary")?.focus();
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

function TimelineEntries({ timeline, live, activityKinds, t, errorText, loadToolDetail }) {
  const visible = timeline.filter(entry => !ACTIVITY_KINDS.includes(entry.kind) || activityKinds.includes(entry.kind));
  return groupTimelineEntries(visible).map((entry, index, entries) => {
    const isLastItem = index === entries.length - 1;
    if (entry.kind === "text") return <div className="web-chat__bubble web-chat__content" key={entry.id}><MessageResponse isAnimating={live}>{entry.content}</MessageResponse></div>;
    if (entry.kind === "status") return <div className="web-chat__runtime-status" key={entry.id}><span>{entry.content}</span></div>;
    if (entry.kind === "activity_group") return <ActivityModal key={entry.id} entries={entry.entries} isLastItem={isLastItem && live} t={t} errorText={errorText} loadToolDetail={loadToolDetail} />;
    return <ActivityBlock key={entry.id} entry={entry} t={t} errorText={errorText} loadToolDetail={loadToolDetail} />;
  });
}

function ChatMessage({ message, identity, statusText, attachments, Viewer, assetUrl, activityKinds, t, errorText, loadToolDetail }) {
  const { files, pictures } = partitionAttachments(message, mediaType => attachments.accepts(mediaType));
  const live = message.transient && message.timeline?.filter(entry => !ACTIVITY_KINDS.includes(entry.kind) || activityKinds.includes(entry.kind)).length;
  const timelineProps = { activityKinds, t, errorText, loadToolDetail };
  return <article className={`web-chat__message web-chat__message--${message.role}`}>
    {message.role === "assistant" ? <Avatar className="web-chat__message-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="small" /> : null}
    <div className="web-chat__message-body">
      {message.role === "assistant"
        ? message.transient
          ? live
            ? <TimelineEntries timeline={message.timeline} live {...timelineProps} />
            : <div className="web-chat__bubble web-chat__typing" role="status"><span className="web-chat__typing-dots" aria-hidden="true"><i /><i /><i /></span><span>{statusText}</span></div>
          : <TimelineEntries timeline={ChatTimeline.fromHistory(message)} live={false} {...timelineProps} />
        : message.content ? <div className="web-chat__bubble web-chat__content"><MessageResponse>{message.content}</MessageResponse></div> : null}
      {files.length ? <div className="web-chat__attachments">{files.map(item => <span key={item.attachment_id}><Paperclip aria-hidden="true" />{item.display_name}</span>)}</div> : null}
      {pictures.length ? <div className="web-chat__pictures">{pictures.map(item => {
        const src = assetUrl(item.asset_id);
        return <Viewer key={item.attachment_id} src={src} alt={item.display_name} title={t("imagePreview")} closeLabel={t("close")} viewLabel={t("viewImage")}>
          <img className="web-chat__attachment-image" alt="" src={src} />
        </Viewer>;
      })}</div> : null}
    </div>
  </article>;
}

function Composer({ controller, state, snapshotPending, agentName, t, onSend }) {
  const draftRef = useRef(null);
  const { draft, images, activeRun } = state;
  const busy = snapshotPending || Boolean(activeRun);

  useEffect(() => {
    const composer = draftRef.current;
    if (!composer) return;
    const maxHeight = Number.parseFloat(window.getComputedStyle(composer).maxHeight);
    const heightLimit = Number.isFinite(maxHeight) ? maxHeight : 190;
    composer.style.height = "auto";
    composer.style.height = `${Math.min(composer.scrollHeight, heightLimit)}px`;
    composer.style.overflowY = composer.scrollHeight > heightLimit ? "auto" : "hidden";
  }, [state.messages, state.status, draft, state.error]);

  const submit = event => {
    event.preventDefault();
    onSend();
  };

  return <form className="web-chat__composer" aria-busy={snapshotPending} onSubmit={submit}>
    {images.length ? <div className="web-chat__images" aria-label={t("imagesToSend")}>{images.map(file => <span className="web-chat__image-chip" key={`${file.name}-${file.lastModified}`}><Paperclip aria-hidden="true" /><span title={file.name}>{file.name}</span><button type="button" aria-label={t("removeImage", { name: file.name })} onClick={() => controller.removeImage(file)} disabled={snapshotPending}><X aria-hidden="true" /></button></span>)}</div> : null}
    <textarea ref={draftRef} aria-label={t("messageAgent", { agent: agentName })} value={draft} onChange={event => controller.setDraft(event.target.value)} placeholder={t("messagePlaceholder")} disabled={busy} onKeyDown={event => { if (event.key !== "Enter" || event.shiftKey || isImeConfirmation(event)) return; submit(event); }} />
    <div className="web-chat__actions">
      <label className="web-chat__attach" title={t("addImages")}><ImagePlus aria-hidden="true" /><input type="file" accept="image/*" multiple aria-label={t("addImages")} onChange={event => { controller.addImages([...event.target.files]); event.target.value = ""; }} disabled={busy} /></label>
      <span className="web-chat__hint">{t("composerHint")}</span>
      {activeRun
        ? <button type="button" className="web-chat__stop" aria-label={t("stopReply")} onClick={() => controller.cancel()}><Square aria-hidden="true" /><span>{t("stopReply")}</span></button>
        : <button type="submit" className="web-chat__send" aria-label={t("sendMessage")} disabled={snapshotPending || (!draft.trim() && !images.length)}><ArrowUp aria-hidden="true" /></button>}
    </div>
  </form>;
}

/**
 * The shared chat surface: thread, activity, attachments, notice and composer.
 * Shell chrome (navigation, window frame, account) is injected by the host.
 *
 * @param {object} props
 * @param {import("../application/conversation-controller.js").ConversationController} props.controller
 * @param {object} props.identity resolveCreatorIdentity() result
 * @param {string} props.agentName display name of the Agent ("<creator> AI")
 * @param {(key: string, values?: object) => string} props.t
 * @param {(error: object) => string} props.errorText
 * @param {import("../ports/index.js").AttachmentSource} props.attachments
 * @param {Function} [props.AttachmentViewer] AttachmentViewer port
 * @param {React.ReactNode} [props.header] slot above the thread
 * @param {React.ReactNode} [props.loadingIndicator] slot for the loading state
 * @param {(event) => void} props.onNewConversation
 * @param {string[]} [props.activityKinds] activity kinds this host shows
 */
export function ChatView({ controller, identity, agentName, t, errorText, attachments, AttachmentViewer = ImageViewer, header, loadingIndicator, onNewConversation, activityKinds = ACTIVITY_KINDS, inert }) {
  const state = useChatState(controller);
  const { conversationId, messages, historyCursor, activeRun, error, status } = state;
  const snapshotPending = controller.snapshotPending;
  const awaitingConversation = !conversationId && state.conversations.length > 0;
  const messagesRef = useRef(null);
  const followOutputRef = useRef(true);
  const statusText = status.text ?? t(status.key);
  const loadToolDetail = useCallback(detailRef => controller.transport.toolDetail(conversationId, detailRef), [controller, conversationId]);
  const assetUrl = useCallback(assetId => controller.transport.assetUrl(conversationId, assetId), [controller, conversationId]);

  useEffect(() => { followOutputRef.current = true; }, [conversationId]);
  useEffect(() => {
    const viewport = messagesRef.current;
    if (viewport && followOutputRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, status, state.draft, error]);

  const loadHistory = () => {
    followOutputRef.current = false;
    void controller.loadHistory().catch(controller.fail);
  };
  const send = () => {
    followOutputRef.current = true;
    void controller.send();
  };
  const messageProps = { identity, statusText, attachments, Viewer: AttachmentViewer, assetUrl, activityKinds, t, errorText, loadToolDetail };

  return <main className="web-chat__main" inert={inert}>
    {header}
    <div className="web-chat__messages" ref={messagesRef} onScroll={event => { const element = event.currentTarget; followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 112; }} aria-label={t("chatMessages")}>
      <div className="web-chat__thread">
        {!snapshotPending && historyCursor ? <button type="button" className="web-chat__history" onClick={loadHistory}><ChevronUp aria-hidden="true" /><span>{t("viewEarlierMessages")}</span></button> : null}
        {(snapshotPending || awaitingConversation) && !error ? <div className="web-chat__loading" role="status">{loadingIndicator}<span>{t("loadingConversation")}</span></div> : null}
        {!conversationId && !awaitingConversation && !activeRun ? <section className="web-chat__welcome">
          <Avatar className="web-chat__welcome-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="large" />
          <span className="web-pill">{t("welcomePill", { name: identity.creatorName })}</span>
          <h2>{identity.productName}</h2>
          {identity.promise ? <p>{identity.promise}</p> : null}
          <button type="button" className="web-chat__button web-chat__button--yolk" onClick={onNewConversation}><Plus aria-hidden="true" />{t("startConversation")}</button>
        </section> : null}
        {conversationId && !snapshotPending && messages.length === 0 && !activeRun ? <section className="web-chat__welcome web-chat__welcome--quiet">
          <Avatar className="web-chat__welcome-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="large" />
          <h2>{t("emptyHeadline")}</h2>
          <p>{t("emptyConversationBody", { agent: agentName })}</p>
        </section> : null}
        {!snapshotPending ? messages.map(message => <ChatMessage key={message.renderKey ?? `${message.run_id}-${message.role}`} message={message} {...messageProps} />) : null}
      </div>
    </div>
    <div className="web-chat__dock">
      {error ? <div className="web-chat__notice" role="alert"><CircleAlert aria-hidden="true" /><span>{errorText(error)}</span><button type="button" onClick={() => controller.retry()}><RotateCw aria-hidden="true" /><span>{t("retry")}</span></button></div> : null}
      {conversationId ? <Composer controller={controller} state={state} snapshotPending={snapshotPending} agentName={agentName} t={t} onSend={send} /> : null}
    </div>
  </main>;
}
