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

/** A visible text given as one string, or one per language; the web picks the reader's, a model gets `textIn`. */
export type LocalizedText = string | Partial<Record<Locale, string>>;

/** The text as given, trimmed: empty languages dropped, languages in a fixed order (so a digest of it is stable); undefined when nothing is left. */
export function normalizeLocalizedText(value: unknown): LocalizedText | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const given = Object.fromEntries(LOCALES.flatMap(locale => {
    const text = (value as Record<string, unknown>)[locale];
    return typeof text === "string" && text.trim() ? [[locale, text.trim()]] : [];
  }));
  return Object.keys(given).length ? given : undefined;
}

/** The text in one language, else Chinese, else the first one given. */
export const textIn = (text: LocalizedText, locale: Locale = DEFAULT_LOCALE): string =>
  typeof text === "string" ? text : (text[locale] ?? text.zh ?? Object.values(text).find(Boolean) ?? "");
