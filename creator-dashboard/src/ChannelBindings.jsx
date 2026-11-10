import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink, MessageCircle, Send, X } from "lucide-react";
import { InlineAlert } from "@hatch/ui";
import { friendlyError, mutationKey } from "./studioShellKit.jsx";
import { TelegramBot, TelegramPeople } from "./TelegramBot.jsx";

const CONNECTIONS = "/v1/creator/connections";
const NAMES = { telegram: "Telegram", line: "LINE", whatsapp: "WhatsApp", discord: "Discord", lark: "Lark", imessage: "iMessage" };
const ICONS = { telegram: Send };
const WAITING_MS = 2000;
const IDLE_MS = 10000;

/**
 * Where the account's chats are bound: to the Assistant (Studio), or to one Product's Chat when `productId` is given.
 * A tile per messaging platform: unbound it opens the platform's deep link, bound it names who is bound and unbinds.
 * The state is the Registry's, asked again while a link is waiting to be opened, so a bound chat shows up by itself.
 */
export function ChannelBindings({ request, productId, t }) {
  const query = productId ? `?product_id=${encodeURIComponent(productId)}` : "";
  const [channels, setChannels] = useState([]);
  const [waiting, setWaiting] = useState(null);
  const [error, setError] = useState("");
  const refresh = useCallback(() => request(`${CONNECTIONS}${query}`).then(value => { setChannels(value.channels ?? []); setError(""); }).catch(cause => setError(friendlyError(cause, t))), [request, query, t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, waiting ? WAITING_MS : IDLE_MS);
    return () => clearInterval(timer);
  }, [refresh, waiting]);
  useEffect(() => { if (waiting && channels.some(channel => channel.kind === waiting.kind && channel.linked)) setWaiting(null); }, [channels, waiting]);

  const bind = async kind => {
    try {
      const value = await request(`${CONNECTIONS}/${kind}/connect`, { method: "POST", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify(productId ? { product_id: productId } : {}) });
      setWaiting({ kind, url: value.url });
      if (value.url) window.open(value.url, "_blank", "noopener");
    } catch (cause) { setError(friendlyError(cause, t)); }
  };
  const unbind = async kind => {
    try {
      const value = await request(`${CONNECTIONS}/${kind}${query}`, { method: "DELETE", body: JSON.stringify({}) });
      setChannels(value.channels ?? []);
      setWaiting(null);
    } catch (cause) { setError(friendlyError(cause, t)); }
  };

  const tiles = channels.filter(channel => channel.available && !channel.own_app);
  if (!tiles.length && !error) return null;
  return <div className="cb">
    {tiles.map(channel => {
      if (channel.bot) return <TelegramBot key={channel.kind} request={request} productId={productId} channel={channel} onChannels={setChannels} t={t} />;
      const Icon = ICONS[channel.kind] ?? MessageCircle;
      const name = NAMES[channel.kind] ?? channel.kind;
      return channel.linked
        ? <React.Fragment key={channel.kind}><div className="cb-tile is-bound" data-channel={channel.kind} data-state="bound">
          <Icon aria-hidden="true" /><span className="cb-name">{name}</span>{channel.sender_id ? <code className="cb-who">{channel.sender_id}</code> : null}
          <button type="button" className="cb-unbind" aria-label={t("sxaChannelDisconnect")} onClick={() => unbind(channel.kind)}><X aria-hidden="true" /></button>
        </div>{channel.kind === "telegram" && !productId ? <TelegramPeople request={request} channel={channel} onChannels={setChannels} t={t} /> : null}</React.Fragment>
        : waiting?.kind === channel.kind
          ? <a className="cb-tile is-waiting" key={channel.kind} data-channel={channel.kind} data-state="waiting" href={waiting.url} target="_blank" rel="noopener noreferrer">
            <Icon aria-hidden="true" /><span className="cb-name">{name}</span><ExternalLink aria-hidden="true" />
          </a>
          : <button type="button" className="cb-tile" key={channel.kind} data-channel={channel.kind} data-state="unbound" onClick={() => bind(channel.kind)}>
            <Icon aria-hidden="true" /><span className="cb-name">{name}</span>
          </button>;
    })}
    {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
  </div>;
}
