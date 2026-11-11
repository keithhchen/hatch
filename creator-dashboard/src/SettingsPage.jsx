import React from "react";
import { ApiKeysPage } from "./ApiKeysPage.jsx";
import { ChannelBindings } from "./ChannelBindings.jsx";
import { PageHeader } from "./studioShellKit.jsx";

/** Studio settings: where the Expert's messaging apps and API keys are managed. */
export function SettingsPage({ request, t, locale }) {
  return <div className="sx-settings">
    <PageHeader title={t("sxNavSettings")} />
    <section className="sx-settings__section" aria-labelledby="sx-messaging-title">
      <h2 id="sx-messaging-title">{t("sxaReachMe")}</h2>
      <ChannelBindings request={request} t={t} />
    </section>
    <ApiKeysPage request={request} t={t} locale={locale} />
  </div>;
}
