import React, { useState } from "react";
import { ArrowRight, Compass } from "lucide-react";
import { Avatar, HatchBrand } from "@hatch/ui";
import { nativeContextMenu } from "../native/context-menu.js";
import { useObservable } from "../observable.js";
import { HATCH_ORIGIN } from "../config.js";
import { useDesktop } from "./context.js";
import { SettingsPanel } from "./SettingsPanel.jsx";
import { AccountButton } from "./Sidebar.jsx";
import { Delayed, EmptyAgents, OfflineBanner } from "./states.jsx";

/** One Agent, drawn like a Web Explore catalog card. */
function AgentCard({ agent }) {
  const { app, t } = useDesktop();
  const [opening, setOpening] = useState(false);
  const open = () => {
    if (opening) return;
    setOpening(true);
    void app.openAgentUntilShown(agent).catch(() => {}).finally(() => setOpening(false));
  };
  return <button type="button" className={`desk-library__agent${opening ? " is-opening" : ""}`} aria-busy={opening || undefined} onClick={open}
    onContextMenu={nativeContextMenu(() => [
      { label: t("library.open"), action: open },
      { label: t("menu.viewOnWeb"), action: () => void app.openWeb(`${HATCH_ORIGIN}/products/${agent.productId}`) }
    ])}>
    <span className="desk-library__creator">
      <Avatar className="desk-library__avatar" src={agent.identity.creatorAvatarUrl} name={agent.creatorName} size="small" />
      <span>{agent.creatorName}</span>
    </span>
    <strong className="desk-library__name">{agent.name}</strong>
    {agent.description ? <p className="desk-library__description">{agent.description}</p> : null}
    <span className="desk-library__card-footer">
      <span className="desk-library__go">{opening ? <><span className="desk-library__spinner" aria-hidden="true" />{t("library.opening")}</> : <>{t("library.chat")}<ArrowRight aria-hidden="true" /></>}</span>
    </span>
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
  {[0, 1, 2].map(index => <div key={index} className="desk-library__agent desk-library__agent--skeleton"><i /><i /><i /><i /></div>)}
</div>;

/** The Library window: my Agents, grouped as acquired and published, and "Browse More Agents…". */
export function Library() {
  const { app, t } = useDesktop();
  const session = useObservable(app.session);
  const { agents, agentsStatus } = session;
  const acquired = agents.filter(agent => agent.kind !== "owned");
  const owned = agents.filter(agent => agent.kind === "owned");
  const publishFirst = <button type="button" className="desk-library__link" onClick={() => void app.openWeb(`${HATCH_ORIGIN}/studio/products/new`)}>{t("library.publishFirst")}<ArrowRight aria-hidden="true" /></button>;
  return <div className="desk-library">
    <header className="desk-library__titlebar" data-tauri-drag-region><HatchBrand className="desk-library__brand" /></header>
    {agentsStatus === "error" ? <OfflineBanner error={session.error} onRetry={() => void app.session.refresh()} /> : null}
    <nav className="desk-library__list" aria-label={t("library.title")}>
      <header className="desk-library__intro" data-tauri-drag-region>
        <h1>{t("library.title")}</h1>
        <p>{t("library.subtitle")}</p>
      </header>
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
