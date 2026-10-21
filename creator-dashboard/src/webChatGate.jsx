import React from "react";
import { WebBrand } from "./WebBrand.jsx";
import { useLocale } from "./locale.jsx";
import { webChatT } from "./webChatI18n.js";
import "./webChat.css";

/** The brand egg (same mark as the lockup), used where only a small mark fits. */
export function WebChatEgg({ size = 40, className = "" }) {
  return <svg className={`web-chat-egg ${className}`.trim()} viewBox="0 0 36 44" width={size * 0.82} height={size} aria-hidden="true">
    <path d="M18 2C9.2 2 2 16 2 26a16 16 0 0 0 32 0C34 16 26.8 2 18 2Z" fill="#F5B700" />
    <path d="M7 22l6 4 5-5 5 5 6-4" stroke="#17150F" strokeWidth="2.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />
  </svg>;
}

/**
 * A full-screen chat state (loading, unavailable, not subscribed, wrong
 * account): brand bar, one pill, one sentence, one visual, its real actions.
 */
export function WebChatGate({ pill, title, body, visual, actions, account, busy = false, alert = false }) {
  return <div className="web-chat-gate" aria-busy={busy || undefined}>
    <header className="web-chat-gate__bar">
      <WebBrand href="/explore" />
      {account}
    </header>
    <section className="web-chat-gate__body" role={alert ? "alert" : busy ? "status" : undefined}>
      <div className="web-chat-gate__visual">{visual ?? <WebChatEgg size={56} className={busy ? "web-chat-egg--bob" : ""} />}</div>
      {pill ? <span className="web-pill">{pill}</span> : null}
      {title ? <h1>{title}</h1> : null}
      {body ? <p>{body}</p> : null}
      {actions ? <div className="web-chat-gate__actions">{actions}</div> : null}
    </section>
  </div>;
}

/**
 * Shown when a signed-in account that is not a client opens a chat link.
 * Ready for main.jsx's chat route in place of the generic RoleBoundary.
 */
export function WebChatRoleGate({ navigate, onSignOut }) {
  const { locale } = useLocale();
  const t = key => webChatT(locale, key);
  return <div className="web-chat web-chat--gate">
    <WebChatGate
      pill={t("roleGatePill")}
      title={t("roleGateTitle")}
      body={t("roleGateBody")}
      actions={<>
        <button type="button" className="web-chat__button web-chat__button--yolk" onClick={() => navigate("/studio")}>{t("goToStudio")}</button>
        <button type="button" className="web-chat__button" onClick={() => void onSignOut()}>{t("switchAccount")}</button>
      </>}
    />
  </div>;
}
