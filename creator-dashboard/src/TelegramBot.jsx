import React, { useState } from "react";
import { Check, Copy, Plus, Send, X } from "lucide-react";
import { Button, InlineAlert, Input } from "@hatch/ui";
import { friendlyError } from "./studioShellKit.jsx";

const TELEGRAM = "/v1/creator/connections/telegram";

/** Runs one Registry call and hands back its channels, or the error text. */
function useCall(request, t, onChannels) {
  const [error, setError] = useState("");
  const call = async (path, options) => {
    try {
      const value = await request(path, options);
      setError("");
      onChannels?.(value.channels ?? []);
      return value;
    } catch (cause) { setError(friendlyError(cause, t)); }
  };
  return [call, error];
}

/** A Product's own Telegram bot: paste the BotFather token, or open and remove the bot already set up. */
export function TelegramBot({ request, productId, channel, onChannels, t }) {
  const [token, setToken] = useState("");
  const [call, error] = useCall(request, t, onChannels);
  const save = async event => {
    event.preventDefault();
    if (await call(`${TELEGRAM}/credentials`, { method: "POST", body: JSON.stringify({ token, product_id: productId }) })) setToken("");
  };
  const remove = () => call(`${TELEGRAM}?product_id=${encodeURIComponent(productId)}`, { method: "DELETE", body: JSON.stringify({}) });
  return <div className="cb-bot" data-channel="telegram">
    {channel.configured
      ? <div className="cb-tile is-bound"><Send aria-hidden="true" /><a className="cb-name" href={`https://t.me/${channel.handle}`} target="_blank" rel="noopener noreferrer">@{channel.handle}</a>
        <button type="button" className="cb-unbind" aria-label={t("sxaBotRemove")} onClick={remove}><X aria-hidden="true" /></button></div>
      : <form className="cb-form" onSubmit={save}>
        <Input type="password" autoComplete="off" required aria-label={t("sxaBotToken")} placeholder={t("sxaBotToken")} value={token} onChange={event => setToken(event.target.value)} />
        <Button type="submit" disabled={!token.trim()}>{t("sxaBotSave")}</Button>
      </form>}
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
  </div>;
}

/** The people who can reach the Studio assistant through the shared bot: revoke them, or invite one more. */
export function TelegramPeople({ request, channel, onChannels, t }) {
  const [call, error] = useCall(request, t, onChannels);
  const [label, setLabel] = useState(null);
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState(false);
  const send = async event => {
    event.preventDefault();
    const value = await call(`${TELEGRAM}/invites`, { method: "POST", body: JSON.stringify({ label }) });
    if (value) { setInvite(value.url); setLabel(null); setCopied(false); }
  };
  const copy = () => navigator.clipboard?.writeText(invite).then(() => setCopied(true)).catch(() => {});
  return <div className="cb-people">
    {(channel.people ?? []).map(person => <div className="cb-person" key={person.id}>
      <span>{person.label}</span>
      <button type="button" className="cb-unbind" aria-label={t("sxaPersonRevoke")} onClick={() => call(`${TELEGRAM}/people/${encodeURIComponent(person.id)}`, { method: "DELETE", body: JSON.stringify({}) })}><X aria-hidden="true" /></button>
    </div>)}
    {label === null
      ? <button type="button" className="cb-unbind" aria-label={t("sxaInvite")} onClick={() => { setLabel(""); setInvite(null); }}><Plus aria-hidden="true" /></button>
      : <form className="cb-form" onSubmit={send}>
        <Input autoFocus required aria-label={t("sxaInviteLabel")} placeholder={t("sxaInviteLabel")} value={label} onChange={event => setLabel(event.target.value)} />
        <Button type="submit" disabled={!label.trim()}>{t("sxaInvite")}</Button>
      </form>}
    {invite ? <div className="cb-person"><code className="cb-who">{invite}</code>
      <button type="button" className="cb-unbind" aria-label={t("sxaInviteCopy")} onClick={copy}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button></div> : null}
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
  </div>;
}
