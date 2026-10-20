"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LanguageSwitcher } from "../LanguageSwitcher.jsx";
import { useLocale } from "../locale.jsx";
import { landingCopy, type Lang, type LandingCopy } from "./landingCopy";

const TRY_HREF = "/studio";
const WORDMARK = "/assets/web/hatch-wordmark-inverse.svg";

function Egg({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 36 44" width={size * 0.82} height={size} aria-hidden="true">
      <path d="M18 2C9.2 2 2 16 2 26a16 16 0 0 0 32 0C34 16 26.8 2 18 2Z" fill="#F5B700" />
      <path d="M7 22l6 4 5-5 5 5 6-4" stroke="#17150F" strokeWidth="2.6" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

const Bar = ({ w, tone }: { w: string; tone?: "dark" | "yolk" }) => <i className={`sk-bar ${tone ?? ""}`} style={{ width: w }} />;

function DemoChat({ t }: { t: LandingCopy }) {
  const [role, setRole] = useState(t.roles.length - 1);
  const [index, setIndex] = useState(0);
  const [shown, setShown] = useState(0);
  const examples = t.roles[role].examples;
  const example = examples[index % examples.length];

  useEffect(() => {
    setShown(0);
    const typer = window.setInterval(() => setShown((n) => n + 1), 45);
    const next = window.setTimeout(() => setIndex((i) => i + 1), 5200);
    return () => {
      window.clearInterval(typer);
      window.clearTimeout(next);
    };
  }, [role, index]);

  const done = shown >= example.reply.length;

  return (
    <div className="demo">
      <div className="demo-roles" role="tablist">
        {t.roles.map((r, i) => (
          <button
            key={r.label}
            type="button"
            role="tab"
            aria-selected={i === role}
            className={i === role ? "active" : ""}
            onClick={() => {
              setRole(i);
              setIndex(0);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="demo-phone">
        <div className="demo-head">
          <Egg size={18} />
          <b>{example.field}</b>
          <em>{t.demoTag}</em>
        </div>
        <div className="demo-thread" key={`${role}-${index}`}>
          <p className="bubble bubble-client">{example.client}</p>
          <p className="bubble bubble-agent">
            {example.reply.slice(0, shown)}
            {!done && <span className="caret" />}
          </p>
          {!done && <span className="demo-typing">{t.demoTyping}</span>}
          {done && <p className="demo-booked">✓ {t.demoBooked}</p>}
        </div>
        <div className="demo-fields">
          {examples.map((e, i) => (
            <button key={e.field} type="button" className={i === index % examples.length ? "active" : ""} onClick={() => setIndex(i)}>
              {e.field}
            </button>
          ))}
        </div>
      </div>
      <span className="float float-b">{t.floatBooked}</span>
      <span className="float float-c">✓ {t.floatEval}</span>
    </div>
  );
}

function InboxArt() {
  return (
    <div className="sk-card" aria-hidden="true">
      <div className="sk-top"><span className="sk-label">INBOX</span><span className="sk-label">48</span></div>
      {["78%", "62%", "70%"].map((w) => (
        <div className="sk-row" key={w}><i className="sk-dot" /><Bar w={w} /></div>
      ))}
      <div className="sk-row sk-row-hot"><i className="sk-dot yolk" /><Bar w="58%" tone="dark" /><span className="sk-pill">QUALIFIED</span></div>
      <div className="sk-chip">BOOKED · THU 20:00 →</div>
    </div>
  );
}

function DeliveryArt() {
  return (
    <div className="sk-card" aria-hidden="true">
      <div className="sk-top"><span className="sk-label">ORDER · REVIEW</span><span className="sk-label">x12</span></div>
      <div className="sk-doc">
        <Bar w="90%" /><Bar w="76%" /><Bar w="84%" tone="yolk" /><Bar w="52%" />
      </div>
      <div className="sk-row"><span className="sk-label">YOUR STANDARD</span><span className="sk-pass">✓ PASS</span></div>
      <div className="sk-chip">DELIVERED →</div>
    </div>
  );
}

function StepArt({ tag }: { tag: string }) {
  if (tag === "READ") {
    return (
      <div className="sk-card sk-small" aria-hidden="true">
        <span className="sk-label">READ</span>
        <div className="sk-stack">
          {[0, 1, 2].map((i) => (
            <div className="sk-sheet" key={i}><Bar w="70%" /><Bar w="50%" /></div>
          ))}
        </div>
      </div>
    );
  }
  if (tag === "INTERVIEW") {
    return (
      <div className="sk-card sk-small" aria-hidden="true">
        <span className="sk-label">INTERVIEW · 3/11</span>
        <div className="sk-bubble"><Bar w="80%" tone="dark" /><Bar w="55%" tone="dark" /></div>
        <div className="sk-bubble sk-bubble-me"><Bar w="60%" /></div>
        <div className="sk-bubble"><Bar w="72%" tone="yolk" /></div>
      </div>
    );
  }
  return (
    <div className="sk-card sk-small" aria-hidden="true">
      <span className="sk-label">EVAL · ROUND 2</span>
      <div className="sk-row"><span className="sk-pass">✓</span><Bar w="64%" /></div>
      <div className="sk-row"><span className="sk-fail">✗</span><Bar w="56%" /></div>
      <div className="sk-row"><span className="sk-redo">↻</span><Bar w="48%" tone="yolk" /></div>
      <div className="sk-row"><span className="sk-pass">✓</span><span className="sk-label">8/8 PASSED</span></div>
    </div>
  );
}

export default function HatchPage() {
  const { locale } = useLocale();
  const lang = locale as Lang;
  const t = landingCopy[lang];
  const [contactStatus, setContactStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [isContactDialogOpen, setIsContactDialogOpen] = useState(false);
  const contactDialogRef = useRef<HTMLDialogElement>(null);
  const fields = t.roles.flatMap((r) => r.examples.map((e) => e.field));

  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Hatch — AI products for expert creators";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    const dialog = contactDialogRef.current;
    if (!dialog) return;
    if (isContactDialogOpen && !dialog.open) dialog.showModal();
    if (!isContactDialogOpen && dialog.open) dialog.close();
  }, [isContactDialogOpen]);

  async function handleContactSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setContactStatus("submitting");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          partnerType: data.get("partnerType"),
          message: data.get("message"),
          website: data.get("website"),
          language: lang,
        }),
      });
      if (!response.ok) throw new Error("Contact submission failed");
      form.reset();
      setContactStatus("success");
    } catch {
      setContactStatus("error");
    }
  }

  function openContactDialog() {
    setContactStatus("idle");
    setIsContactDialogOpen(true);
  }

  const tryButton = (dark = false) => (
    <a className={`btn btn-yolk ${dark ? "on-dark" : ""}`} href={TRY_HREF}>
      {t.tryCta}
      <span className="cta-arrow" aria-hidden="true">→</span>
    </a>
  );

  return (
    <main className={`site is-${lang}`}>
      <header className="nav">
        <a className="nav-brand" href="#top" aria-label="Hatch home">
          <Egg />
          <img src={WORDMARK} alt="Hatch" width={72} height={28} />
        </a>
        <nav className="nav-links" aria-label="Page sections">
          <a href="#what">{t.nav.what}</a>
          <a href="#how">{t.nav.how}</a>
          <a href="#pricing">{t.nav.pricing}</a>
          <a href="#faq">{t.nav.faq}</a>
        </nav>
        <div className="nav-right">
          <LanguageSwitcher className="lang-switch" compact />
          <a className="nav-login" href="/studio">{t.nav.login}</a>
          <a className="btn btn-yolk btn-sm" href={TRY_HREF}>{t.nav.try}</a>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <h1>
            <span>{t.heroTitleA}</span>
            <em>{t.heroTitleB}</em>
          </h1>
          <p className="hero-body">{t.heroBody}</p>
          <div className="actions">
            {tryButton(true)}
            <a className="btn btn-ghost" href="#demo">{t.seeCta}</a>
          </div>
          <p className="hero-note">{t.tryNote}</p>
        </div>
        <div id="demo">
          <DemoChat key={lang} t={t} />
        </div>
      </section>

      <section className="for">
        <p className="eyebrow">{t.forLabel}</p>
        <div className="marquee">
          <div className="marquee-track">
            {[...fields, ...fields].map((f, i) => (
              <span key={`${f}-${i}`}>{f}</span>
            ))}
          </div>
        </div>
      </section>

      <section className="pain">
        <p className="eyebrow">{t.painLabel}</p>
        <div className="pain-grid">
          {t.pains.map((p) => (
            <article key={p.title}>
              <h2>{p.title}</h2>
              <p>{p.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section" id="what">
        <p className="eyebrow">{t.whatLabel}</p>
        <h2 className="title">{t.whatTitle}</h2>
        <div className="feature-grid">
          {t.features.map((f, i) => (
            <article className="feature" key={f.tag}>
              {i === 0 ? <InboxArt /> : <DeliveryArt />}
              <span className="tag">{f.tag}</span>
              <h3>{f.title}</h3>
              <ul>
                {f.items.map((item, j) => (
                  <li key={item}>
                    {item}
                    {f.soon[j] && <em className="soon">{t.soonTag}</em>}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="section section-panel" id="how">
        <p className="eyebrow">{t.howLabel}</p>
        <h2 className="title">{t.howTitle}</h2>
        <div className="steps">
          {t.howSteps.map((s, i) => (
            <article className="step" key={s.tag}>
              <StepArt tag={s.tag} />
              <span className="step-n">0{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
        <p className="how-note">{t.howNote}</p>
        <div className="interview">
          <p className="eyebrow">{t.interviewLabel}</p>
          <p className="iv iv-agent">{t.interviewQ1}</p>
          <p className="iv iv-me">{t.interviewA}</p>
          <p className="iv iv-agent iv-deep">{t.interviewQ2}</p>
        </div>
      </section>

      <section className="section">
        <p className="eyebrow">{t.compareLabel}</p>
        <div className="compare" role="table">
          <div className="compare-row compare-head" role="row">
            <span role="columnheader" />
            {t.compareCols.map((c, i) => (
              <span role="columnheader" key={c} className={i === 0 ? "us" : ""}>{c}</span>
            ))}
          </div>
          {t.compareRows.map((r) => (
            <div className="compare-row" role="row" key={r.label}>
              <span role="rowheader">{r.label}</span>
              {r.v.map((v, i) => (
                <span role="cell" key={i} className={`${i === 0 ? "us" : ""} ${v ? "yes" : "no"}`}>{v ? "✓" : "—"}</span>
              ))}
            </div>
          ))}
        </div>
      </section>


      <section className="section">
        <p className="eyebrow">{t.trustLabel}</p>
        <div className="trust">
          {t.trust.map((col) => (
            <article key={col.title}>
              <h3>{col.title}</h3>
              <ul>
                {col.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="section section-panel" id="pricing">
        <p className="eyebrow">{t.pricingLabel}</p>
        <h2 className="title">{t.pricingTitle}</h2>
        <div className="plans">
          {t.plans.map((p) => (
            <article className={`plan ${p.cta ? "plan-main" : ""}`} key={p.name}>
              <span className="tag">{p.name}</span>
              <p className="plan-price">{p.price}</p>
              <p>{p.body}</p>
              {p.cta && tryButton()}
            </article>
          ))}
        </div>
        <p className="fine">{t.pricingNote}</p>
      </section>

      <section className="section" id="faq">
        <p className="eyebrow">{t.faqLabel}</p>
        <div className="faq">
          {t.faqs.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="final">
        <h2>{t.finalTitle}</h2>
        <p>{t.finalBody}</p>
        {tryButton(true)}
      </section>

      <dialog
        className="contact-dialog"
        ref={contactDialogRef}
        aria-labelledby="contact-dialog-title"
        onClose={() => setIsContactDialogOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}
      >
        <div className="contact-inner">
          <div className="contact-heading">
            <p className="eyebrow">{t.contactLabel}</p>
            <button className="contact-close" type="button" onClick={() => contactDialogRef.current?.close()} aria-label={t.contactClose}>
              ×
            </button>
          </div>
          <h3 id="contact-dialog-title">{t.contactTitle}</h3>
          <form className="contact-form" onSubmit={handleContactSubmit}>
            <label>
              <span>{t.contactFields.name}</span>
              <input name="name" autoComplete="name" required maxLength={100} />
            </label>
            <label>
              <span>{t.contactFields.email}</span>
              <input name="email" type="email" autoComplete="email" required maxLength={320} />
            </label>
            <label>
              <span>{t.contactFields.partnerType}</span>
              <select name="partnerType" defaultValue="" required>
                <option value="" disabled>—</option>
                {t.contactOptions.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{t.contactFields.message}</span>
              <textarea name="message" rows={4} maxLength={4000} />
            </label>
            <input className="contact-honeypot" name="website" type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" />
            <div className="contact-actions">
              <button className="btn btn-ink" type="submit" disabled={contactStatus === "submitting"}>
                {contactStatus === "submitting" ? t.contactSending : t.contactSubmit}
              </button>
              <p className={`contact-status ${contactStatus}`} aria-live="polite">
                {contactStatus === "success" ? t.contactSuccess : contactStatus === "error" ? t.contactError : ""}
              </p>
            </div>
          </form>
        </div>
      </dialog>

      <footer className="footer">
        <a className="nav-brand" href="#top">
          <Egg />
          <img src={WORDMARK} alt="Hatch" width={72} height={28} />
        </a>
        <div className="footer-cols">
          <div>
            <p className="eyebrow">{t.footer.product}</p>
            <a href={TRY_HREF}>{t.tryCta}</a>
            <a href="/studio">{t.footer.login}</a>
            <a href="/explore">{t.footer.explore}</a>
            <a href="/download">{t.footer.download}</a>
          </div>
          <div>
            <p className="eyebrow">{t.footer.company}</p>
            <button type="button" onClick={openContactDialog}>{t.footer.partner}</button>
            <button type="button" onClick={openContactDialog}>{t.footer.contact}</button>
          </div>
        </div>
        <LanguageSwitcher className="lang-switch" compact />
      </footer>
    </main>
  );
}
