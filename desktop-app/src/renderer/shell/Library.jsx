import React from "react";
import { Compass } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { nativeContextMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { HATCH_ORIGIN } from "../config.js";
import { openInBrowser } from "../native/bridge.js";
import { useDesktop } from "./context.js";
import { SettingsPanel } from "./SettingsPanel.jsx";
import { AccountButton } from "./Sidebar.jsx";
import { Delayed, EmptyAgents, OfflineBanner } from "./states.jsx";

function AgentCard({ agent }) {
  const { app, t } = useDesktop();
  return <button type="button" className="desk-library__agent" onClick={() => app.openAgent(agent)}
    onContextMenu={nativeContextMenu(() => [
      { label: t("library.open"), action: () => app.openAgent(agent) },
      { label: t("menu.viewOnWeb"), action: () => void openInBrowser(`${HATCH_ORIGIN}/products/${agent.productId}`) }
    ])}>
    <span className="desk-library__creator">
      <Avatar className="desk-library__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />
      <span>{agent.creatorName}</span>
    </span>
    <strong className="desk-library__name">{agent.name}</strong>
    {agent.description ? <p className="desk-library__description">{agent.description}</p> : null}
  </button>;
}

function AgentGroup({ title, agents, empty = null }) {
  if (!agents.length && !empty) return null;
  return <section className="desk-library__group" aria-label={title}>
    <h2 className="desk-library__heading">{title}</h2>
    {agents.length ? <div className="desk-library__grid">{agents.map(agent => <AgentCard key={agent.key} agent={agent} />)}</div> : empty}
  </section>;
}

const LibrarySkeleton = () => <div className="desk-library__grid" aria-hidden="true">
  {[0, 1, 2].map(index => <div key={index} className="desk-library__agent desk-library__agent--skeleton">
    <span className="desk-library__creator"><span className="desk-skeleton__dot" /><span className="desk-skeleton__bar" style={{ width: 80 }} /></span>
    <span className="desk-skeleton__bar" style={{ width: "60%" }} />
    <span className="desk-skeleton__bar" style={{ width: "90%" }} />
  </div>)}
</div>;

/** The Library window: my Agents, grouped as acquired and published, and "Browse More Agents…". */
export function Library() {
  const { app, t } = useDesktop();
  const session = useObservable(app.session);
  const { agents, agentsStatus } = session;
  const acquired = agents.filter(agent => agent.kind !== "owned");
  const owned = agents.filter(agent => agent.kind === "owned");
  const publishFirst = <button type="button" className="desk-library__link" onClick={() => void openInBrowser(`${HATCH_ORIGIN}/studio`)}>{t("library.publishFirst")}</button>;
  return <div className="desk-library">
    <header className="desk-library__titlebar" data-tauri-drag-region><strong data-tauri-drag-region>{t("library.title")}</strong></header>
    {agentsStatus === "error" ? <OfflineBanner error={session.error} onRetry={() => void app.session.refresh()} /> : null}
    <nav className="desk-library__list" aria-label={t("library.title")}>
      {!agents.length && agentsStatus === "loading" ? <Delayed><LibrarySkeleton /></Delayed> : null}
      {agentsStatus === "ready" && !agents.length ? <EmptyAgents /> : null}
      {agents.length ? <>
        <AgentGroup title={t("library.acquired")} agents={acquired} />
        <AgentGroup title={t("library.published")} agents={owned} empty={publishFirst} />
      </> : null}
    </nav>
    <footer className="desk-library__footer">
      <button type="button" className="desk-row desk-row--action" onClick={() => app.browseAgents()}><Compass aria-hidden="true" /><span className="desk-row__label">{t("sidebar.browse")}</span></button>
      <AccountButton />
    </footer>
    <SettingsPanel />
  </div>;
}
