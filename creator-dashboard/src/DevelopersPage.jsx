import React, { useEffect, useMemo, useState } from "react";
import { WebBrand } from "./WebBrand.jsx";
import { LanguageSwitcher } from "./LanguageSwitcher.jsx";
import { useLocale } from "./locale.jsx";
import { DevelopersGuide, KEYS_PATH } from "./developersGuide.js";
import "./developersPage.css";

export function DevelopersPage({ tab, navigate }) {
  const { locale } = useLocale();
  const guide = useMemo(() => DevelopersGuide.forLocale(locale), [locale]);
  const active = guide.tab(tab);

  useEffect(() => {
    const previous = document.title;
    document.title = guide.copy.documentTitle;
    return () => { document.title = previous; };
  }, [guide]);

  return (
    <div className="developers-page">
      <header className="developers-page__header">
        <WebBrand className="developers-page__brand" href="/" aria-label={guide.copy.homeLabel} />
        <LanguageSwitcher className="developers-page__language" />
      </header>
      <main className="developers-page__main">
        <h1>{guide.copy.title}</h1>
        <p className="developers-page__scope">{guide.copy.scope}</p>
        <a className="developers-page__link developers-page__keys" href={KEYS_PATH}>{guide.copy.createKey}</a>
        <nav className="developers-page__tabs" aria-label={guide.copy.methodsLabel}>
          {guide.tabs.map((item) => (
            <a key={item.id} href={item.path} aria-current={item.id === active.id ? "page" : undefined}
              onClick={(event) => { event.preventDefault(); navigate(item.path); }}>{item.label}</a>
          ))}
        </nav>
        <ol className="developers-page__steps">
          {active.steps.map((step) => <Step key={step.id} step={step} copy={guide.copy} />)}
        </ol>
      </main>
    </div>
  );
}

function Step({ step, copy }) {
  return (
    <li className="developers-page__step">
      <h2>{step.title}</h2>
      {step.note ? <p><InlineCode text={step.note} /></p> : null}
      {step.link ? <a className="developers-page__link" href={step.link}>{copy.keys}</a> : null}
      {step.code.map((block) => <CodeBlock key={block.text} block={block} copy={copy} />)}
    </li>
  );
}

// Backtick spans inside copy render as <code>.
function InlineCode({ text }) {
  return text.split("`").map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

function CodeBlock({ block, copy }) {
  const [copied, setCopied] = useState(false);
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(block.text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the text stays selectable.
    }
  };
  return (
    <div className="developers-page__code">
      <button type="button" onClick={copyText}>{copied ? copy.copied : copy.copy}</button>
      <pre><code>{block.text}</code></pre>
    </div>
  );
}

export default DevelopersPage;
