import React, { useState } from "react";
import { Button } from "@hatch/ui";
import { WebBrand } from "./WebBrand.jsx";
import { useLocale } from "./locale.jsx";

const desktopCopy = {
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
  },
  ja: {
    title: "Hatch デスクトップ版にログイン",
    body: "このコンピューターの Hatch で {name} として続けます。",
    continue: "Hatch デスクトップ版を開く",
    working: "Hatch を開いています…",
    done: "Hatch に戻ってください。このタブは閉じてかまいません。",
    invalid: "ログインリンクが不完全です。Hatch デスクトップ版からやり直してください。",
    failed: "ログインを完了できませんでした。もう一度お試しください。"
  }
};

// The same page signs in each native client; each brings its own copy.
const cliCopy = {
  en: {
    title: "Sign in to the Hatch CLI",
    body: "Continue as {name}.",
    continue: "Sign in",
    working: "Signing in…",
    done: "Signed in. Return to your terminal.",
    invalid: "This sign-in link is incomplete. Run hatch login again.",
    failed: "Hatch couldn't finish signing in. Try again."
  },
  zh: {
    title: "登录 Hatch 命令行",
    body: "以 {name} 的身份继续。",
    continue: "登录",
    working: "正在登录…",
    done: "已登录，请回到终端。",
    invalid: "登录链接不完整，请重新运行 hatch login。",
    failed: "无法完成登录，请重试。"
  },
  ja: {
    title: "Hatch CLI にログイン",
    body: "{name} として続けます。",
    continue: "ログイン",
    working: "ログインしています…",
    done: "ログインしました。ターミナルに戻ってください。",
    invalid: "ログインリンクが不完全です。hatch login をもう一度実行してください。",
    failed: "ログインを完了できませんでした。もう一度お試しください。"
  }
};
const CLIENT_COPY = { desktop: desktopCopy, cli: cliCopy };
const copyFor = (locale, client) => {
  const copy = CLIENT_COPY[client] ?? desktopCopy;
  return copy[locale] ?? copy.en;
};

/**
 * The browser half of Desktop sign-in. The user is already signed in on the
 * web; an explicit click asks the Dashboard for a one-time code that only the
 * Desktop holding the PKCE verifier can redeem, then hands it to the app.
 */
export default function DesktopSignInPage({ search, profile, request }) {
  const { locale } = useLocale();
  const params = new URLSearchParams(search);
  const t = copyFor(String(locale).slice(0, 2), params.get("client"));
  const redirectUri = params.get("redirect_uri");
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const [status, setStatus] = useState(state && codeChallenge ? "ready" : "invalid");

  async function handOff() {
    setStatus("working");
    try {
      const { redirect_uri: redirect } = await request("/v1/auth/desktop/authorize", {
        method: "POST",
        body: JSON.stringify({ state, code_challenge: codeChallenge, ...(redirectUri ? { redirect_uri: redirectUri } : {}) })
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
