import React, { useEffect, useMemo, useState } from "react";
import { Copy, Download, Eye, EyeOff, ExternalLink } from "lucide-react";
import { Button, ConfirmDialog, Input } from "@hatch/ui";
import { InlineError, LoadingState, SectionHead, friendlyError, useCopy } from "./studioShellKit.jsx";
import { Rich, TelegramSteps } from "./TelegramSteps.jsx";
import { TelegramBotClient, botLink, cleanToken, isTokenShape, qrMatrix, qrPath, qrSide, telegramErrorKey } from "./telegramBot.js";

const PNG_SCALE = 10;
/** The QR code as a PNG, drawn from its modules, and handed to the browser to save. */
function downloadQr(matrix, name) {
  const side = qrSide(matrix);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side * PNG_SCALE;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) context.fillRect((x + 4) * PNG_SCALE, (y + 4) * PNG_SCALE, PNG_SCALE, PNG_SCALE); }));
  canvas.toBlob((blob) => {
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${name}.png` });
    link.click(); URL.revokeObjectURL(link.href);
  });
}

const messageOf = (error, t) => { const key = telegramErrorKey(error); return key ? t(key) : friendlyError(error, t); };

/** Connect, change and disconnect the Product's own Telegram bot. The Registry's answer is the state; nothing is assumed. */
export function TelegramBotSetup({ productId, live, request, t }) {
  const client = useMemo(() => new TelegramBotClient(request, productId), [request, productId]);
  const [bot, setBot] = useState(undefined);
  const [replacing, setReplacing] = useState(false);
  const [token, setToken] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [replaceAsked, setReplaceAsked] = useState(false);
  const { copied, copy } = useCopy();

  const load = () => { setLoadError(null); client.get().then(setBot, setLoadError); };
  useEffect(load, [client]);

  function submit(event) {
    event.preventDefault();
    if (!isTokenShape(token)) { setError(t("sxtgBadShape")); return; }
    if (bot) setReplaceAsked(true); else void connect();
  }
  async function connect() {
    setBusy(true); setError("");
    try {
      setBot(await client.connect(token));
      setToken(""); setShown(false); setReplacing(false);
    } catch (cause) { setError(messageOf(cause, t)); } finally { setBusy(false); setReplaceAsked(false); }
  }
  const matrix = useMemo(() => bot ? qrMatrix(botLink(bot.username)) : null, [bot?.username]);
  async function disconnect() {
    setBusy(true);
    try { await client.disconnect(); setBot(null); setDisconnecting(false); }
    catch (cause) { setDisconnecting(false); setError(messageOf(cause, t)); } finally { setBusy(false); }
  }

  const body = loadError ? <>
    <InlineError>{t("sxtgLoadError")}: {messageOf(loadError, t)}</InlineError>
    <div className="sx-form__foot"><Button variant="secondary" type="button" onClick={load}>{t("retry")}</Button></div>
  </> : bot === undefined ? <LoadingState t={t} />
    : bot && !replacing ? <>
      <div className="sx-tg__share">
        <svg className="sx-tg__qr" viewBox={`0 0 ${qrSide(matrix)} ${qrSide(matrix)}`} role="img" aria-label={t("sxtgQrAlt")} shapeRendering="crispEdges"><rect width="100%" height="100%" fill="#fff" /><path d={qrPath(matrix)} fill="#000" /></svg>
        <div className="sx-tg__who">
          <p className="sx-tg__bot"><strong>{t("sxtgConnected", bot.username)}</strong></p>
          <p>{t("sxtgUsage", bot.users, bot.messages)}</p>
          <p className="sx-tg__url">{botLink(bot.username).replace("https://", "")}</p>
          <Button variant="secondary" type="button" leading={<Download aria-hidden="true" />} onClick={() => downloadQr(matrix, `telegram-${bot.username}`)}>{t("sxtgDownloadQr")}</Button>
        </div>
      </div>
      <div className="sx-form__foot">
        <Button asChild leading={<ExternalLink aria-hidden="true" />}><a href={botLink(bot.username)} target="_blank" rel="noreferrer">{t("sxtgOpen")}</a></Button>
        <Button variant="secondary" type="button" leading={<Copy aria-hidden="true" />} onClick={() => void copy(botLink(bot.username))}>{copied ? t("copied") : t("sxtgCopyLink")}</Button>
        <Button variant="secondary" type="button" onClick={() => { setReplacing(true); setError(""); }}>{t("sxtgReplace")}</Button>
        <Button variant="ghost" type="button" onClick={() => setDisconnecting(true)}>{t("sxtgDisconnect")}</Button>
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
    </> : <form className="sx-tg__form" onSubmit={submit}>
      <TelegramSteps t={t} />
      <p className="sx-quiet"><Rich text={t("sxtgTip")} /></p>
      <div className="sx-tg__token">
        <Input type={shown ? "text" : "password"} aria-label={t("sxtgTokenLabel")} placeholder="123456789:AA…" value={token} autoComplete="off" autoCapitalize="off" spellCheck={false}
          onChange={(event) => { setToken(event.target.value); setError(""); }} onBlur={() => setToken(cleanToken(token))} />
        <button type="button" className="sx-icon-btn" aria-label={t(shown ? "sxtgHide" : "sxtgShow")} aria-pressed={shown} onClick={() => setShown(!shown)}>{shown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}</button>
      </div>
      {error ? <InlineError>{error}</InlineError> : null}
      <div className="sx-form__foot">
        <Button type="submit" loading={busy} disabled={!cleanToken(token)}>{t("sxtgConnect")}</Button>
        {bot ? <button type="button" className="sx-link sx-link--quiet" onClick={() => { setReplacing(false); setToken(""); setError(""); }}>{t("sxtgCancel")}</button> : null}
      </div>
    </form>;

  return <section className="sx-card sx-form sx-tg" data-state={bot ? "connected" : "unconnected"}>
    <SectionHead title={t("sxtgTitle")} />
    {live ? null : <p className="sx-quiet">{t("sxtgNotLive")}</p>}
    {body}
    <ConfirmDialog open={replaceAsked} onOpenChange={(open) => { if (!open) setReplaceAsked(false); }} title={t("sxtgReplaceTitle", bot?.username ?? "")} description={t("sxtgReplaceBody")}
      confirmLabel={t("sxtgReplaceConfirm")} cancelLabel={t("cancel")} destructive busy={busy} onConfirm={connect} />
    <ConfirmDialog open={disconnecting} onOpenChange={(open) => { if (!open) setDisconnecting(false); }} title={t("sxtgDisconnectTitle", bot?.username ?? "")} description={t("sxtgDisconnectBody")}
      confirmLabel={t("sxtgDisconnect")} cancelLabel={t("cancel")} destructive busy={busy} onConfirm={disconnect} />
  </section>;
}
