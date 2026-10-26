import React, { useCallback, useState } from "react";
import { ArrowUp, Folder, FolderOpen, FolderX, Paperclip, ShieldCheck } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { ChatError } from "@hatch/chat";
import { ChatView } from "@hatch/chat/react";
import { folderName, PERMISSION_POLICIES } from "../chat/local-tools.js";
import { threadMenuItems } from "../chat/thread-menu.js";
import { errorText } from "../i18n.js";
import { isNative, nativeInvoke } from "../native/bridge.js";
import { isEditableTarget, popupNativeMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { useDesktop } from "./context.js";
import { AgentUnavailable, AgentWelcome, OfflineBanner, OpenError, ThreadSkeleton } from "./states.jsx";

const PERMISSION_DETAIL = Object.freeze({
  [PERMISSION_POLICIES.ASK_BEFORE_CHANGES]: "permission.askBeforeChangesDetail",
  [PERMISSION_POLICIES.ALLOW_CHANGES]: "permission.allowChangesDetail"
});

/** Change policy for this conversation; each option carries its description. */
function PermissionChip({ permission, onChange }) {
  const { t } = useDesktop();
  const menu = () => void popupNativeMenu(Object.values(PERMISSION_POLICIES).flatMap(policy => [
    { label: t(`permission.${policy}`), checked: permission === policy, action: () => onChange(policy) },
    { label: t(PERMISSION_DETAIL[policy]), enabled: false }
  ]));
  return <button type="button" className="desk-chip" title={t(PERMISSION_DETAIL[permission])} onClick={menu}>
    <ShieldCheck aria-hidden="true" /><span>{t(`permission.${permission}`)}</span>
  </button>;
}

/** Folder and change policy: the only workspace controls, next to the message. */
function WorkspaceControls({ session }) {
  const { t } = useDesktop();
  const workspace = useObservable(session.workspace);
  const choose = () => void session.workspace.choose().catch(error => session.controller.fail(error));
  const granted = workspace.status === "granted";
  return <div className="desk-composer-controls">
    <button type="button" className="desk-chip" data-missing={!granted || undefined} title={granted ? workspace.grant.display_path : t("composer.folderTitle")} onClick={choose}>
      {workspace.status === "stale" ? <FolderX aria-hidden="true" /> : <Folder aria-hidden="true" />}
      <span>{granted ? folderName(workspace.grant.display_path) : workspace.status === "stale" ? t("composer.folderStale") : t("composer.chooseFolder")}</span>
    </button>
    <PermissionChip permission={workspace.permission} onChange={policy => session.workspace.setPermission(policy)} />
  </div>;
}

/** Why the message can't be sent yet: this conversation has no folder. */
function FolderRequired({ session }) {
  const { t } = useDesktop();
  const workspace = useObservable(session.workspace);
  if (workspace.status === "granted" || workspace.status === "restoring") return null;
  return <div className="desk-folder-gate" role="status">
    <FolderOpen aria-hidden="true" />
    <span>{workspace.status === "stale" ? t("folderGate.stale") : t("folderGate.send")}</span>
    <button type="button" className="desk-button desk-button--primary" onClick={() => void session.workspace.choose().catch(error => session.controller.fail(error))}>{t("composer.chooseFolder")}</button>
  </div>;
}

/** A new conversation before it exists: its folder first, then the brief (if the Agent has one). */
function NewConversation({ agent, composing }) {
  const { app, t } = useDesktop();
  const [answers, setAnswers] = useState({});
  const [missing, setMissing] = useState(null);
  const fields = agent.briefFields;
  const grant = composing.grant;
  const submit = event => {
    event.preventDefault();
    const field = fields.find(item => item.required && !String(answers[item.id] ?? "").trim());
    if (field) { setMissing(new ChatError("missingBriefField", { field: field.label })); return; }
    void app.createConversation({ grant, briefAnswers: fields.map(item => ({ field_id: item.id, value: String(answers[item.id] ?? "") })) });
  };
  const error = missing ?? composing.error;
  const folder = <div className="desk-field">
    <span className="desk-field__label">{t("folderGate.label")}</span>
    <button type="button" className="desk-folder-pick" data-missing={!grant || undefined} title={grant?.display_path} disabled={composing.busy} onClick={() => void app.chooseComposingFolder()}>
      <Folder aria-hidden="true" /><span>{grant ? grant.display_path : t("folderGate.choose")}</span>
    </button>
    <small className="desk-field__hint">{t("folderGate.hint")}</small>
  </div>;
  if (!fields.length) {
    return <div className="desk-empty desk-empty--agent" onKeyDown={event => { if (event.key === "Escape") app.cancelComposing(); }}>
      <Avatar className="desk-empty__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="large" />
      <h2>{t("folderGate.title")}</h2>
      <p>{t("folderGate.body", { agent: agent.name })}</p>
      {error ? <p className="desk-form-error" role="alert">{errorText(t, error)}</p> : null}
      <button type="button" className="desk-button desk-button--primary" disabled={composing.busy} onClick={() => void app.chooseComposingFolder()}><FolderOpen aria-hidden="true" />{t("folderGate.choose")}</button>
    </div>;
  }
  return <form className="desk-brief" onSubmit={submit} onKeyDown={event => { if (event.key === "Escape") app.cancelComposing(); }}>
    <header className="desk-brief__header">
      <Avatar className="desk-row__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />
      <div><h2>{t("brief.title")}</h2><p>{t("brief.intro", { agent: agent.name })}</p></div>
    </header>
    {folder}
    {fields.map((field, index) => <label key={field.id} className="desk-field">
      <span className="desk-field__label">{field.label}{field.required ? <em>{t("brief.required")}</em> : null}</span>
      <textarea autoFocus={index === 0} maxLength={32000} rows={3} value={answers[field.id] ?? ""} onChange={event => { setMissing(null); setAnswers(current => ({ ...current, [field.id]: event.target.value })); }} />
    </label>)}
    {error ? <p className="desk-form-error" role="alert">{errorText(t, error)}</p> : null}
    <footer className="desk-brief__actions">
      {!grant ? <span className="desk-brief__reason">{t("folderGate.start")}</span> : null}
      <button type="button" className="desk-button" onClick={() => app.cancelComposing()}>{t("brief.cancel")}</button>
      <button type="submit" className="desk-button desk-button--primary" disabled={composing.busy || !grant}>{t("brief.start")}<ArrowUp aria-hidden="true" /></button>
    </footer>
  </form>;
}

function LiveConversation({ session }) {
  const { app, t } = useDesktop();
  const { controller } = session;
  const workspace = useObservable(session.workspace);
  const describe = useCallback(error => errorText(t, error), [t]);
  const attach = () => void app.attachments.pick().then(({ files }) => { if (files.length) controller.addImages(files); }).catch(error => controller.fail(error));
  const paste = event => {
    const file = [...(event.clipboardData?.items ?? [])].find(item => item.kind === "file")?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void app.attachments.importPasted(file).then(composed => controller.addImages([composed])).catch(error => controller.fail(error));
  };
  const decide = useCallback((toolCallId, decision) => app.decideApproval(session.conversationId, toolCallId, decision), [app, session.conversationId]);
  const contextMenu = event => {
    if (!isNative() || isEditableTarget(event.target) || String(window.getSelection?.() ?? "").trim()) return;
    const target = event.target;
    event.preventDefault();
    event.stopPropagation();
    void threadMenuItems({ target, session, t, invoke: nativeInvoke, copy: value => navigator.clipboard.writeText(value), report: error => controller.fail(error) })
      .then(items => { if (items) return popupNativeMenu(items); });
  };
  return <div className="desk-thread" data-folder={workspace.status === "granted" ? "granted" : "missing"} onContextMenu={contextMenu}>
    <ChatView key={session.key} controller={controller} identity={session.agent.identity} agentName={session.agent.name}
      t={t} errorText={describe} attachments={app.attachments} loadingIndicator={<ThreadSkeleton />}
      onNewConversation={() => app.newConversation()}
      onApprovalDecision={decide}
      dockAccessory={<FolderRequired session={session} />}
      attachControl={<button type="button" className="desk-icon-button" aria-label={t("composer.attach")} title={t("composer.attach")} onClick={attach}><Paperclip aria-hidden="true" /></button>}
      composerAccessory={<WorkspaceControls session={session} />}
      onComposerPaste={paste} />
  </div>;
}

/** The content area: chat, the new-conversation step, or a state screen — never a blank panel. */
export function ConversationPane() {
  const { app, t } = useDesktop();
  const session = useObservable(app.session);
  const ui = useObservable(app);
  const agent = app.agent;
  const live = app.currentSession;
  const banner = session.agentsStatus === "error"
    ? <OfflineBanner error={session.error} onRetry={() => void app.session.refresh()} />
    : ui.openError && (live || !ui.conversationId) ? <OfflineBanner error={ui.openError} actionLabel={t("close")} onRetry={() => app.setState({ openError: null })} /> : null;
  let body;
  if (!agent) body = session.agentsStatus === "ready" ? <AgentUnavailable /> : session.agentsStatus === "error" ? null : <ThreadSkeleton />;
  else if (ui.composing) body = <NewConversation key={agent.key} agent={agent} composing={ui.composing} />;
  else if (!ui.conversationId) body = <AgentWelcome agent={agent} />;
  else if (live) body = <LiveConversation session={live} />;
  else if (ui.openError) body = <OpenError error={ui.openError} onRetry={() => void app.select(ui.conversationId)} />;
  else body = <ThreadSkeleton />;
  return <div className="desk-pane web-chat">{banner}{body}</div>;
}
