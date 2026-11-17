import React, { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";
import { WebChatGate } from "./webChatGate.jsx";
import { claimImLink } from "./imLink.js";
import { useLocale } from "./locale.jsx";
import { webChatT } from "./webChatI18n.js";
import { WebChatRoute } from "./webChatRoute.js";

const TEXT = Object.freeze({ linked: "imLinkDone", invalid: "imLinkInvalid", expired: "imLinkExpired", alreadyLinked: "imLinkAlreadyLinked", unavailable: "imLinkUnavailable" });

/** Signed in, claims the IM chat once and says how it went. */
export default function ImLinkPage({ search, request, navigate }) {
  const { locale } = useLocale();
  const t = useCallback(key => webChatT(locale, key), [locale]);
  const [state, setState] = useState({ status: "claiming" });
  const claiming = useRef(false);

  const claim = useCallback(() => {
    if (claiming.current) return;
    claiming.current = true;
    setState({ status: "claiming" });
    claimImLink(request, search).then(setState).finally(() => { claiming.current = false; });
  }, [request, search]);
  useEffect(claim, [claim]);

  if (state.status === "claiming") return <div className="web-chat web-chat--gate"><WebChatGate busy body={t("loading")} /></div>;
  const actions = state.status === "linked"
    ? <button type="button" className="web-chat__button web-chat__button--yolk" onClick={() => navigate(WebChatRoute.productPath(state.productId))}>{t("imLinkOpen")}</button>
    : state.status === "unavailable"
      ? <button type="button" className="web-chat__button web-chat__button--ink" onClick={claim}><RotateCw aria-hidden="true" />{t("retry")}</button>
      : null;
  return <div className="web-chat web-chat--gate"><WebChatGate alert={state.status !== "linked"} body={t(TEXT[state.status])} actions={actions} /></div>;
}
