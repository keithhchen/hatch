import { LOCALES, documentLanguage, normalizeLocale, pickLocale } from "../localeCore.mjs";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export { LOCALES, documentLanguage, normalizeLocale };
export const LOCALE_STORAGE_KEY = "hatch.locale";

const LocaleContext = createContext(null);

export function readInitialLocale(storage, browser) {
  try {
    const saved = normalizeLocale((storage ?? globalThis.localStorage)?.getItem(LOCALE_STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  const browserSettings = browser ?? globalThis.navigator;
  const candidates = browserSettings?.languages?.length ? browserSettings.languages : [browserSettings?.language];
  return pickLocale(candidates);
}

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(() => readInitialLocale());
  const setLocale = useCallback((value) => {
    const next = normalizeLocale(value);
    if (!next) return;
    setLocaleState(next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // The in-memory selection still applies for this session.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = documentLanguage(locale);
  }, [locale]);

  useEffect(() => {
    const syncLocale = (event) => {
      if (event.key !== LOCALE_STORAGE_KEY) return;
      const next = normalizeLocale(event.newValue);
      if (next) setLocaleState(next);
    };
    window.addEventListener("storage", syncLocale);
    return () => window.removeEventListener("storage", syncLocale);
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useLocale must be used inside LocaleProvider");
  return context;
}
