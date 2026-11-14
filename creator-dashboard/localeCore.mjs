// The locale rules that need no React: the supported languages, normalising a language tag, the document language,
// and picking a locale from an ordered list of candidates. src/locale.jsx (browser) and helpSeo.mjs (server) share them.
// Lives at the dashboard root, not src/, because the server image ships only the root .mjs files.
export const LOCALES = ["en", "zh", "ja"];

export function normalizeLocale(value) {
  const locale = String(value ?? "").trim().toLowerCase();
  if (locale === "zh" || locale.startsWith("zh-")) return "zh";
  if (locale === "ja" || locale.startsWith("ja-")) return "ja";
  if (locale === "en" || locale.startsWith("en-")) return "en";
  return null;
}

export function documentLanguage(locale) {
  return locale === "zh" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en";
}

/** The first supported locale in an ordered candidate list, else English. */
export function pickLocale(candidates) {
  for (const candidate of candidates ?? []) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return "en";
}
