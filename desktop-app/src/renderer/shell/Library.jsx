import React from "react";
import { ChevronRight, Compass } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { nativeContextMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { HATCH_ORIGIN } from "../config.js";
import { openInBrowser } from "../native/bridge.js";
import { shortcut, useDesktop } from "./context.js";
import { SettingsPanel } from "./SettingsPanel.jsx";
import { AccountButton } from "./Sidebar.jsx";
import { Delayed, EmptyAgents, OfflineBanner, SidebarSkeleton } from "./states.jsx";

function AgentRow({ agent, index }) {
  const { app, t } = useDesktop();
  return <button type="button" className="desk-library__agent" onClick={() => app.openAgent(agent)}
    onContextMenu={nativeContextMenu(() => [
      { label: t("library.open"), action: () => app.openAgent(agent) },
      { label: t("menu.viewOnWeb"), action: () => void openInBrowser(`${HATCH_ORIGIN}/products/${agent.productId}`) }
    ])}>
    <Avatar className="desk-library__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="medium" />
    <span className="desk-library__copy">
      <strong>{agent.name}</strong>
      <small>{agent.creatorName}{agent.kind === "owned" ? ` · ${t("sidebar.owned")}` : ""}</small>
    </span>
    {index < 9 ? <kbd className="desk-row__keys">{shortcut(String(index + 1))}</kbd> : null}
    <ChevronRight className="desk-library__chevron" aria-hidden="true" />
  </button>;
}

/** The Library window: my Agents (owned + acquired) and "Browse More Agents…". */
export function Library() {
  const { app, t } = useDesktop();
  const session = useObservable(app.session);
  const { agents, agentsStatus } = session;
  return <div className="desk-library">
    <header className="desk-library__titlebar" data-tauri-drag-region><strong data-tauri-drag-region>{t("library.title")}</strong></header>
    {agentsStatus === "error" ? <OfflineBanner error={session.error} onRetry={() => void app.session.refresh()} /> : null}
    <nav className="desk-library__list" aria-label={t("library.title")}>
      {!agents.length && agentsStatus === "loading" ? <Delayed><SidebarSkeleton rows={4} /></Delayed> : null}
      {agentsStatus === "ready" && !agents.length ? <EmptyAgents /> : null}
      {agents.map((agent, index) => <AgentRow key={agent.key} agent={agent} index={index} />)}
    </nav>
    <footer className="desk-library__footer">
      <button type="button" className="desk-row desk-row--action" onClick={() => app.browseAgents()}><Compass aria-hidden="true" /><span className="desk-row__label">{t("sidebar.browse")}</span></button>
      <AccountButton />
    </footer>
    <SettingsPanel />
  </div>;
}
