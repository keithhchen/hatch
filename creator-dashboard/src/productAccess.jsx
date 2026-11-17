import React, { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { resolveCreatorIdentity } from "@hatch/chat";
import { BuyerAccountMenu } from "./BuyerAccountControls.jsx";
import { WebChatGate } from "./webChatGate.jsx";
import { useLocale } from "./locale.jsx";
import { webChatErrorText } from "./webChatI18n.js";
import { takeEarlyAccess } from "./earlyLoad.js";

/** Shared by the Product's chat and artifact pages: who may open this Product, from the Registry's product-access list. */
export function useProductAccess(productId, request) {
  const [state, setState] = useState({ status: "checking" });
  useEffect(() => {
    let live = true;
    setState({ status: "checking" });
    const list = () => request("/v1/user/product-access");
    const early = takeEarlyAccess(); // already in flight since startup; if it failed, ask again
    (early ? early.catch(list) : list()).then(async payload => {
      const access = payload.creator_agents?.find(entry => entry.product_id === productId);
      if (access) { if (live) setState({ status: "granted", access }); return; }
      const detail = await request(`/v1/public/products/${encodeURIComponent(productId)}`);
      if (!detail.product) throw new Error("Public product detail is missing");
      if (live) setState({ status: "noAccess", publicProduct: detail.product });
    }).catch(error => { if (live) setState({ status: "error", error }); });
    return () => { live = false; };
  }, [productId, request]);
  return state;
}

export function WebChatAccountControls({ profile, onSignOut, className = "" }) {
  const { locale } = useLocale();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(null);

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setError(null);
    try {
      await onSignOut();
    } catch (cause) {
      setError(cause);
    } finally {
      setSigningOut(false);
    }
  }

  return <>
    <div className={`buyer-account-controls buyer-account-controls--chat ${className}`.trim()}>
      <BuyerAccountMenu user={profile} onSignOut={() => void signOut()} signingOut={signingOut} showLanguageOptions showName />
    </div>
    {error ? <p className="web-chat__account-error" role="alert">{webChatErrorText(error, locale)}</p> : null}
  </>;
}

/** The full-screen states before a Product opens: checking, unable to open, no access. */
export function ProductAccessGate({ state, productId, navigate, profile, onSignOut, t, locale }) {
  const myAgentsLink = <a href="/studio" className="web-chat__button">{t("backToMyAgents")}</a>;
  const account = <WebChatAccountControls profile={profile} onSignOut={onSignOut} />;
  let gate;
  if (state.status === "error") {
    gate = <WebChatGate alert account={account} pill={t("unavailablePill")} title={t("unableToOpenChat")} body={webChatErrorText(state.error, locale)} actions={<>
      {state.error.code === "agent_unavailable" ? null : <button type="button" className="web-chat__button web-chat__button--ink" onClick={() => location.reload()}><RotateCw aria-hidden="true" />{t("retry")}</button>}
      {myAgentsLink}
    </>} />;
  } else if (state.status === "noAccess") {
    const identity = resolveCreatorIdentity({ product: state.publicProduct });
    gate = <WebChatGate account={account} pill={t("noAccessPill")} title={t("noAccessTitle", { name: identity.creatorName })}
      visual={<div className="web-chat__preview">
        <div className="web-chat__preview-head">
          <Avatar src={identity.creatorAvatarUrl} name={identity.creatorName} size="medium" />
          <div><b>{identity.productName}</b><small>{t("expertAi", { name: identity.creatorName })}</small></div>
        </div>
        {identity.promise ? <p className="web-chat__preview-bubble">{identity.promise}</p> : null}
      </div>}
      actions={<>
        <button type="button" className="web-chat__button web-chat__button--yolk" onClick={() => navigate(`/products/${encodeURIComponent(productId)}`)}>{t("subscribeToExpertProduct", { name: identity.creatorName })}</button>
        {myAgentsLink}
      </>} />;
  } else gate = <WebChatGate busy account={account} body={t("checkingSubscription")} />;
  return <div className="web-chat web-chat--gate">{gate}</div>;
}
