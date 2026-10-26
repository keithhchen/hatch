import React, { useEffect, useRef } from "react";
import { ChevronsUpDown, Library, PanelLeft, SquarePen } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { SEPARATOR, nativeContextMenu, popupNativeMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { shortcut, useDesktop } from "./context.js";
import { Delayed, SidebarSkeleton } from "./states.jsx";

export function SidebarAction({ icon, label, keys, onClick, disabled }) {
  return <button type="button" className="desk-row desk-row--action" onClick={onClick} disabled={disabled}>
    {icon}<span className="desk-row__label">{label}</span>{keys ? <kbd className="desk-row__keys">{keys}</kbd> : null}
  </button>;
}

function RenameField({ title, onCommit, onCancel, label }) {
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  return <input ref={ref} className="desk-row__rename" aria-label={label} defaultValue={title}
    onBlur={event => onCommit(event.currentTarget.value)}
    onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); onCommit(event.currentTarget.value); }
      if (event.key === "Escape") { event.preventDefault(); onCancel(); }
    }} />;
}

function ConversationRow({ conversation, selected, waiting }) {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const title = conversation.title || t("conversation.untitled");
  if (ui.renaming === conversation.id) {
    return <div className="desk-row desk-row--conversation desk-row--editing" aria-current={selected ? "page" : undefined}>
      <RenameField title={title} label={t("conversation.rename")} onCommit={value => void app.commitRename(conversation.id, value)} onCancel={() => app.setState({ renaming: null })} />
    </div>;
  }
  return <button type="button" className="desk-row desk-row--conversation" aria-current={selected ? "page" : undefined} title={title}
    onClick={() => void app.select(conversation.id)}
    onContextMenu={nativeContextMenu(() => [
      { label: t("menu.rename"), action: () => app.beginRename(conversation.id) },
      SEPARATOR,
      { label: t("menu.archive"), action: () => app.archive(conversation.id) }
    ])}>
    <span className="desk-row__label">{title}</span>
    {waiting ? <span className="desk-badge" aria-label={t("sidebar.waiting")}>{waiting}</span> : null}
  </button>;
}

/** This Agent's conversations only. */
function ConversationList({ library, selected }) {
  const { app, t } = useDesktop();
  const { status, conversations, cursor } = useObservable(library);
  const { pending } = useObservable(app.approvals);
  useEffect(() => { void library.ensureLoaded(); }, [library]);
  return <>
    {status === "loading" && !conversations.length ? <Delayed><SidebarSkeleton rows={4} nested /></Delayed> : null}
    {status === "error" ? <button type="button" className="desk-row desk-row--note" onClick={() => void library.load()}>{t("sidebar.loadFailed")} {t("retry")}</button> : null}
    {status === "ready" && !conversations.length ? <p className="desk-row desk-row--note">{t("sidebar.empty")}</p> : null}
    {conversations.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} selected={selected === conversation.id}
      waiting={pending.filter(entry => entry.conversationId === conversation.id).length} />)}
    {cursor ? <button type="button" className="desk-row desk-row--note" onClick={() => void library.loadMore()}>{t("sidebar.loadMore")}</button> : null}
  </>;
}

export function AccountButton() {
  const { app, t } = useDesktop();
  const { account } = useObservable(app.session);
  const accountMenu = () => void popupNativeMenu([
    { label: t("menu.settings"), action: () => app.openOverlay("settings") },
    { label: t("menu.browse"), action: () => app.browseAgents() },
    SEPARATOR,
    { label: t("menu.signOut"), action: () => app.signOut() }
  ]);
  return <button type="button" className="desk-row desk-row--account" onClick={accountMenu} onContextMenu={nativeContextMenu([])}>
    <Avatar className="desk-row__avatar" src={account?.avatarUrl} name={account?.name ?? ""} size="small" />
    <span className="desk-row__label">{account?.name ?? ""}</span>
    <ChevronsUpDown className="desk-row__trailing" aria-hidden="true" />
  </button>;
}

/** The Chat window's source list: its Agent, New Conversation, that Agent's conversations. */
export function Sidebar() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  useObservable(app.session);
  const agent = app.agent;
  return <aside className="desk-sidebar" aria-label={t("sidebar.label")} inert={!ui.sidebarOpen}>
    <div className="desk-sidebar__titlebar" data-tauri-drag-region>
      <button type="button" className="desk-icon-button" aria-label={t("toolbar.toggleSidebar")} title={t("toolbar.toggleSidebar")} onClick={() => app.toggleSidebar()}><PanelLeft aria-hidden="true" /></button>
    </div>
    {agent ? <div className="desk-sidebar__agent" onContextMenu={nativeContextMenu(() => [{ label: t("menu.viewOnWeb"), action: () => app.viewOnWeb() }])}>
      <Avatar className="desk-sidebar__agent-avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />
      <div className="desk-sidebar__agent-copy"><strong>{agent.name}</strong><small>{agent.creatorName}</small></div>
    </div> : null}
    <div className="desk-sidebar__actions">
      <SidebarAction icon={<SquarePen aria-hidden="true" />} label={t("sidebar.newConversation")} keys={shortcut("N")} disabled={!agent} onClick={() => app.newConversation()} />
    </div>
    <nav className="desk-sidebar__list">
      {app.library ? <ConversationList library={app.library} selected={ui.conversationId} /> : <Delayed><SidebarSkeleton rows={4} nested /></Delayed>}
    </nav>
    <footer className="desk-sidebar__footer">
      <SidebarAction icon={<Library aria-hidden="true" />} label={t("library.show")} keys={shortcut("L", { shift: true })} onClick={() => app.showLibrary()} />
      <AccountButton />
    </footer>
  </aside>;
}
