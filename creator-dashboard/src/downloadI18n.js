const COPY = Object.freeze({
  en: Object.freeze({ documentTitle: "Download Hatch · Hatch", homeLabel: "Hatch home", title: "Download Hatch.", downloadsLabel: "Desktop downloads", detecting: "Checking this device…", recommended: (device) => `Recommended for this device: ${device}`, chooseDevice: "Choose the version for your computer.", appleSilicon: "Apple Silicon", intel: "Intel", mac: (architecture) => `Mac · ${architecture}`, windows: "Windows · x64", recommendedLabel: "Recommended", unavailable: "Downloads are temporarily unavailable.", tryAgain: "Try again" }),
  zh: Object.freeze({ documentTitle: "下载 Hatch · Hatch", homeLabel: "Hatch 首页", title: "下载 Hatch。", downloadsLabel: "桌面版下载", detecting: "正在识别这台设备…", recommended: (device) => `适合这台电脑：${device}`, chooseDevice: "请选择适合你电脑的版本。", appleSilicon: "Apple 芯片", intel: "Intel 芯片", mac: (architecture) => `Mac · ${architecture}`, windows: "Windows · x64", recommendedLabel: "推荐", unavailable: "下载暂时不可用。", tryAgain: "重试" }),
  ja: Object.freeze({ documentTitle: "Hatch をダウンロード · Hatch", homeLabel: "Hatch ホーム", title: "Hatch をダウンロード。", downloadsLabel: "デスクトップ版のダウンロード", detecting: "このデバイスを確認しています…", recommended: (device) => `このデバイスにおすすめ：${device}`, chooseDevice: "お使いのコンピュータに合うバージョンを選んでください。", appleSilicon: "Apple シリコン", intel: "Intel", mac: (architecture) => `Mac · ${architecture}`, windows: "Windows · x64", recommendedLabel: "おすすめ", unavailable: "現在ダウンロードできません。", tryAgain: "再試行" })
});

export function normalizeDownloadLocale(locale) {
  const value = String(locale ?? "").toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ja")) return "ja";
  return "en";
}

export function downloadCopy(locale) { return COPY[normalizeDownloadLocale(locale)]; }
