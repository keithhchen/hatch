import React from "react";
import { Compass, Library, Plus, RotateCw, WifiOff } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { errorText } from "../i18n.js";
import { useDesktop } from "./context.js";

/** Loading affordances appear only after ~200ms, so fast loads never flash. */
export const Delayed = ({ children }) => <div className="desk-delayed">{children}</div>;

export function SidebarSkeleton({ rows = 4, nested = false }) {
  return <div className="desk-skeleton" aria-hidden="true">
    {Array.from({ length: rows }, (_, index) => <div key={index} className={`desk-skeleton__row${nested ? " desk-skeleton__row--nested" : ""}`}>
      {nested ? null : <span className="desk-skeleton__dot" />}
      <span className="desk-skeleton__bar" style={{ width: `${[62, 48, 70, 54, 40][index % 5]}%` }} />
    </div>)}
  </div>;
}

/** Same shape as a real thread: a short user line, then a reply. */
export function ThreadSkeleton() {
  return <Delayed><div className="desk-thread-skeleton" aria-hidden="true">
    <span className="desk-thread-skeleton__user" />
    <span className="desk-thread-skeleton__line" style={{ width: "86%" }} />
    <span className="desk-thread-skeleton__line" style={{ width: "72%" }} />
    <span className="desk-thread-skeleton__line" style={{ width: "40%" }} />
  </div></Delayed>;
}

export function OfflineBanner({ error, onRetry, actionLabel }) {
  const { t } = useDesktop();
  return <div className="desk-banner" role="status">
    <WifiOff aria-hidden="true" />
    <span>{error?.code === "network_error" ? t("banner.offline") : errorText(t, error)}</span>
    <button type="button" className="desk-button desk-button--quiet" onClick={onRetry}>{actionLabel ? null : <RotateCw aria-hidden="true" />}{actionLabel ?? t("banner.retry")}</button>
  </div>;
}

export function EmptyAgents() {
  const { app, t } = useDesktop();
  return <div className="desk-empty">
    <h2>{t("empty.noAgents.title")}</h2>
    <p>{t("empty.noAgents.body")}</p>
    <button type="button" className="desk-button desk-button--primary" onClick={() => app.browseAgents()}><Compass aria-hidden="true" />{t("empty.browse")}</button>
  </div>;
}

/** An Agent with no conversation selected: who it is and how to start. */
export function AgentWelcome({ agent }) {
  const { app, t } = useDesktop();
  const { identity } = agent;
  return <div className="desk-empty desk-empty--agent">
    <Avatar className="desk-empty__avatar" src={identity.creatorAvatarUrl} name={identity.creatorName} size="large" />
    <h2>{identity.productName}</h2>
    <p className="desk-empty__byline">{identity.creatorName}</p>
    {identity.promise || identity.description ? <p className="selectable">{identity.promise || identity.description}</p> : null}
    <button type="button" className="desk-button desk-button--primary" onClick={() => app.newConversation()}><Plus aria-hidden="true" />{t("startConversation")}</button>
  </div>;
}

/** The window's Agent is no longer in this account's Library (withdrawn or access ended). */
export function AgentUnavailable() {
  const { app, t } = useDesktop();
  return <div className="desk-empty">
    <h2>{t("empty.agentUnavailable.title")}</h2>
    <p>{t("empty.agentUnavailable.body")}</p>
    <button type="button" className="desk-button" onClick={() => app.showLibrary()}><Library aria-hidden="true" />{t("library.show")}</button>
  </div>;
}

export function OpenError({ error, onRetry }) {
  const { t } = useDesktop();
  return <div className="desk-empty">
    <h2>{t("empty.openFailed")}</h2>
    <p>{errorText(t, error)}</p>
    <button type="button" className="desk-button" onClick={onRetry}><RotateCw aria-hidden="true" />{t("retry")}</button>
  </div>;
}
