import React from "react";
import { Check, ChevronDown, Globe2, LogOut } from "lucide-react";
import { Avatar, DropdownMenu } from "@hatch/ui";
import { buyerT } from "./buyerI18n.js";
import { LOCALES, useLocale } from "./locale.jsx";
import "./buyerAccountControls.css";

const LANGUAGES = Object.freeze({
  en: { label: "English", shortLabel: "EN" },
  zh: { label: "中文", shortLabel: "中" },
  ja: { label: "日本語", shortLabel: "日" }
});

export function BuyerLanguageMenu({ className = "" }) {
  const { locale, setLocale } = useLocale();
  const language = LANGUAGES[locale];
  const t = key => buyerT(locale, key);

  return (
    <DropdownMenu
      label={t("Language")}
      trigger={(
        <button type="button" className={`buyer-account-controls__language ${className}`.trim()} aria-label={`${t("Change language")}: ${language.label}`} title={`${t("Change language")}: ${language.label}`}>
          <Globe2 aria-hidden="true" />
          <span>{language.shortLabel}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      )}
      items={LOCALES.map(value => ({
        value,
        label: LANGUAGES[value].label,
        icon: <Check className={locale === value ? undefined : "buyer-account-controls__menu-check-placeholder"} aria-hidden="true" />,
        active: locale === value,
        onSelect: () => setLocale(value)
      }))}
    />
  );
}

export function BuyerAccountMenu({ user, onSignOut, signingOut = false, showLanguageOptions = false, className = "" }) {
  const { locale, setLocale } = useLocale();
  const t = key => buyerT(locale, key);
  const displayName = user?.display_name || user?.name || user?.email || t("Hatch account");
  const email = user?.email;

  return (
    <DropdownMenu
      label={t("Account settings")}
      trigger={(
        <button type="button" className={`buyer-account-controls__avatar ${className}`.trim()} aria-label={`${t("Account settings")}: ${displayName}`} title={displayName} aria-busy={signingOut || undefined}>
          <Avatar className="buyer-account-controls__avatar-image" src={user?.avatar_url} name={displayName} size="medium" />
        </button>
      )}
      items={[
        {
          type: "label",
          label: (
            <span className="buyer-account-controls__identity">
              <strong>{displayName}</strong>
              {email ? <small>{email}</small> : null}
            </span>
          )
        },
        { type: "separator" },
        ...(showLanguageOptions ? [
          { type: "label", label: t("Language") },
          ...LOCALES.map(value => ({
            value: `language-${value}`,
            label: LANGUAGES[value].label,
            icon: <Check className={locale === value ? undefined : "buyer-account-controls__menu-check-placeholder"} aria-hidden="true" />,
            active: locale === value,
            onSelect: () => setLocale(value)
          })),
          { type: "separator" }
        ] : []),
        { value: "sign-out", label: t(signingOut ? "Signing out…" : "Sign out"), icon: <LogOut aria-hidden="true" />, destructive: true, disabled: signingOut, onSelect: onSignOut }
      ]}
    />
  );
}

export function BuyerAccountControls({ user, onSignOut, signingOut = false, children, className = "" }) {
  return (
    <div className={`buyer-account-controls ${className}`.trim()}>
      <BuyerLanguageMenu />
      {children}
      <BuyerAccountMenu user={user} onSignOut={onSignOut} signingOut={signingOut} />
    </div>
  );
}
