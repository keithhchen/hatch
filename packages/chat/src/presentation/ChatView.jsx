import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowUp, ChevronDown, ChevronUp, CircleAlert, Paperclip, Plus, RotateCw, Square, X } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { approvalDecision, partitionAttachments } from "../domain/activity.js";
import { ACTIVITY_KINDS, ChatTimeline, groupTimelineEntries, withoutRepeatedSteps } from "../domain/timeline.js";
import { sharedScrollPositions } from "../domain/scroll-positions.js";
import { OPEN_FREE_CHAT } from "../domain/free-chat.js";
import { ActivityBlock, ActivityModal, ApprovalActivity } from "./Activity.jsx";
import { PagePanel, useComposerReserve, useFormPageViewer } from "./FormPageViewer.jsx";
import { ImageViewer } from "./ImageViewer.jsx";
import { MessageResponse } from "./MessageResponse.jsx";
import { Shimmer } from "./Shimmer.jsx";
import { AttachButton } from "./AttachButton.jsx";
import { MicButton, RecordingActions, RecordingWave, canRecord, useVoiceInput } from "./VoiceInput.jsx";
import { FreeChatPaywall } from "./FreeChatPaywall.jsx";
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

/** One reply's ordered entries: text, and runs of tool steps between it. */
export function TimelineEntries({ timeline, live, activityKinds, t, errorText, loadToolDetail, approvals }) {
  // A step with nothing to show (reasoning that came back empty, text of only whitespace) is no row, so no empty pill.
  const empty = entry => (entry.kind === "thinking" && !entry.streaming && !entry.content?.trim()) || (entry.kind === "text" && !entry.content.trim());
  const visible = timeline.filter(entry => !empty(entry) && (!ACTIVITY_KINDS.includes(entry.kind) || activityKinds.includes(entry.kind)));
  return groupTimelineEntries(visible, entry => approvalDecision(entry, approvals.decisions) !== null).map((entry, index, entries) => {
    const isLastItem = index === entries.length - 1;
    if (entry.kind === "text") return <div className="web-chat__bubble web-chat__content" key={entry.id}><MessageResponse isAnimating={live}>{entry.content}</MessageResponse></div>;
    if (entry.kind === "status") return <div className="web-chat__runtime-status" key={entry.id}><span>{entry.content}</span></div>;
    const decision = approvalDecision(entry, approvals.decisions);
    if (decision) return <ApprovalActivity key={entry.id} entry={entry} decision={decision} onDecision={approvals.decide} t={t} errorText={errorText} loadToolDetail={loadToolDetail} />;
    if (entry.kind === "activity_group") return <ActivityModal key={entry.id} entries={entry.entries} isLastItem={isLastItem && live} t={t} errorText={errorText} loadToolDetail={loadToolDetail} />;
    return <ActivityBlock key={entry.id} entry={entry} t={t} errorText={errorText} loadToolDetail={loadToolDetail} />;
  });
}

/** A durable picture; its source is resolved by the transport (URL or object URL). */
function AssetPicture({ assetId, name, Viewer, assetSource, t }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    let live = true;
    assetSource(assetId).then(value => { if (live) setSrc(value); }, () => {});
    return () => { live = false; };
  }, [assetId, assetSource]);
  if (!src) return <span className="web-chat__attachment-image web-chat__attachment-image--pending" aria-label={name} />;
  return <Viewer src={src} alt={name} title={t("imagePreview")} closeLabel={t("close")} viewLabel={t("viewImage")}>
    <img className="web-chat__attachment-image" alt="" src={src} draggable={false} />
  </Viewer>;
}

const sizeOf = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const RuntimeStatus = ({ children }) => <div className="web-chat__runtime-status" role="status"><Shimmer as="span">{children}</Shimmer></div>;

/** Where the Runtime compacted the conversation's context. */
const CompactionDivider = ({ t }) => <div className="web-chat__divider" role="separator"><span>{t("compaction.done")}</span></div>;

const REPLY_STATUSES = ["sending", "agentReplying", "syncingReply", "stopping"];

