const COPY = Object.freeze({
  en: Object.freeze({
    documentTitle: "Download Hatch · Hatch",
    homeLabel: "Hatch home",
    pill: "Download",
    title: "Get Hatch for your computer.",
    lead: "Hatch Desktop works with the files on your own computer. Sign in with the same account you use on the web.",
    downloadsLabel: "Desktop downloads",
    detecting: "Checking this device…",
    recommended: (device) => `Recommended for this device: ${device}`,
    chooseDevice: "Choose the version for your computer.",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    mac: (architecture) => `Mac · ${architecture}`,
    windows: "Windows · x64",
    recommendedLabel: "Recommended",
    unavailable: "Downloads are temporarily unavailable.",
    unavailableBody: "The installers aren't reachable from here right now. Try again in a little while.",
    tryAgain: "Try again",
    webTitle: "No install needed to start.",
    webBody: "Everything you add also works right in your browser.",
    webAction: "Open Hatch on the web",
    caption: "Same account, same experts, on Mac and Windows."
  }),
  zh: Object.freeze({
    documentTitle: "下载 Hatch · Hatch",
    homeLabel: "Hatch 首页",
    pill: "下载",
    title: "把 Hatch 装到电脑上。",
    lead: "Hatch Desktop 可以直接处理你电脑上的文件。用和网页一样的账户登录就行。",
    downloadsLabel: "桌面版下载",
    detecting: "正在识别这台设备…",
    recommended: (device) => `适合这台电脑：${device}`,
    chooseDevice: "选一个适合你电脑的版本。",
    appleSilicon: "Apple 芯片",
    intel: "Intel 芯片",
    mac: (architecture) => `Mac · ${architecture}`,
    windows: "Windows · x64",
    recommendedLabel: "推荐",
    unavailable: "下载暂时不可用。",
    unavailableBody: "安装包现在连不上，过一会儿再试试。",
    tryAgain: "重试",
    webTitle: "不装也能先用起来。",
    webBody: "你添加的专家 Agent，在浏览器里一样能用。",
    webAction: "在网页上打开 Hatch",
    caption: "同一个账户、同一批专家，Mac 和 Windows 都能用。"
  }),
  ja: Object.freeze({
    documentTitle: "Hatch をダウンロード · Hatch",
    homeLabel: "Hatch ホーム",
    pill: "ダウンロード",
    title: "Hatch をパソコンで使う。",
    lead: "Hatch Desktop なら、パソコンの中のファイルをそのまま扱えます。Web と同じアカウントでログインしてください。",
    downloadsLabel: "デスクトップ版のダウンロード",
    detecting: "このデバイスを確認しています…",
    recommended: (device) => `このデバイスにおすすめ：${device}`,
    chooseDevice: "お使いのパソコンに合うバージョンを選んでください。",
    appleSilicon: "Apple シリコン",
    intel: "Intel",
    mac: (architecture) => `Mac · ${architecture}`,
    windows: "Windows · x64",
    recommendedLabel: "おすすめ",
    unavailable: "現在ダウンロードできません。",
    unavailableBody: "いまはインストーラーに接続できません。少し時間をおいてお試しください。",
    tryAgain: "再試行",
    webTitle: "インストールしなくても始められます。",
    webBody: "追加した Agent は、ブラウザでもそのまま使えます。",
    webAction: "Web で Hatch を開く",
    caption: "Mac でも Windows でも、同じアカウントで同じ専門家に。"
  })
});

export function normalizeDownloadLocale(locale) {
  const value = String(locale ?? "").toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ja")) return "ja";
  return "en";
}

export function downloadCopy(locale) { return COPY[normalizeDownloadLocale(locale)]; }
