import React from "react";
import { Select } from "@hatch/ui";
import { LOCALES, useLocale } from "./locale.jsx";
import "./languageSwitcher.css";

const LABELS = { zh: "中文", en: "English", ja: "日本語" };

export function LanguageSwitcher({ className = "" }) {
  const { locale, setLocale } = useLocale();
  return (
    <Select
      className={`hatch-language-switcher ${className}`.trim()}
      size="compact"
      value={locale}
      onValueChange={setLocale}
      options={LOCALES.map((value) => ({ value, label: LABELS[value] }))}
      label="Language"
    />
  );
}
