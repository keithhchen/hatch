import React, { useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import { BuyerAccountMenu } from "./BuyerAccountControls.jsx";
import { WebChatGate } from "./webChatGate.jsx";
import { useLocale } from "./locale.jsx";
import { webChatErrorText } from "./webChatI18n.js";
import { takeEarlyAgent, productAgentUrl } from "./earlyLoad.js";

/** Shared by the Product's chat and artifact pages: the live Agent behind a Product, readable by anyone, signed in or not. */
export function useProductAgent(productId, request) {
  const [state, setState] = useState({ status: "checking" });
  useEffect(() => {
    let live = true;
    setState({ status: "checking" });
    const load = () => request(productAgentUrl(productId));
    const early = takeEarlyAgent(productId); // already in flight since startup; if it failed, ask again
    (early ? early.catch(load) : load())
      .then(({ creator_agent: agent }) => { if (live) setState({ status: "ready", agent }); })
      .catch(error => { if (live) setState({ status: "error", error }); });
    return () => { live = false; };
  }, [productId, request]);
  return state;
}

/** Where a person goes from here and returns to this page after signing in or up. */
export const authPath = (mode, returnTo = `${window.location.pathname}${window.location.search}`) => `/${mode}?returnTo=${encodeURIComponent(returnTo)}`;

/** Sign in and create account, as the two buttons a signed-out visitor gets where a signed-in person has the account menu. */
export function GuestAuthButtons({ navigate, t, className = "" }) {
  return <div className={`web-chat__guest-auth ${className}`.trim()}>
    <button type="button" className="web-chat__button" onClick={() => navigate(authPath("sign-in"))}>{t("signIn")}</button>
    <button type="button" className="web-chat__button web-chat__button--yolk" onClick={() => navigate(authPath("sign-up"))}>{t("createAccount")}</button>
  </div>;
}

export function WebChatAccountControls({ profile, onSignOut, navigate, t, className = "" }) {
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

  if (!profile) return <GuestAuthButtons navigate={navigate} t={t} className={className} />;
  return <>
    <div className={`buyer-account-controls buyer-account-controls--chat ${className}`.trim()}>
      <BuyerAccountMenu user={profile} onSignOut={() => void signOut()} signingOut={signingOut} showLanguageOptions showName />
    </div>
    {error ? <p className="web-chat__account-error" role="alert">{webChatErrorText(error, locale)}</p> : null}
  </>;
}

/** The back link every Product page has: a signed-in person's library, the catalog for a visitor. */
export function libraryLink(profile, t) {
  return profile ? { href: "/library", label: t("backToMyLibrary") } : { href: "/explore", label: t("backToDiscover") };
}

/** The full-screen states before a Product opens: checking, unable to open. */
export function ProductAgentGate({ state, navigate, profile, onSignOut, t, locale }) {
  const back = libraryLink(profile, t);
  const account = <WebChatAccountControls profile={profile} onSignOut={onSignOut} navigate={navigate} t={t} />;
  const gate = state.status === "error"
    ? <WebChatGate alert account={account} pill={t("unavailablePill")} title={t("unableToOpenChat")} body={webChatErrorText(state.error, locale)} actions={<>
      {state.error.code === "agent_unavailable" ? null : <button type="button" className="web-chat__button web-chat__button--ink" onClick={() => location.reload()}><RotateCw aria-hidden="true" />{t("retry")}</button>}
      <a href={back.href} className="web-chat__button">{back.label}</a>
    </>} />
    : <WebChatGate busy account={account} body={t("loading")} />;
  return <div className="web-chat web-chat--gate">{gate}</div>;
}
