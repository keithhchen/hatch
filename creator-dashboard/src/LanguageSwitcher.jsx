import React from "react";
import { LOCALES, useLocale } from "./locale.jsx";
import "./languageSwitcher.css";

const DEFAULT_LABELS = { zh: "中文", en: "English", ja: "日本語" };
const SHORT_LABELS = { zh: "中", en: "EN", ja: "日" };

export function LanguageSwitcher({ className = "", labels = DEFAULT_LABELS, compact = false }) {
  const { locale, setLocale } = useLocale();
  const visibleLabels = compact ? SHORT_LABELS : labels;
  return (
    <div className={`hatch-language-switcher ${compact ? "is-compact" : ""} ${className}`.trim()} role="group" aria-label={labels.language ?? "Language"}>
      {LOCALES.map((value, index) => (
        <React.Fragment key={value}>
          {index ? <span aria-hidden="true">/</span> : null}
          <button type="button" className={locale === value ? "active" : ""} aria-pressed={locale === value} onClick={() => setLocale(value)}>
            {visibleLabels[value]}
          </button>
        </React.Fragment>
      ))}
    </div>
  );
}
