import React from "react";
import { PanelLeft, SquarePen } from "lucide-react";
import { TaskBriefDropdown, useChatState } from "@hatch/chat/react";
import { useObservable } from "../observable.js";
import { shortcut, useDesktop } from "./context.js";

/**
 * The live session as a small indicator: "connecting" while it opens or
 * retries; "idle" (retries ran out, or not connected yet) is a quiet
 * neutral dot — not an error, the next send reconnects; "open" shows nothing.
 */
function ConnectionIndicator({ controller }) {
  const { t } = useDesktop();
  const { conversationId, connection, error } = useChatState(controller);
  if (!conversationId || error || connection === "open") return null;
  if (connection === "connecting") return <span className="desk-connection desk-delayed" role="status"><span className="desk-connection__dot" aria-hidden="true" />{t("connection.connecting")}</span>;
  return <span className="desk-connection desk-connection--idle" role="status" title={t("connection.idleDetail")}><span className="desk-connection__dot" aria-hidden="true" />{t("connection.idle")}</span>;
}

function ToolbarButton({ label, keys, onClick, children, disabled }) {
  return <button type="button" className="desk-icon-button" aria-label={label} title={keys ? `${label} (${keys})` : label} onClick={onClick} disabled={disabled}>{children}</button>;
}

/** Title = conversation, subtitle = Agent · creator; no menu that duplicates the menu bar. */
export function Toolbar() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  useObservable(app.library ?? app);
  const agent = app.agent;
  const conversation = app.selectedConversation;
  const session = app.currentSession;
  const title = conversation?.title || (ui.conversationId || ui.composing ? t("conversation.untitled") : agent?.name ?? "Hatch");
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
    </div>
  </header>;
}
