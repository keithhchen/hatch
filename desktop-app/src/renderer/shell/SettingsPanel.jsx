import React, { useState } from "react";
import { ExternalLink, LogOut, SlidersHorizontal, UserRound, Wrench } from "lucide-react";
import { Avatar, Dialog, DialogContent, Select } from "@hatch/ui";
import { ACCOUNT_URL } from "../config.js";
import { folderName } from "../chat/local-tools.js";
import { LANGUAGE_OPTIONS, SYSTEM_LANGUAGE, resolveLanguage, systemLocales } from "../i18n.js";
import { useObservable } from "../observable.js";
import { useDesktop } from "./context.js";
import { ZOOM_OPTIONS } from "./layout.js";
import { THEMES } from "./preferences.js";

function Row({ label, children }) {
  return <div className="desk-settings__row"><span className="desk-settings__label">{label}</span><div className="desk-settings__control">{children}</div></div>;
}

function General() {
  const { app, t } = useDesktop();
  const preferences = useObservable(app.preferences);
  const ui = useObservable(app);
  const [error, setError] = useState(false);
  const save = (key, value) => { setError(false); void app.preferences.set(key, value).catch(() => setError(true)); };
  const systemName = LANGUAGE_OPTIONS.find(option => option.value === resolveLanguage(SYSTEM_LANGUAGE, systemLocales()))?.nativeLabel ?? "English";
  return <>
    <Row label={t("settings.language")}>
      <Select size="compact" label={t("settings.language")} value={preferences.language} onValueChange={value => save("language", value)}
        options={LANGUAGE_OPTIONS.map(option => ({ value: option.value, label: option.nativeLabel ?? t(option.labelKey, { language: systemName }) }))} />
    </Row>
    <Row label={t("settings.theme")}>
      <Select size="compact" label={t("settings.theme")} value={preferences.theme} onValueChange={value => save("theme", value)}
        options={THEMES.map(theme => ({ value: theme, label: t(`theme.${theme}`) }))} />
    </Row>
    <Row label={t("settings.textSize")}>
      <Select size="compact" label={t("settings.textSize")} value={String(ui.zoom)} onValueChange={value => app.setZoom(Number(value))}
        options={ZOOM_OPTIONS.map(zoom => ({ value: String(zoom), label: `${Math.round(zoom * 100)}%` }))} />
    </Row>
    {error ? <p className="desk-form-error" role="alert">{t("settings.saveFailed")}</p> : null}
  </>;
}

function Account() {
  const { app, t } = useDesktop();
  const { account } = useObservable(app.session);
  return <>
    <div className="desk-settings__account">
      <Avatar src={account?.avatarUrl} name={account?.name ?? ""} size="medium" />
      <div><small>{t("settings.signedInAs")}</small><strong className="selectable">{account?.name}</strong>{account?.email ? <span className="selectable">{account.email}</span> : null}</div>
    </div>
    <div className="desk-settings__actions">
      <button type="button" className="desk-button" onClick={() => void app.openWeb(ACCOUNT_URL)}><ExternalLink aria-hidden="true" />{t("settings.manageAccount")}</button>
      <button type="button" className="desk-button desk-button--danger" onClick={() => void app.signOut()}><LogOut aria-hidden="true" />{t("settings.signOut")}</button>
    </div>
  </>;
}

function Advanced() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const session = app.currentSession;
  const workspace = useObservable(session?.workspace ?? app);
  const grant = session && workspace.status === "granted" ? workspace.grant : null;
  return <>
    <Row label={t("settings.folder")}>
      {grant
        ? <><span className="desk-settings__value selectable" title={grant.display_path}>{folderName(grant.display_path)}</span>
          <button type="button" className="desk-button" onClick={() => void session.workspace.revoke().catch(error => session.controller.fail(error))}>{t("settings.revokeFolder")}</button></>
        : <span className="desk-settings__value">{t("settings.folderNone")}</span>}
    </Row>
    <Row label={t("settings.version")}><span className="desk-settings__value selectable">{ui.version || "—"}</span></Row>
  </>;
}

const SECTIONS = [
  { id: "general", icon: SlidersHorizontal, label: "settings.general", Panel: General },
  { id: "account", icon: UserRound, label: "settings.account", Panel: Account },
  { id: "advanced", icon: Wrench, label: "settings.advanced", Panel: Advanced }
];

/** Settings is a sheet over the main window (⌘, or the account menu). */
export function SettingsPanel() {
  const { app, t } = useDesktop();
  const ui = useObservable(app);
  const [section, setSection] = useState("general");
  const current = SECTIONS.find(item => item.id === section);
  return <Dialog open={ui.overlay === "settings"} onOpenChange={open => { if (!open) app.closeOverlay(); }}>
    <DialogContent title={t("settings.title")} className="desk-settings">
      <div className="desk-settings__layout">
        <nav className="desk-settings__nav" aria-label={t("settings.title")}>
          {SECTIONS.map(item => <button key={item.id} type="button" className="desk-row" aria-current={item.id === section ? "page" : undefined} onClick={() => setSection(item.id)}>
            <item.icon aria-hidden="true" /><span className="desk-row__label">{t(item.label)}</span>
          </button>)}
        </nav>
        <section className="desk-settings__panel" aria-label={t(current.label)}><current.Panel /></section>
      </div>
    </DialogContent>
  </Dialog>;
}