function ChatMessage({ message, identity, typingText, compacting, attachments, Viewer, assetSource, activityKinds, t, errorText, loadToolDetail, approvals }) {
  const { files, pictures } = partitionAttachments(message, mediaType => attachments.accepts(mediaType));
  const live = message.transient && message.timeline?.filter(entry => !ACTIVITY_KINDS.includes(entry.kind) || activityKinds.includes(entry.kind)).length;
  const timelineProps = { activityKinds, t, errorText, loadToolDetail, approvals };
  return <article className={`web-chat__message web-chat__message--${message.role}${message.state ? ` web-chat__message--${message.state}` : ""}`}>
    {message.role === "assistant" ? <Avatar className="web-chat__message-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="small" /> : null}
    <div className="web-chat__message-body">
      {message.role === "assistant"
        ? message.transient
          ? live
            ? <><TimelineEntries timeline={message.timeline} live {...timelineProps} />{compacting ? <RuntimeStatus>{t("compaction.running")}</RuntimeStatus> : null}</>
            : compacting ? <RuntimeStatus>{t("compaction.running")}</RuntimeStatus> : <div className="web-chat__bubble web-chat__typing" role="status"><span className="web-chat__typing-dots" aria-hidden="true"><i /><i /><i /></span>{typingText ? <span>{typingText}</span> : null}</div>
          : <TimelineEntries timeline={ChatTimeline.fromHistory(message)} live={false} {...timelineProps} />
        : message.content ? <div className="web-chat__bubble web-chat__content"><MessageResponse>{message.content}</MessageResponse></div> : null}
      {files.length ? <div className="web-chat__attachments">{files.map(item => <span key={item.attachment_id}><Paperclip aria-hidden="true" />{item.display_name}{item.source_bytes ? ` · ${sizeOf(item.source_bytes)}` : ""}</span>)}</div> : null}
      {pictures.length ? <div className="web-chat__pictures">{pictures.map(item => <AssetPicture key={item.attachment_id} assetId={item.asset_id} name={item.display_name} Viewer={Viewer} assetSource={assetSource} t={t} />)}</div> : null}
    </div>
  </article>;
}

const fileKey = file => file.id ?? `${file.name}-${file.lastModified}`;

/** The composer: draft, attachment chips, picker, Enter to send, Shift+Enter for a newline. Hosts with their own thread reuse it with a controller-shaped adapter. */
export function Composer({ controller, state, snapshotPending = false, agentName, t, onSend, attachControl, accessory, onPaste, accept = "image/*", dictate, steer = false }) {
  const draftRef = useRef(null);
  const { draft, images, activeRun } = state;
  // A host whose server takes a message while a Run is active keeps the composer open and has no Stop here.
  const busy = snapshotPending || (Boolean(activeRun) && !steer);
  // Send turns into Stop the moment a Run starts: a double-click on Send must not land on Stop and cancel the message it just sent.
  const [stoppable, setStoppable] = useState(false);
  useEffect(() => {
    setStoppable(false);
    if (!activeRun) return undefined;
    const timer = setTimeout(() => setStoppable(true), 700);
    return () => clearTimeout(timer);
  }, [activeRun]);

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
  // Dictation only fills the box: the user edits the text and decides whether to send.
  const voice = useVoiceInput({
    dictate,
    onText: text => { if (text) { controller.setDraft(draft.trim() ? `${draft.trimEnd()} ${text}` : text); draftRef.current?.focus(); } },
    onError: error => controller.fail?.(error)
  });
  const recording = voice.phase === "recording";

  return <form className="web-chat__composer" aria-busy={snapshotPending} onSubmit={submit}>
    {images.length ? <div className="web-chat__images" aria-label={t("imagesToSend")}>{images.map(file => <span className="web-chat__image-chip" key={fileKey(file)}><Paperclip aria-hidden="true" /><span title={file.name}>{file.name}</span><button type="button" aria-label={t("removeImage", { name: file.name })} onClick={() => controller.removeImage(file)} disabled={snapshotPending}><X aria-hidden="true" /></button></span>)}</div> : null}
    {recording ? <RecordingWave voice={voice} /> : <textarea ref={draftRef} aria-label={t("messageAgent", { agent: agentName })} value={draft} onChange={event => controller.setDraft(event.target.value)} placeholder={t("messagePlaceholder")} disabled={busy} onPaste={onPaste} onKeyDown={event => { if (event.key !== "Enter" || event.shiftKey || isImeConfirmation(event)) return; submit(event); }} />}
    {recording ? <RecordingActions voice={voice} t={t} /> : <div className="web-chat__actions">
      {attachControl ?? <AttachButton accept={accept} disabled={busy} onFiles={files => controller.addImages(files)} t={t} />}
      {accessory}
      {dictate && canRecord() ? <MicButton voice={voice} t={t} disabled={busy} /> : null}
      {activeRun && !steer
        ? <button type="button" className="web-chat__stop" aria-label={t("stopReply")} disabled={!stoppable} onClick={() => controller.cancel()}><Square aria-hidden="true" /><span>{t("stopReply")}</span></button>
        : <button type="submit" className="web-chat__send" aria-label={t("sendMessage")} disabled={snapshotPending || (!draft.trim() && !images.length)}><ArrowUp aria-hidden="true" /></button>}
    </div>}
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
 * @param {React.ReactNode} [props.dockAccessory] slot above the composer (e.g. pending approvals)
 * @param {React.ReactNode} [props.attachControl] replaces the default image picker
 * @param {React.ReactNode} [props.composerAccessory] extra composer controls
 * @param {(event) => void} [props.onComposerPaste]
 * @param {string} [props.accept] file types the picker offers; images only by default
 * @param {React.ReactNode} [props.empty] replaces the welcome shown for a conversation with no messages
 * @param {(recording: Blob) => Promise<string>} [props.dictate] speech to text; shows the microphone when supplied
 * @param {(toolCallId: string, decision: "allow"|"deny") => void} [props.onApprovalDecision]
 *   the host's approval gate. A tool row the host marked "pending" with
 *   `controller.markApproval` shows Allow / Deny only when this is supplied;
 *   the row is marked "allowed" / "denied" as soon as the user answers.
 * @param {import("../domain/scroll-positions.js").ScrollPositions} [props.scrollPositions]
 *   where each conversation was left; defaults to one in-memory store per page.
 */
export function ChatView({ controller, identity, agentName, t, errorText, attachments, AttachmentViewer = ImageViewer, header, loadingIndicator, onNewConversation, activityKinds = ACTIVITY_KINDS, inert, dockAccessory, attachControl, composerAccessory, onComposerPaste, onApprovalDecision, dictate, accept, empty, scrollPositions = sharedScrollPositions }) {
  const state = useChatState(controller);
  const meter = controller.freeChat ?? OPEN_FREE_CHAT;
  const freeChat = useSyncExternalStore(meter.subscribe, meter.getSnapshot);
  const { conversationId, messages, historyCursor, activeRun, error, status, approvals: decisions, compactions } = state;
  const snapshotPending = controller.snapshotPending;
  const awaitingConversation = !conversationId && state.conversations.length > 0;
  const messagesRef = useRef(null);
  const viewer = useFormPageViewer(messages, conversationId);
  const dockRef = useRef(null);
  useComposerReserve(dockRef);
  const followOutputRef = useRef(true);
  // The dots say what the reply is doing; a connection or loading status is not a reply's.
  const typingText = status.text ?? (REPLY_STATUSES.includes(status.key) ? t(status.key) : "");
  const loadToolDetail = useCallback(detailRef => controller.transport.toolDetail(conversationId, detailRef), [controller, conversationId]);
  const assetSource = useCallback(assetId => controller.transport.assetSource(conversationId, assetId), [controller, conversationId]);

  // Each conversation returns to where it was left. Positions are recorded
  // only after this conversation's messages rendered and were restored, so a
  // loading placeholder never overwrites the saved place.
  const restoredRef = useRef("");
  const pendingScrollRef = useRef(null);
  const scrollFrameRef = useRef(0);
  const flushScroll = useCallback(() => {
    cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = 0;
    const pending = pendingScrollRef.current;
    pendingScrollRef.current = null;
    if (pending) scrollPositions.save(pending.id, pending.position);
  }, [scrollPositions]);
  useEffect(() => {
    followOutputRef.current = true;
    restoredRef.current = "";
    return flushScroll;
  }, [conversationId, flushScroll]);
  const ready = Boolean(conversationId) && !snapshotPending && messages.length > 0;
  useEffect(() => {
    const viewport = messagesRef.current;
    if (!viewport) return;
    if (ready && restoredRef.current !== conversationId) {
      restoredRef.current = conversationId;
      const saved = scrollPositions.get(conversationId);
      if (saved && !saved.atBottom) {
        followOutputRef.current = false;
        viewport.scrollTop = saved.top;
        return;
      }
    }
    if (followOutputRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, status, state.draft, error, ready, conversationId, scrollPositions]);
  const onScroll = event => {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 112;
    followOutputRef.current = atBottom;
    if (!conversationId || restoredRef.current !== conversationId) return;
    pendingScrollRef.current = { id: conversationId, position: { top: element.scrollTop, atBottom } };
    if (!scrollFrameRef.current) scrollFrameRef.current = requestAnimationFrame(flushScroll);
  };

  const loadHistory = () => {
    followOutputRef.current = false;
    void controller.loadHistory().catch(controller.fail);
  };
  const send = () => {
    followOutputRef.current = true;
    void controller.send();
  };
  const decide = useCallback((toolCallId, decision) => {
    controller.markApproval(toolCallId, decision === "allow" ? "allowed" : "denied");
    onApprovalDecision(toolCallId, decision);
  }, [controller, onApprovalDecision]);
  const approvals = { decisions, decide: onApprovalDecision ? decide : null };
  const compactedRuns = new Set(compactions.filter(entry => entry.conversationId === conversationId).map(entry => entry.runId));
  const messageProps = { identity, typingText, attachments, Viewer: AttachmentViewer, assetSource, activityKinds, t, errorText, loadToolDetail, approvals };

  return <><main className="web-chat__main" inert={inert}>
    {header}
    <div className="web-chat__messages" ref={messagesRef} onScroll={onScroll} onClickCapture={viewer.onClickCapture} aria-label={t("chatMessages")}>
      <div className="web-chat__thread">
        {!snapshotPending && historyCursor ? <button type="button" className="web-chat__history" onClick={loadHistory}><ChevronUp aria-hidden="true" /><span>{t("viewEarlierMessages")}</span></button> : null}
        {(snapshotPending || awaitingConversation) && !error ? <div className="web-chat__loading" role="status">{loadingIndicator}<span>{t("loadingConversation")}</span></div> : null}
        {!conversationId && !awaitingConversation && !activeRun ? <section className="web-chat__welcome">
          <Avatar className="web-chat__welcome-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="large" />
          <span className="web-pill">{t("welcomePill", { name: identity.creatorName })}</span>
          <h2>{identity.productName}</h2>
          {identity.promise ? <p>{identity.promise}</p> : null}
          {freeChat.locked ? null : <button type="button" className="web-chat__button web-chat__button--yolk" onClick={onNewConversation}><Plus aria-hidden="true" />{t("startConversation")}</button>}
        </section> : null}
        {conversationId && !snapshotPending && messages.length === 0 && !activeRun && empty ? empty : null}
        {conversationId && !snapshotPending && messages.length === 0 && !activeRun && !empty ? <section className="web-chat__welcome web-chat__welcome--quiet">
          <Avatar className="web-chat__welcome-avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="large" />
          <h2>{t("emptyHeadline")}</h2>
          <p>{t("emptyConversationBody", { agent: agentName })}</p>
        </section> : null}
        {!snapshotPending ? withoutRepeatedSteps(messages).map(message => {
          const key = message.renderKey ?? `${message.run_id}-${message.role}`;
          const compacting = Boolean(message.transient && activeRun && message.run_id === activeRun && state.runState === "compacting");
          return <React.Fragment key={key}>
            {message.role === "assistant" && compactedRuns.has(message.run_id) ? <CompactionDivider t={t} /> : null}
            <ChatMessage message={message} compacting={compacting} {...messageProps} />
          </React.Fragment>;
        }) : null}
      </div>
    </div>
    <div className="web-chat__dock" ref={dockRef}>
      {error ? <div className="web-chat__notice" role="alert"><CircleAlert aria-hidden="true" /><span>{errorText(error)}</span>{state.failedRun && !controller.canRetryRun ? null : <button type="button" onClick={() => state.failedRun ? controller.retryRun() : controller.retry()}><RotateCw aria-hidden="true" /><span>{t("retry")}</span></button>}</div> : null}
      {dockAccessory}
      {freeChat.locked && !activeRun ? <FreeChatPaywall access={freeChat} creatorName={identity.creatorName} t={t} />
        : conversationId ? <Composer controller={controller} state={state} snapshotPending={snapshotPending} agentName={agentName} t={t} onSend={send} attachControl={attachControl} accessory={composerAccessory} onPaste={onComposerPaste} dictate={dictate} accept={accept} steer={controller.steerable} /> : null}
    </div>
  </main><PagePanel viewer={viewer} t={t} /></>;
}
