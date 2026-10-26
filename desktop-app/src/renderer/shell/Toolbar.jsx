import React from "react";
import { PanelLeft, Search, SquarePen } from "lucide-react";
import { TaskBriefDropdown, useChatState } from "@hatch/chat/react";
import { useObservable } from "../observable.js";
import { shortcut, useDesktop } from "./context.js";

function ConnectionIndicator({ controller }) {
  const { t } = useDesktop();
  const state = useChatState(controller);
  if (!state.conversationId || state.session || state.error) return null;
  return <span className="desk-connection desk-delayed" role="status"><span className="desk-connection__dot" aria-hidden="true" />{t("connection.connecting")}</span>;
}

function ToolbarButton({ label, keys, onClick, children, disabled }) {
  return <button type="button" className="desk-icon-button" aria-label={label} title={keys ? `${label} (${keys})` : label} onClick={onClick} disabled={disabled}>{children}</button>;
}

/** Title = conversation, subtitle = Agent · creator; no menu that duplicates the menu bar. */
export function Toolbar() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const agent = app.selectedAgent;
  const library = agent ? app.library(agent) : null;
  useObservable(library ?? app);
  const conversation = app.selectedConversation;
  const session = app.currentSession;
  const title = conversation?.title || (ui.selection?.conversationId ? t("conversation.untitled") : agent?.name ?? "Hatch");
  return <header className="desk-toolbar" data-tauri-drag-region>
    {!ui.sidebarOpen ? <ToolbarButton label={t("toolbar.toggleSidebar")} onClick={() => app.toggleSidebar()}><PanelLeft aria-hidden="true" /></ToolbarButton> : null}
    <div className="desk-toolbar__title" data-tauri-drag-region>
      <strong data-tauri-drag-region>{title}</strong>
      {agent ? <small data-tauri-drag-region>{t("conversation.byline", { agent: agent.name, creator: agent.creatorName })}</small> : null}
    </div>
    <div className="desk-toolbar__trailing">
      {session ? <ConnectionIndicator controller={session.controller} /> : null}
      {conversation?.brief_snapshot ? <TaskBriefDropdown key={conversation.id} snapshot={conversation.brief_snapshot} t={t} /> : null}
      <ToolbarButton label={t("toolbar.newConversation")} keys={shortcut("N")} disabled={!agent} onClick={() => app.newConversation()}><SquarePen aria-hidden="true" /></ToolbarButton>
      <ToolbarButton label={t("toolbar.search")} keys={shortcut("K")} onClick={() => app.openOverlay("search")}><Search aria-hidden="true" /></ToolbarButton>
    </div>
  </header>;
}
