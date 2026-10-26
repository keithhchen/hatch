import React, { useEffect, useMemo, useState } from "react";
import { HatchBrand } from "@hatch/ui";
import { NativeTokenStore } from "../auth/account.js";
import { BrowserSignIn } from "../auth/browser-sign-in.js";
import { errorText } from "../i18n.js";
import { emitNativeEvent, nativeInvoke, onNativeEvent, openInBrowser, revealWhenPainted } from "../native/bridge.js";
import { useObservable } from "../observable.js";
import { AUTH_SESSION_EVENT } from "./desktop-window.js";
import { AppPreferences } from "./preferences.js";

/**
 * The small fixed sign-in window: one action, "Continue in Browser". The
 * system browser signs the user in and returns through hatch://auth/callback;
 * this window stores the new session and tells the main window.
 */
export function WelcomeWindow() {
  const preferences = useMemo(() => new AppPreferences({ invoke: nativeInvoke, emit: emitNativeEvent, onEvent: onNativeEvent }), []);
  const signIn = useMemo(() => new BrowserSignIn({ openUrl: openInBrowser }), []);
  const { language } = useObservable(preferences);
  const t = useMemo(() => preferences.t, [preferences, language]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);

  useEffect(() => {
    void preferences.load().finally(revealWhenPainted);
    return onNativeEvent("hatch://auth-callback", async payload => {
      setStatus("signing");
      setError(null);
      try {
        const { token, expiresAt } = await signIn.complete(payload ?? {});
        await new NativeTokenStore(nativeInvoke).write(token, expiresAt);
        await emitNativeEvent(AUTH_SESSION_EVENT, { kind: "signed-in" });
      } catch (cause) {
        setError(cause);
        setStatus("idle");
      }
    });
  }, [preferences, signIn]);

  const start = async () => {
    setError(null);
    try {
      await signIn.start();
      setStatus("waiting");
    } catch (cause) {
      setError(cause);
      setStatus("idle");
    }
  };

  return <main className="desk-welcome" data-tauri-drag-region>
    <HatchBrand className="desk-welcome__brand" aria-label="Hatch" />
    <h1 data-tauri-drag-region>{t("welcome.title")}</h1>
    <p data-tauri-drag-region>{status === "waiting" ? t("welcome.waiting") : t("welcome.body")}</p>
    {error ? <p className="desk-form-error" role="alert">{errorText(t, error)}</p> : null}
    <button type="button" className="desk-button desk-button--primary desk-button--large" disabled={status === "signing"} onClick={() => void start()}>
      {status === "signing" ? t("welcome.signingIn") : status === "waiting" ? t("welcome.again") : t("welcome.continue")}
    </button>
  </main>;
}
