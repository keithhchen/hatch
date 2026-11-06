import React, { useState } from "react";
import { Bot, UserRound } from "lucide-react";
import { InlineAlert } from "../Feedback.jsx";
import { cn } from "../utils.js";

/**
 * Free-chat access derived from a Product's expert-set pricing and the
 * customer's sent-message count. Without a free-message limit chat is open.
 */
export function freeChatAccess(pricing, sentMessageCount) {
  const limit = Number.isSafeInteger(pricing?.free_messages) ? pricing.free_messages : null;
  const options = [
    Number.isSafeInteger(pricing?.human_hourly_minor) ? { id: "human", amount_minor: pricing.human_hourly_minor } : null,
    Number.isSafeInteger(pricing?.agent_monthly_minor) ? { id: "agent", amount_minor: pricing.agent_monthly_minor } : null
  ].filter(Boolean);
  if (limit === null) return { locked: false, remaining: null, limit: null, options };
  const used = Math.max(0, Number(sentMessageCount) || 0);
  return { locked: used >= limit, remaining: Math.max(0, limit - used), limit, options };
}

function money(minor, currency = "USD", locale) {
  return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: minor % 100 ? 2 : 0 }).format(minor / 100);
}

const ICONS = { human: UserRound, agent: Bot };

/**
 * Shown in place of the composer once free messages are used up. The customer
 * picks one of the expert's options; online payment is not open yet, so the
 * selection states that plainly instead of starting a checkout.
 * `copy` keys: title, body, human, humanPrice, agent, agentPrice, unavailable.
 * Price templates use {price}.
 */
export function FreeChatPaywall({ access, currency = "USD", locale, copy, className }) {
  const [selected, setSelected] = useState(null);
  return (
    <section className={cn("hatch-free-chat-paywall", className)} aria-labelledby="hatch-free-chat-paywall-title">
      <h2 id="hatch-free-chat-paywall-title">{copy.title}</h2>
      <p>{copy.body}</p>
      <div className="hatch-free-chat-paywall__options" role="radiogroup" aria-label={copy.title}>
        {access.options.map((option) => {
          const Icon = ICONS[option.id];
          const active = selected === option.id;
          return <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            className={cn("hatch-free-chat-paywall__option", active && "is-selected")}
            onClick={() => setSelected(option.id)}
          >
            <Icon aria-hidden="true" />
            <span>{copy[option.id]}</span>
            <b>{copy[`${option.id}Price`].replace("{price}", money(option.amount_minor, currency, locale))}</b>
          </button>;
        })}
      </div>
      {selected ? <InlineAlert tone="info">{copy.unavailable}</InlineAlert> : null}
    </section>
  );
}
