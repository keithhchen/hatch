import React, { useState } from "react";
import { Bot, Info, UserRound } from "lucide-react";

const ICONS = { human: UserRound, agent: Bot };

const money = (minor, currency) => new Intl.NumberFormat(undefined, {
  style: "currency", currency, maximumFractionDigits: minor % 100 ? 2 : 0
}).format(minor / 100);

/**
 * Shown in place of the composer once free messages are used up. The customer
 * picks one of the expert's options; online payment is not open yet, so the
 * selection states that plainly instead of starting a checkout.
 */
export function FreeChatPaywall({ access, creatorName, t }) {
  const [selected, setSelected] = useState(null);
  return <section className="chat-paywall" aria-labelledby="chat-paywall-title">
    <h2 id="chat-paywall-title">{t("paywallTitle", { count: access.limit })}</h2>
    <p>{t("paywallBody", { name: creatorName })}</p>
    <div className="chat-paywall__options" role="radiogroup" aria-labelledby="chat-paywall-title">
      {access.options.map(option => {
        const Icon = ICONS[option.id];
        return <button key={option.id} type="button" role="radio" aria-checked={selected === option.id}
          className="chat-paywall__option" onClick={() => setSelected(option.id)}>
          <Icon aria-hidden="true" />
          <span>{option.id === "human" ? t("paywallHuman", { name: creatorName }) : t("paywallAgent")}</span>
          <b>{t(option.id === "human" ? "paywallHumanPrice" : "paywallAgentPrice", { price: money(option.amount_minor, access.currency) })}</b>
        </button>;
      })}
    </div>
    {selected ? <p className="chat-paywall__note" role="status"><Info aria-hidden="true" />{t("paywallUnavailable")}</p> : null}
  </section>;
}
