import React from "react";
import { Check, ChevronDown, Globe } from "lucide-react";
import { DropdownMenu } from "@hatch/ui";
import { LOCALES, useLocale } from "./locale.jsx";
import "./languageSwitcher.css";

const LABELS = { zh: "中文", en: "English", ja: "日本語" };

/** The page's language as a dropdown menu: a plain trigger with the current language, a menu of the others. */
export function LanguageSwitcher({ className = "" }) {
  const { locale, setLocale } = useLocale();
  return (
    <DropdownMenu
      label="Language"
      trigger={<button type="button" className={`hatch-language-switcher ${className}`.trim()} aria-label="Language"><Globe aria-hidden="true" /><span>{LABELS[locale]}</span><ChevronDown aria-hidden="true" /></button>}
      items={LOCALES.map((value) => ({ value, label: LABELS[value], active: value === locale, icon: <Check aria-hidden="true" className={value === locale ? undefined : "hatch-language-switcher__unchecked"} />, onSelect: () => setLocale(value) }))}
    />
  );
}
