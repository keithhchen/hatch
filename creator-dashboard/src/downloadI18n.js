const COPY = Object.freeze({
  en: Object.freeze({ documentTitle: "Download Hatch · Hatch", homeLabel: "Hatch home", title: "Download Hatch.", downloadsLabel: "Desktop downloads", detecting: "Checking this device…", recommended: (architecture) => `Recommended for this Mac: ${architecture}`, windowsNotice: "Hatch for Windows is coming soon.", chooseMac: "Choose the Mac that matches your computer.", appleSilicon: "Apple Silicon", intel: "Intel", mac: (architecture) => `Mac · ${architecture}`, windows: "Windows", recommendedLabel: "Recommended", comingSoon: "Coming soon", unavailable: "Downloads are temporarily unavailable.", tryAgain: "Try again" }),
  zh: Object.freeze({ documentTitle: "下载 Hatch · Hatch", homeLabel: "Hatch 首页", title: "下载 Hatch。", downloadsLabel: "桌面版下载", detecting: "正在识别这台设备…", recommended: (architecture) => `适合这台 Mac：${architecture}`, windowsNotice: "Hatch Windows 版即将推出。", chooseMac: "请选择与你的电脑匹配的 Mac 版本。", appleSilicon: "Apple 芯片", intel: "Intel 芯片", mac: (architecture) => `Mac · ${architecture}`, windows: "Windows", recommendedLabel: "推荐", comingSoon: "即将推出", unavailable: "下载暂时不可用。", tryAgain: "重试" }),
  ja: Object.freeze({ documentTitle: "Hatch をダウンロード · Hatch", homeLabel: "Hatch ホーム", title: "Hatch をダウンロード。", downloadsLabel: "デスクトップ版のダウンロード", detecting: "このデバイスを確認しています…", recommended: (architecture) => `この Mac におすすめ：${architecture}`, windowsNotice: "Hatch の Windows 版は近日公開予定です。", chooseMac: "お使いのコンピュータに合う Mac 版を選んでください。", appleSilicon: "Apple シリコン", intel: "Intel", mac: (architecture) => `Mac · ${architecture}`, windows: "Windows", recommendedLabel: "おすすめ", comingSoon: "近日公開", unavailable: "現在ダウンロードできません。", tryAgain: "再試行" })
});

export function normalizeDownloadLocale(locale) {
  const value = String(locale ?? "").toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("ja")) return "ja";
  return "en";
}

export function downloadCopy(locale) { return COPY[normalizeDownloadLocale(locale)]; }
