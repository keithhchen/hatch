import React, { useEffect } from "react";
import { WebBrand } from "./WebBrand.jsx";
import { LanguageSwitcher } from "./LanguageSwitcher.jsx";
import { normalizeLocale, useLocale } from "./locale.jsx";
import { HELP_PAGE_COPY, helpGroups, helpItem, helpPath, localizeHelpItem } from "../helpCatalog.mjs";
import "./helpPage.css";

const MEDIA_BASE = import.meta.env?.VITE_HATCH_WEB_MEDIA_BASE_URL || undefined;

/** The public Help center: /help lists every catalog item, /help/<slug> shows one. A `?lang=` link opens in that language. */
export default function HelpPage({ slug, search, navigate }) {
  const { locale, setLocale } = useLocale();
  const copy = HELP_PAGE_COPY[locale];
  const entry = slug ? helpItem(slug) : null;
  const item = entry && localizeHelpItem(entry, locale, MEDIA_BASE);

  useEffect(() => {
    const requested = normalizeLocale(new URLSearchParams(search).get("lang"));
    if (requested) setLocale(requested);
  }, [search, setLocale]);

  useEffect(() => {
    const previous = document.title;
    document.title = `${item ? item.title : copy.index} · Hatch`;
    return () => { document.title = previous; };
  }, [item, copy]);

  const open = (target) => (event) => { event.preventDefault(); navigate(target); };

  return (
    <div className="help-page">
      <header className="help-page__header">
        <WebBrand className="help-page__brand" href="/" aria-label="Hatch" />
        <LanguageSwitcher />
      </header>
      <main className="help-page__main">
        {slug && !item ? <>
          <h1>{copy.notFound}</h1>
          <a className="help-page__link" href="/help" onClick={open("/help")}>{copy.index}</a>
        </> : item ? <>
          <a className="help-page__link" href="/help" onClick={open("/help")}>{copy.index}</a>
          <h1>{item.title}</h1>
          {item.src ? <video key={item.src} className="help-page__player" src={item.src} poster={item.poster} controls playsInline preload="metadata" /> : null}
          <p className="help-page__text">{item.description}</p>
        </> : <>
          <h1>{copy.index}</h1>
          {helpGroups(locale, MEDIA_BASE).map((group) => (
            <section key={group.kind} className="help-page__group">
              <h2>{copy[group.kind]}</h2>
              <ul className="help-page__list">
                {group.items.map((card) => (
                  <li key={card.id}>
                    <a className="help-page__card" href={helpPath(card)} onClick={open(helpPath(card))}>
                      {card.poster ? <img src={card.poster} alt="" /> : null}
                      <strong>{card.title}</strong>
                      <span>{card.description}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>}
      </main>
    </div>
  );
}
