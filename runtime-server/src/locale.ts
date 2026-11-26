/**
 * The visitor's language on the access-code funnel. The same rules as creator-dashboard/localeCore.mjs (`normalizeLocale`), which the
 * Runtime image does not ship; anything that is not zh, en or ja is Chinese, as the funnel was before it had languages.
 */
export const LOCALES = ["zh", "en", "ja"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "zh";

export function normalizeLocale(value: unknown): Locale | null {
  const tag = String(value ?? "").trim().toLowerCase();
  return LOCALES.find(locale => tag === locale || tag.startsWith(`${locale}-`)) ?? null;
}

export const localeOf = (value: unknown): Locale => normalizeLocale(value) ?? DEFAULT_LOCALE;
