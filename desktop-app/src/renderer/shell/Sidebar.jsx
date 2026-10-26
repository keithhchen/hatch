import React, { useEffect, useRef } from "react";
import { ChevronRight, ChevronsUpDown, Compass, Search, SquarePen } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { SEPARATOR, nativeContextMenu, popupNativeMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { shortcut, useDesktop } from "./context.js";
import { Delayed, SidebarSkeleton } from "./states.jsx";

function SidebarAction({ icon, label, keys, onClick, disabled }) {
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

function ConversationRow({ agent, conversation, selected, waiting }) {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const title = conversation.title || t("conversation.untitled");
  if (ui.renaming === conversation.id) {
    return <div className="desk-row desk-row--conversation desk-row--editing" aria-current={selected ? "page" : undefined}>
      <RenameField title={title} label={t("conversation.rename")} onCommit={value => void app.commitRename(agent, conversation.id, value)} onCancel={() => app.setState({ renaming: null })} />
    </div>;
  }
  return <button type="button" className="desk-row desk-row--conversation" aria-current={selected ? "page" : undefined} title={title}
    onClick={() => void app.select(agent, conversation.id)}
    onContextMenu={nativeContextMenu(() => [
      { label: t("menu.rename"), action: () => app.beginRename(conversation.id) },
      { label: t("menu.openWindow"), action: () => app.openInNewWindow(agent, conversation.id) },
      SEPARATOR,
      { label: t("menu.archive"), action: () => app.archive(agent, conversation.id) }
    ])}>
    <span className="desk-row__label">{title}</span>
    {waiting ? <span className="desk-badge" aria-label={t("sidebar.waiting")}>{waiting}</span> : null}
  </button>;
}

function AgentGroup({ agent, selection, pending }) {
  const { app, t } = useDesktop();
  useObservable(app); // expansion state lives on the window
  const library = app.library(agent);
  const { status, conversations, cursor } = useObservable(library);
  const expanded = app.isExpanded(agent);
  const waiting = pending.filter(entry => entry.agentKey === agent.key);
  useEffect(() => { if (expanded) void library.ensureLoaded(); }, [expanded, library]);
  return <section className="desk-group" data-expanded={expanded}>
    <button type="button" className="desk-row desk-row--agent" aria-expanded={expanded}
      aria-label={`${agent.name} — ${expanded ? t("sidebar.collapse") : t("sidebar.expand")}`}
      onClick={() => app.setExpanded(agent, !expanded)}
      onContextMenu={nativeContextMenu(() => [
        { label: t("menu.newConversation"), action: () => app.newConversation(agent) },
        { label: t("menu.viewOnWeb"), action: () => app.viewOnWeb(agent) }
      ])}>
      <ChevronRight className="desk-row__disclosure" aria-hidden="true" />
      <Avatar className="desk-row__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />
      <span className="desk-row__label">{agent.name}</span>
      {agent.kind === "owned" ? <span className="desk-row__tag">{t("sidebar.owned")}</span> : null}
      {!expanded && waiting.length ? <span className="desk-badge">{waiting.length}</span> : null}
    </button>
    {expanded ? <div className="desk-group__items" role="group" aria-label={agent.name}>
      {status === "loading" && !conversations.length ? <Delayed><SidebarSkeleton rows={2} nested /></Delayed> : null}
      {status === "error" ? <button type="button" className="desk-row desk-row--note" onClick={() => void library.load()}>{t("sidebar.loadFailed")} {t("retry")}</button> : null}
      {status === "ready" && !conversations.length ? <p className="desk-row desk-row--note">{t("sidebar.empty")}</p> : null}
      {conversations.map(conversation => <ConversationRow key={conversation.id} agent={agent} conversation={conversation}
        selected={selection?.agentKey === agent.key && selection?.conversationId === conversation.id}
        waiting={waiting.filter(entry => entry.conversationId === conversation.id).length} />)}
      {cursor ? <button type="button" className="desk-row desk-row--note" onClick={() => void library.loadMore()}>{t("sidebar.loadMore")}</button> : null}
    </div> : null}
  </section>;
}

/** Source list grouped by Agent; each group expands on its own. */
export function Sidebar() {
  const { app, t } = useDesktop();
  const session = useObservable(app.session);
  const ui = useObservable(app);
  const { pending } = useObservable(app.approvals);
  const account = session.account;
  const accountMenu = () => void popupNativeMenu([
    { label: t("menu.settings"), action: () => app.openOverlay("settings") },
    { label: t("menu.browse"), action: () => app.browseAgents() },
    SEPARATOR,
    { label: t("menu.signOut"), action: () => app.signOut() }
  ]);
  return <aside className="desk-sidebar" aria-label={t("sidebar.label")} inert={!ui.sidebarOpen}>
    <div className="desk-sidebar__titlebar" data-tauri-drag-region />
    <div className="desk-sidebar__actions">
      <SidebarAction icon={<SquarePen aria-hidden="true" />} label={t("sidebar.newConversation")} keys={shortcut("N")} disabled={!app.selectedAgent} onClick={() => app.newConversation()} />
      <SidebarAction icon={<Search aria-hidden="true" />} label={t("sidebar.search")} keys={shortcut("K")} onClick={() => app.openOverlay("search")} />
    </div>
    <nav className="desk-sidebar__list">
      {!session.agents.length && session.agentsStatus === "loading" ? <Delayed><SidebarSkeleton rows={5} /></Delayed> : null}
      {session.agents.map(agent => <AgentGroup key={agent.key} agent={agent} selection={ui.selection} pending={pending} />)}
    </nav>
    <footer className="desk-sidebar__footer">
      <SidebarAction icon={<Compass aria-hidden="true" />} label={t("sidebar.browse")} onClick={() => app.browseAgents()} />
      <button type="button" className="desk-row desk-row--account" onClick={accountMenu} onContextMenu={nativeContextMenu([])}>
        <Avatar className="desk-row__avatar" src={account?.avatarUrl} name={account?.name ?? ""} size="small" />
        <span className="desk-row__label">{account?.name ?? ""}</span>
        <ChevronsUpDown className="desk-row__trailing" aria-hidden="true" />
      </button>
    </footer>
  </aside>;
}
