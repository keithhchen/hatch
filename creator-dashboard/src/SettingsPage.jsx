import React, { useEffect, useState } from "react";
import { InlineAlert, Switch } from "@hatch/ui";
import { ApiKeysPage } from "./ApiKeysPage.jsx";
import { ChannelBindings } from "./ChannelBindings.jsx";
import { EarlyAccessClient, isEarlyAccess } from "./earlyAccess.js";
import { PageHeader, friendlyError } from "./studioShellKit.jsx";

/** Studio settings: early access, the Expert's messaging apps and API keys. */
export function SettingsPage({ request, t, locale, profile, onProfileChange }) {
  const earlyAccess = isEarlyAccess(profile);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const toggle = async (enabled) => {
    setError(null);
    setSaving(true);
    onProfileChange({ ...profile, early_access: enabled });
    try {
      onProfileChange({ ...profile, early_access: await new EarlyAccessClient(request).set(enabled) });
    } catch (failure) {
      onProfileChange({ ...profile, early_access: !enabled });
      setError(friendlyError(failure, t));
    } finally {
      setSaving(false);
    }
  };
  // Deep link from the Agent Overview banner: /studio/settings#api-keys.
  useEffect(() => { if (window.location.hash === "#api-keys") document.getElementById("api-keys")?.scrollIntoView(); }, []);
  return <div className="sx-settings">
    <PageHeader title={t("sxNavSettings")} />
    <section className="sx-settings__section">
      <Switch label={t("sxEarlyAccess")} checked={earlyAccess} disabled={saving} onCheckedChange={toggle} />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    </section>
    {earlyAccess ? <section className="sx-settings__section" aria-labelledby="sx-messaging-title">
      <h2 id="sx-messaging-title">{t("sxaReachMe")}</h2>
      <ChannelBindings request={request} t={t} />
    </section> : null}
    <ApiKeysPage request={request} t={t} locale={locale} />
  </div>;
}
