import React, { useCallback, useEffect, useState } from "react";
import { resolveCreatorIdentity } from "@hatch/chat";
import { ProductAgentGate, useProductAgent } from "./productAgent.jsx";
import { WebChatShell } from "./WebChatShell.jsx";
import { Download } from "lucide-react";
import { ArtifactIntakePage } from "./ArtifactIntakePage.jsx";
import { ArtifactReportPage } from "./ArtifactReportPage.jsx";
import { loadArtifact } from "./artifactClient.js";
import { resumeView } from "./artifactForm.js";
import { ArtifactRoute } from "./artifactRoute.js";
import { useLocale } from "./locale.jsx";
import { webChatT } from "./webChatI18n.js";
import "./webChat.css";
import "./artifact.css";

const STATUS_KEYS = Object.freeze({ draft: "artifactStatusDraft", queued: "artifactStatusWaiting", generating: "artifactStatusWaiting", ready: "artifactStatusReady", failed: "artifactStatusFailed" });

/**
 * A Product's artifact conversations: the Product chat page with the thread replaced. Before submit the thread region is the
 * intake form, after it the report. What shows comes from the server's reports, never from local assumptions.
 * `?debug=1` shows the report's stage and steps while the Runtime works.
 */
export default function ArtifactPage({ productId, conversationId: routedConversationId, search = "", request, navigate, profile, onSignOut }) {
  const { locale } = useLocale();
  const t = useCallback((key, values) => webChatT(locale, key, values), [locale]);
  const agentState = useProductAgent(productId, request);
  const agent = agentState.agent;
  const [mode, setMode] = useState(null);
  const [earlyApi, setEarlyApi] = useState(null); // set once the routed report has answered, before the definition and the list
  const [error, setError] = useState(null);
  const [download, setDownload] = useState(null);
  const params = new URLSearchParams(search);

  useEffect(() => {
    if (!agent) return undefined;
    let live = true;
    setMode(null);
    setEarlyApi(null);
    setError(null);
    loadArtifact(request, productId, routedConversationId, api => { if (live) setEarlyApi(api); })
      .then(loaded => { if (!live) return; if (loaded) setMode(loaded); else setError({ key: "artifactNoReport" }); })
      .catch(cause => { if (live) setError(cause); });
    return () => { live = false; };
  }, [agent, productId, request]); // the routed id is only the first report to fetch early; later routes are fetched by the report page

  const toIntake = useCallback(() => navigate(ArtifactRoute.productPath(productId), { replace: true }), [navigate, productId]);

  if (!mode && (error || !earlyApi)) return <ProductAgentGate navigate={navigate} profile={profile} onSignOut={onSignOut} t={t} locale={locale} state={error ? { status: "error", error } : agentState} />;

  const identity = resolveCreatorIdentity({ access: agent });
  const agentName = t("expertAi", { name: identity.creatorName });
  const api = mode?.api ?? earlyApi;
  const conversations = mode?.conversations ?? [];
  const shown = mode ? resumeView(conversations, routedConversationId, { startNew: params.get("new") === "1" }) : { view: "report", conversationId: routedConversationId };
  const sidebar = conversations.map(entry => ({ id: entry.conversation_id, title: t(STATUS_KEYS[entry.status] ?? "artifactStatusWaiting"), created_at: entry.created_at }));
  const select = id => navigate(conversations.find(entry => entry.conversation_id === id)?.status === "draft" ? ArtifactRoute.productPath(productId) : ArtifactRoute.conversationPath(productId, id));

  const headerExtra = download ? <a className="web-chat__button web-chat__button--yolk artifact__header-download" href={download.href} download onClick={download.track}><Download aria-hidden="true" />{t("artifactDownload")}</a> : null;

  return <WebChatShell identity={identity} agentName={agentName} conversations={sidebar} selectedId={shown.conversationId ?? shown.draftConversationId} hasMore={false} headerExtra={headerExtra}
    onSelect={select} onNew={() => navigate(`${ArtifactRoute.productPath(productId)}?new=1`)} newLabel={t("artifactNew")} profile={profile} onSignOut={onSignOut} navigate={navigate} t={t} locale={locale}>
    {header => <main className="web-chat__main">
      {header}
      {shown.view === "report"
        ? <ArtifactReportPage key={shown.conversationId} api={api} conversationId={shown.conversationId} productId={productId} onDraft={toIntake} onDownload={setDownload} debug={params.get("debug") === "1"} t={t} locale={locale} />
        : <ArtifactIntakePage api={mode.api} definition={mode.definition} productId={productId} productName={identity.productName} draftConversationId={shown.draftConversationId}
          conversationPath={id => ArtifactRoute.conversationPath(productId, id)} navigate={navigate} t={t} locale={locale} />}
    </main>}
  </WebChatShell>;
}
