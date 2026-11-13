import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { BOTFATHER_URL } from "./telegramBot.js";
import "./web/trialScenes.css";
import "./telegramSteps.css";

/** A bullet's `code` spans become code; @BotFather opens BotFather. */
export function Rich({ text }) {
  return text.split(/`([^`]+)`/).map((part, index) => index % 2 === 0 ? part
    : part === "@BotFather" ? <a key={index} className="sx-link" href={BOTFATHER_URL} target="_blank" rel="noreferrer">{part}</a>
    : <code key={index}>{part}</code>);
}

/** Taps copy plain text, as typed: not through the link-aware page copier. */
function CopyChip({ text, label, copiedLabel }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* the text is on screen to copy by hand */ }
  };
  return <button type="button" className="tg-chip" onClick={() => void copy()} aria-label={`${copied ? copiedLabel : label}: ${text}`}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}</button>;
}

/** A tiny Telegram chat for each step, drawn here. BotFather's lines are Telegram's own wording. */
function Scene({ index, t }) {
  const chip = (text) => <CopyChip text={text} label={t("sxtgCopy")} copiedLabel={t("copied")} />;
  const you = (text, copyable) => <p className="tm-b out">{text}{copyable ? chip(text) : null}</p>;
  const bot = (text) => <p className="tm-b in">{text}</p>;
  const scenes = [
    <><div className="tg-head"><span className="tg-avatar" /><b>BotFather</b><span className="tg-tick">✓</span></div><span className="tg-start">START</span></>,
    <>{you("/newbot", true)}{bot("Alright, a new bot. How are we going to call it?")}</>,
    <>{you(t("sxtgSceneName"))}{bot("Good. Now let's choose a username for your bot. It must end in bot.")}</>,
    <>{you("example_bot", true)}{bot("Done! Congratulations on your new bot.")}</>,
    <>{bot("Use this token to access the HTTP API:")}<p className="tm-b in"><mark className="tg-token">123456789:AAH-example</mark></p></>,
    <><span className="tg-field">••••••••••••••••</span><span className="tg-start">{t("sxtgConnect")}</span></>,
  ];
  return <div className="tg-scene">{scenes[index]}</div>;
}

/** Six steps to a bot token, each a numbered card: a short title, a few short lines, and the chat as it will look. */
export function TelegramSteps({ t }) {
  return <ol className="trial-steps tg-steps">
    {[1, 2, 3, 4, 5, 6].map((number, index) => <li key={number}>
      <Scene index={index} t={t} />
      <strong><span className="trial-step__number" aria-hidden="true">{number}</span>{t(`sxtgStep${number}`)}</strong>
      <ul className="tg-bullets">{t(`sxtgStep${number}Lines`).split("\n").map((bullet) => <li key={bullet}><Rich text={bullet} /></li>)}</ul>
    </li>)}
  </ol>;
}
