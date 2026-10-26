import React, { useCallback, useState } from "react";
import { ArrowUp, Folder, FolderX, Paperclip, ShieldCheck } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { ChatError } from "@hatch/chat";
import { ChatView } from "@hatch/chat/react";
import { folderName, PERMISSION_POLICIES } from "../chat/local-tools.js";
import { errorText } from "../i18n.js";
import { popupNativeMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { useDesktop } from "./context.js";
import { AgentWelcome, EmptyAgents, OfflineBanner, OpenError, ThreadSkeleton } from "./states.jsx";

const approvalDetail = request => {
  const args = request.arguments ?? {};
  return args.command ?? args.path ?? args.file_path ?? (Object.keys(args).length ? JSON.stringify(args, null, 2) : "");
};

/** Local tool calls held by the native gate for this conversation. */
function ApprovalPrompt({ conversationId }) {
  const { app, t } = useDesktop();
  const { pending } = useObservable(app.approvals);
  const mine = pending.filter(entry => entry.conversationId === conversationId);
  if (!mine.length) return null;
  return <div className="desk-approvals">{mine.map(entry => {
    const tool = t(`tool.${entry.request.name}`) === `tool.${entry.request.name}` ? entry.request.name : t(`tool.${entry.request.name}`);
    const detail = approvalDetail(entry.request);
    return <section key={entry.id} className="desk-approval" role="alertdialog" aria-label={t("approval.title", { tool })}>
      <ShieldCheck className="desk-approval__icon" aria-hidden="true" />
      <div className="desk-approval__copy">
        <strong>{t("approval.title", { tool })}</strong>
        {entry.request.reason ? <span>{entry.request.reason}</span> : null}
        {detail ? <code className="selectable">{detail}</code> : null}
      </div>
      <div className="desk-approval__actions">
        <button type="button" className="desk-button" onClick={() => entry.decide(false)}>{t("approval.deny")}</button>
        <button type="button" className="desk-button desk-button--primary" onClick={() => entry.decide(true)}>{t("approval.allow")}</button>
      </div>
    </section>;
  })}</div>;
}

/** Folder and change policy: the only workspace controls, next to the message. */
function WorkspaceControls({ session }) {
  const { t } = useDesktop();
  const workspace = useObservable(session.workspace);
  const choose = () => void session.workspace.choose().catch(error => session.controller.fail(error));
  if (workspace.status === "restoring") return null;
  const granted = workspace.status === "granted";
  return <div className="desk-composer-controls">
    <button type="button" className="desk-chip" title={granted ? workspace.grant.display_path : t("composer.folderTitle")} onClick={choose}>
      {workspace.status === "stale" ? <FolderX aria-hidden="true" /> : <Folder aria-hidden="true" />}
      <span>{granted ? folderName(workspace.grant.display_path) : workspace.status === "stale" ? t("composer.folderStale") : t("composer.chooseFolder")}</span>
    </button>
    {granted ? <button type="button" className="desk-chip" onClick={() => void popupNativeMenu(Object.values(PERMISSION_POLICIES).map(policy => ({
      label: t(`permission.${policy}`), checked: workspace.permission === policy, action: () => session.workspace.setPermission(policy)
    })))}>
      <ShieldCheck aria-hidden="true" /><span>{t(`permission.${workspace.permission}`)}</span>
    </button> : null}
  </div>;
}

function BriefForm({ agent, brief }) {
  const { app, t } = useDesktop();
  const [answers, setAnswers] = useState({});
  const [missing, setMissing] = useState(null);
  const fields = agent.briefFields;
  const submit = event => {
    event.preventDefault();
    const field = fields.find(item => item.required && !String(answers[item.id] ?? "").trim());
    if (field) { setMissing(new ChatError("missingBriefField", { field: field.label })); return; }
    void app.createConversation(agent, fields.map(item => ({ field_id: item.id, value: String(answers[item.id] ?? "") })), brief.inNewWindow);
  };
  const error = missing ?? brief.error;
  return <form className="desk-brief" onSubmit={submit} onKeyDown={event => { if (event.key === "Escape") app.setState({ brief: null }); }}>
    <header className="desk-brief__header">
      <Avatar className="desk-row__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />
      <div><h2>{t("brief.title")}</h2><p>{t("brief.intro", { agent: agent.name })}</p></div>
    </header>
    {fields.map((field, index) => <label key={field.id} className="desk-field">
      <span className="desk-field__label">{field.label}{field.required ? <em>{t("brief.required")}</em> : null}</span>
      <textarea autoFocus={index === 0} maxLength={32000} rows={3} value={answers[field.id] ?? ""} onChange={event => { setMissing(null); setAnswers(current => ({ ...current, [field.id]: event.target.value })); }} />
    </label>)}
    {error ? <p className="desk-form-error" role="alert">{errorText(t, error)}</p> : null}
    <footer className="desk-brief__actions">
      <button type="button" className="desk-button" onClick={() => app.setState({ brief: null })}>{t("brief.cancel")}</button>
      <button type="submit" className="desk-button desk-button--primary" disabled={brief.busy}>{t("brief.start")}<ArrowUp aria-hidden="true" /></button>
    </footer>
  </form>;
}

function LiveConversation({ session }) {
  const { app, t } = useDesktop();
  const { controller } = session;
  const describe = useCallback(error => errorText(t, error), [t]);
  const attach = () => void app.attachments.pick().then(({ files }) => { if (files.length) controller.addImages(files); }).catch(error => controller.fail(error));
  const paste = event => {
    const file = [...(event.clipboardData?.items ?? [])].find(item => item.kind === "file")?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void app.attachments.importPasted(file).then(composed => controller.addImages([composed])).catch(error => controller.fail(error));
  };
  return <ChatView key={session.key} controller={controller} identity={session.agent.identity} agentName={session.agent.name}
    t={t} errorText={describe} attachments={app.attachments} loadingIndicator={<ThreadSkeleton />}
    onNewConversation={() => app.newConversation(session.agent)}
    dockAccessory={<ApprovalPrompt conversationId={session.conversationId} />}
    attachControl={<button type="button" className="desk-icon-button" aria-label={t("composer.attach")} title={t("composer.attach")} onClick={attach}><Paperclip aria-hidden="true" /></button>}
    composerAccessory={<WorkspaceControls session={session} />}
    onComposerPaste={paste} />;
}

/** The content area: chat, task brief, or a state screen — never a blank panel. */
export function ConversationPane() {
  const { app, t } = useDesktop();
  const session = useObservable(app.session);
  const ui = useObservable(app);
  const agent = app.selectedAgent;
  const live = app.currentSession;
  const banner = session.agentsStatus === "error"
    ? <OfflineBanner error={session.error} onRetry={() => void app.session.refresh()} />
    : ui.openError && (live || !ui.selection?.conversationId) ? <OfflineBanner error={ui.openError} actionLabel={t("close")} onRetry={() => app.setState({ openError: null })} /> : null;
  let body;
  if (session.agentsStatus === "ready" && !session.agents.length) body = <EmptyAgents />;
  else if (!agent) body = session.agentsStatus === "error" ? null : <ThreadSkeleton />;
  else if (ui.brief) body = <BriefForm key={agent.key} agent={agent} brief={ui.brief} />;
  else if (!ui.selection.conversationId) body = <AgentWelcome agent={agent} />;
  else if (live) body = <LiveConversation session={live} />;
  else if (ui.openError) body = <OpenError error={ui.openError} onRetry={() => void app.select(agent, ui.selection.conversationId)} />;
  else body = <ThreadSkeleton />;
  return <div className="desk-pane web-chat">{banner}{body}</div>;
}
