import React, { useCallback, useEffect, useState } from "react";
import { resolveCreatorIdentity } from "@hatch/chat";
import { ProductAccessGate, useProductAccess } from "./productAccess.jsx";
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
  const accessState = useProductAccess(productId, request);
  const access = accessState.access;
  const [mode, setMode] = useState(null);
  const [error, setError] = useState(null);
  const [download, setDownload] = useState(null);
  const params = new URLSearchParams(search);

  useEffect(() => {
    if (!access) return undefined;
    let live = true;
    setMode(null);
    setError(null);
    loadArtifact(request, access, productId)
      .then(loaded => { if (!live) return; if (loaded) setMode(loaded); else setError({ key: "artifactNoReport" }); })
      .catch(cause => { if (live) setError(cause); });
    return () => { live = false; };
  }, [access, productId, request]);

  const toIntake = useCallback(() => navigate(ArtifactRoute.productPath(productId), { replace: true }), [navigate, productId]);

  const gate = { navigate, profile, onSignOut, productId, t, locale };
  if (!mode) return <ProductAccessGate {...gate} state={error ? { status: "error", error } : accessState} />;

  const identity = resolveCreatorIdentity({ access });
  const agentName = t("expertAi", { name: identity.creatorName });
  const shown = resumeView(mode.conversations, routedConversationId, { startNew: params.get("new") === "1" });
  const sidebar = mode.conversations.map(entry => ({ id: entry.conversation_id, title: t(STATUS_KEYS[entry.status] ?? "artifactStatusWaiting"), created_at: entry.created_at }));
  const select = id => navigate(mode.conversations.find(entry => entry.conversation_id === id)?.status === "draft" ? ArtifactRoute.productPath(productId) : ArtifactRoute.conversationPath(productId, id));

  const headerExtra = download ? <a className="web-chat__button web-chat__button--yolk artifact__header-download" href={download.href} download onClick={download.track}><Download aria-hidden="true" />{t("artifactDownload")}</a> : null;

  return <WebChatShell identity={identity} agentName={agentName} conversations={sidebar} selectedId={shown.conversationId ?? shown.draftConversationId} hasMore={false} headerExtra={headerExtra}
    onSelect={select} onNew={() => navigate(`${ArtifactRoute.productPath(productId)}?new=1`)} newLabel={t("artifactNew")} profile={profile} onSignOut={onSignOut} t={t} locale={locale}>
    {header => <main className="web-chat__main">
      {header}
      {shown.view === "report"
        ? <ArtifactReportPage key={shown.conversationId} api={mode.api} conversationId={shown.conversationId} productId={productId} onDraft={toIntake} onDownload={setDownload} debug={params.get("debug") === "1"} t={t} locale={locale} />
        : <ArtifactIntakePage api={mode.api} definition={mode.definition} productId={productId} productName={identity.productName} draftConversationId={shown.draftConversationId}
          conversationPath={id => ArtifactRoute.conversationPath(productId, id)} navigate={navigate} t={t} locale={locale} />}
    </main>}
  </WebChatShell>;
}
