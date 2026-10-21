const COPY = Object.freeze({
  en: Object.freeze({
    documentTitle: "Download Hatch · Hatch",
    homeLabel: "Hatch home",
    title: "Download Hatch",
    lead: "No need to install anything to chat: Agents you add work in your browser. Hatch Desktop is for working with files on your computer; sign in with your Hatch account.",
    downloadsLabel: "Desktop downloads",
    detecting: "Checking this device…",
    recommended: (device) => `Recommended for this device: ${device}`,
    chooseDevice: "Choose the version for your computer.",
    appleSilicon: "Apple Silicon",
    intel: "Intel",
    mac: (architecture) => `Mac · ${architecture}`,
    windows: "Windows · x64",
    recommendedLabel: "Recommended",
    unavailable: "Downloads are temporarily unavailable",
    unavailableBody: "The installers cannot be reached. Try again later.",
    tryAgain: "Try again",
    webTitle: "Hatch on the web",
    webBody: "Added Agents are also available in the browser.",
    webAction: "Open library"
  }),
  zh: Object.freeze({
    documentTitle: "下载 Hatch · Hatch",
    homeLabel: "Hatch 首页",
    title: "下载 Hatch",
    lead: "只是对话的话不用安装：已添加的 Agent 在浏览器里就能用。需要处理本机文件时再用 Hatch Desktop，用 Hatch 账户登录即可。",
    downloadsLabel: "桌面版下载",
    detecting: "正在检测设备…",
    recommended: (device) => `推荐本机使用：${device}`,
    chooseDevice: "请选择适合本机的版本。",
    appleSilicon: "Apple 芯片",
    intel: "Intel 芯片",
    mac: (architecture) => `Mac · ${architecture}`,
    windows: "Windows · x64",
    recommendedLabel: "推荐",
    unavailable: "下载暂时不可用",
    unavailableBody: "暂时无法获取安装包，请稍后重试。",
    tryAgain: "重试",
    webTitle: "网页版 Hatch",
    webBody: "已添加的 Agent 也可在浏览器中使用。",
    webAction: "打开资料库"
  }),
  ja: Object.freeze({
    documentTitle: "Hatch をダウンロード · Hatch",
    homeLabel: "Hatch ホーム",
    title: "Hatch をダウンロード",
    lead: "会話だけならインストールは不要です。追加した Agent はブラウザで使えます。パソコン上のファイルを扱うときは Hatch Desktop を使い、Hatch アカウントでログインしてください。",
    downloadsLabel: "デスクトップ版のダウンロード",
    detecting: "このデバイスを確認しています…",
    recommended: (device) => `このデバイスの推奨版：${device}`,
    chooseDevice: "お使いのパソコンに対応するバージョンを選択してください。",
    appleSilicon: "Apple シリコン",
    intel: "Intel",
    mac: (architecture) => `Mac · ${architecture}`,
    windows: "Windows · x64",
    recommendedLabel: "推奨",
    unavailable: "現在ダウンロードできません",
    unavailableBody: "インストーラーに接続できません。しばらくしてから再度お試しください。",
    tryAgain: "再試行",
    webTitle: "Web 版 Hatch",
    webBody: "追加した Agent はブラウザでも利用できます。",
    webAction: "ライブラリを開く"
  })
});

export function normalizeDownloadLocale(locale) {
  const value = String(locale ?? "").toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ja")) return "ja";
  return "en";
}

export function downloadCopy(locale) { return COPY[normalizeDownloadLocale(locale)]; }
