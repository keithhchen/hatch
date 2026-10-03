import React, { useRef, useState } from "react";
import { Avatar, Button } from "@hatch/ui";
import { dashboardRequest } from "./data.js";
import "./accountAvatarSettings.css";

export function AccountAvatarSettings({ user, onUserUpdated, t }) {
  const inputRef = useRef(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  async function upload(event) {
    const image = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!image) return;
    setStatus("pending");
    setError("");
    try {
      const profile = await dashboardRequest("/v1/auth/me/avatar", {
        method: "PUT",
        body: image,
        headers: { "content-type": image.type }
      });
      onUserUpdated(profile);
      setStatus("saved");
    } catch (cause) {
      setStatus("idle");
      setError(cause.message);
    }
  }

  async function remove() {
    if (!user?.avatar_url || status === "pending") return;
    setStatus("pending");
    setError("");
    try {
      const profile = await dashboardRequest("/v1/auth/me/avatar", { method: "DELETE" });
      onUserUpdated(profile);
      setStatus("removed");
    } catch (cause) {
      setStatus("idle");
      setError(cause.message);
    }
  }

  return <section className="account-avatar-settings" aria-label={t("Profile photo")}>
    <Avatar className="account-avatar-settings__image" src={user?.avatar_url} name={user?.display_name} size="large" />
    <div className="account-avatar-settings__content">
      <h3>{t("Profile photo")}</h3>
      <p>{t("Your photo appears beside your account and Agent identity.")}</p>
      <div className="account-avatar-settings__actions">
        <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" aria-label={t("Choose a profile photo")} onChange={upload} />
        <Button type="button" variant="secondary" loading={status === "pending"} onClick={() => inputRef.current?.click()}>{t("Upload photo")}</Button>
        {user?.avatar_url ? <Button type="button" variant="ghost" disabled={status === "pending"} onClick={() => void remove()}>{t("Remove photo")}</Button> : null}
      </div>
      {status === "saved" ? <p className="account-avatar-settings__status" role="status">{t("Profile photo updated.")}</p> : null}
      {status === "removed" ? <p className="account-avatar-settings__status" role="status">{t("Profile photo removed.")}</p> : null}
      {error ? <p className="account-avatar-settings__error" role="alert">{error}</p> : null}
    </div>
  </section>;
}
