import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button, ConfirmDialog, InlineAlert, Input } from "@hatch/ui";
import { ApiKeysClient, dateFormatter, keyRow, LOGIN_COMMAND } from "./apiKeys.js";
import { friendlyError, LoadingState } from "./studioShellKit.jsx";

/** Create, list and revoke the signed-in user's API keys. Real endpoints only. */
export function ApiKeysPage({ request, t, locale }) {
  const client = useMemo(() => new ApiKeysClient(request), [request]);
  const format = useMemo(() => dateFormatter(locale, "—"), [locale]);
  const [keys, setKeys] = useState(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState(null);

  const refresh = useCallback(() => client.list().then(setKeys), [client]);
  // Run an action; any failure is shown from the real response, success is never assumed.
  const attempt = useCallback(async (action) => {
    setBusy(true); setError("");
    try { await action(); } catch (cause) { setError(friendlyError(cause, t)); } finally { setBusy(false); }
  }, [t]);
  useEffect(() => { void attempt(refresh); }, [attempt, refresh]);

  const create = (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    void attempt(async () => { setCreated(await client.create(name)); setCopied(false); setName(""); await refresh(); });
  };
  const copy = () => navigator.clipboard?.writeText(created.token).then(() => setCopied(true)).catch((cause) => setError(friendlyError(cause, t)));
  const revoke = () => attempt(async () => { await client.revoke(revoking.id); setRevoking(null); await refresh(); });

  return <section className="sx-apikeys" aria-labelledby="sx-apikeys-title">
    <div className="sx-section-head"><h2 id="sx-apikeys-title">{t("sxNavApiKeys")}</h2><Button asChild variant="secondary"><a href="/developers">{t("sxakDevelopers")}</a></Button></div>
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
    <form className="sx-card sx-apikeys__create" onSubmit={create}>
      <Input aria-label={t("sxakNameLabel")} value={name} maxLength={80} placeholder={t("sxakNamePlaceholder")} onChange={(event) => setName(event.target.value)} />
      <Button type="submit" disabled={busy || !name.trim()}>{busy ? t("sxakCreating") : t("sxakCreate")}</Button>
    </form>
    {created ? <section className="sx-card sx-apikeys__token" aria-label={t("sxakCreatedTitle")}>
      <InlineAlert tone="warning">{t("sxakCreatedWarn")}</InlineAlert>
      <div className="sx-apikeys__copyrow">
        <Input readOnly aria-label={t("sxakTokenLabel")} value={created.token} onFocus={(event) => event.target.select()} />
        <Button type="button" variant="secondary" onClick={copy}>{copied ? t("sxakCopied") : t("sxakCopy")}</Button>
      </div>
      <code>{LOGIN_COMMAND}</code>
      <Button type="button" variant="ghost" onClick={() => setCreated(null)}>{t("sxakDone")}</Button>
    </section> : null}
    {keys === null ? (error ? null : <LoadingState t={t} />) : keys.length === 0 ? <div className="sx-empty"><h2>{t("sxakEmpty")}</h2></div> : <div className="sx-table" role="table">
      <div className="sx-apikeys__row sx-apikeys__head" role="row">{["Name", "Created", "LastUsed", "Expires"].map((column) => <span key={column} role="columnheader">{t(`sxakCol${column}`)}</span>)}<span /></div>
      {keys.map((key) => { const row = keyRow(key, format, t("sxakNever")); return <div className="sx-apikeys__row" role="row" key={row.id}>
        <strong role="cell">{row.name}</strong><span role="cell">{row.created}</span><span role="cell">{row.lastUsed}</span><span role="cell">{row.expires}</span>
        <span role="cell"><Button type="button" variant="ghost" size="small" onClick={() => setRevoking(row)}>{t("sxakRevoke")}</Button></span>
      </div>; })}
    </div>}
    <ConfirmDialog open={Boolean(revoking)} onOpenChange={(open) => { if (!open) setRevoking(null); }} title={t("sxakRevokeTitle", revoking?.name ?? "")} description={t("sxakRevokeBody")}
      confirmLabel={t("sxakRevoke")} cancelLabel={t("cancel")} destructive busy={busy} onConfirm={revoke} />
  </section>;
}
