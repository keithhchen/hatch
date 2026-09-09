import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  getWebLocale,
  localeLabel,
  resolveWebLocale,
  setDocumentLocale,
  setWebLocale,
  translateWeb,
  WEB_LOCALES
} from "./webI18n.js";

const WebLocaleContext = createContext(null);

export function WebLocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(resolveWebLocale);
  const setLocale = useCallback((next) => {
    const value = setWebLocale(next);
    setLocaleState(value);
    return value;
  }, []);

  useEffect(() => {
    setDocumentLocale(locale);
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    locales: WEB_LOCALES,
    t: (key, ...args) => translateWeb(locale, key, ...args)
  }), [locale, setLocale]);

  return <WebLocaleContext.Provider value={value}>{children}</WebLocaleContext.Provider>;
}

export function useWebLocale() {
  const value = useContext(WebLocaleContext);
  if (value) return value;
  const locale = getWebLocale();
  return {
    locale,
    setLocale: setWebLocale,
    locales: WEB_LOCALES,
    t: (key, ...args) => translateWeb(locale, key, ...args)
  };
}

export function WebLanguagePicker({ className = "" }) {
  const { locale, setLocale, locales, t } = useWebLocale();
  return (
    <label className={`web-language-picker${className ? ` ${className}` : ""}`}>
      <span className="web-language-picker__label">{t("common.language")}</span>
      <select aria-label={t("common.languageSwitcher")} value={locale} onChange={(event) => setLocale(event.target.value)}>
        {locales.map((value) => <option key={value} value={value}>{localeLabel(value)}</option>)}
      </select>
    </label>
  );
}
