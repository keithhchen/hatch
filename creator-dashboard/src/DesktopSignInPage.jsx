import React, { useState } from "react";
import { Button } from "@hatch/ui";
import { WebBrand } from "./WebBrand.jsx";
import { useLocale } from "./locale.jsx";

const copy = {
  en: {
    title: "Sign in to Hatch Desktop",
    body: "Continue as {name} in the Hatch app on this computer.",
    continue: "Open Hatch Desktop",
    working: "Opening Hatch…",
    done: "Return to Hatch. You can close this tab.",
    invalid: "This sign-in link is incomplete. Start again from Hatch Desktop.",
    failed: "Hatch couldn't finish signing in. Try again."
  },
  zh: {
    title: "登录 Hatch 桌面版",
    body: "以 {name} 的身份继续使用这台电脑上的 Hatch。",
    continue: "打开 Hatch 桌面版",
    working: "正在打开 Hatch…",
    done: "请回到 Hatch。现在可以关闭此标签页。",
    invalid: "登录链接不完整，请回到 Hatch 桌面版重新开始。",
    failed: "无法完成登录，请重试。"
  }
};

/**
 * The browser half of Desktop sign-in. The user is already signed in on the
 * web; an explicit click asks the Dashboard for a one-time code that only the
 * Desktop holding the PKCE verifier can redeem, then hands it to the app.
 */
export default function DesktopSignInPage({ search, profile, request }) {
  const { locale } = useLocale();
  const t = copy[String(locale).startsWith("zh") ? "zh" : "en"];
  const params = new URLSearchParams(search);
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const [status, setStatus] = useState(state && codeChallenge ? "ready" : "invalid");

  async function handOff() {
    setStatus("working");
    try {
      const { redirect_uri: redirect } = await request("/v1/auth/desktop/authorize", {
        method: "POST",
        body: JSON.stringify({ state, code_challenge: codeChallenge })
      });
      window.location.assign(redirect);
      setStatus("done");
    } catch {
      setStatus("failed");
    }
  }

  const name = profile?.display_name ?? profile?.name ?? "";
  return <main className="loading-page">
    <WebBrand as="span" className="loading-brand" />
    <h1>{t.title}</h1>
    <p role={status === "failed" || status === "invalid" ? "alert" : undefined}>
      {status === "invalid" ? t.invalid : status === "failed" ? t.failed : status === "done" ? t.done : t.body.replace("{name}", name)}
    </p>
    {status === "ready" || status === "failed" || status === "working"
      ? <Button type="button" loading={status === "working"} onClick={() => void handOff()}>{status === "working" ? t.working : t.continue}</Button>
      : null}
  </main>;
}
