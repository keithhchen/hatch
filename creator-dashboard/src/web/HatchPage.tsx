"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LOCALES, useLocale } from "../locale.jsx";
import { landingCopy, type Lang, type LandingCopy, type Scenario } from "./landingCopy";

const TRY_HREF = "/studio";
const WORDMARK = "assets/web/hatch-wordmark.svg";
const LANG_NAMES: Record<Lang, string> = { zh: "中文", en: "English", ja: "日本語" };
const PLATFORMS: [string, string, string][] = [
  ["xiaohongshu", "小红书", "Xiaohongshu"],
  ["wechat", "微信", "WeChat"],
  ["tiktok", "抖音", "TikTok"],
  ["line", "LINE", "LINE"],
  ["whatsapp", "WhatsApp", "WhatsApp"],
  ["instagram", "Instagram", "Instagram"],
  ["youtube", "YouTube", "YouTube"],
  ["x", "X", "X"],
  ["stripe", "Stripe", "Stripe"],
  ["alipay", "支付宝", "Alipay"],
];

function Egg({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 36 44" width={size * 0.82} height={size} aria-hidden="true">
      <path d="M18 2C9.2 2 2 16 2 26a16 16 0 0 0 32 0C34 16 26.8 2 18 2Z" fill="#F5B700" />
      <path d="M7 22l6 4 5-5 5 5 6-4" stroke="#17150F" strokeWidth="2.6" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

const Bar = ({ w, tone }: { w: string; tone?: "dark" | "yolk" }) => <i className={`sk-bar ${tone ?? ""}`} style={{ width: w }} />;

function Typed({ text }: { text: string }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    const id = window.setInterval(() => setN((v) => (v >= text.length ? v : v + 1)), 28);
    return () => window.clearInterval(id);
  }, [text]);
  return (
    <>
      {text.slice(0, n)}
      {n < text.length && <span className="caret" />}
    </>
  );
}

function Logo({ slug, name }: { slug: string; name: string }) {
  const [ok, setOk] = useState(true);
  return (
    <span className="logo">
      {ok && <img src={`https://cdn.simpleicons.org/${slug}`} alt="" width={22} height={22} loading="lazy" onError={() => setOk(false)} />}
      {name}
    </span>
  );
}

function FieldPicker({ t, value, onChange }: { t: LandingCopy; value: number; onChange: (i: number) => void }) {
  return (
    <div className="picker">
      <p className="picker-label">{t.pickLabel}</p>
      <div className="picker-groups">
        {t.roles.map((role, r) => (
          <div className="picker-group" key={role}>
            <span className="picker-role">{role}</span>
            {t.scenarios.map((s, i) =>
              s.role === r ? (
                <button key={s.field} type="button" className={i === value ? "active" : ""} onClick={() => onChange(i)}>
                  {s.field}
                </button>
              ) : null,
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Phone({ t, s, step }: { t: LandingCopy; s: Scenario; step: number }) {
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = thread.current;
    if (!el) return;
    const pin = () => el.scrollTo({ top: el.scrollHeight });
    const mo = new MutationObserver(pin);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, []);
  return (
    <div className="phone-wrap">
      <div className="phone">
        <div className="phone-head">
          <span className="avatar">{s.field.slice(0, 1)}</span>
          <div>
            <b>{s.field}</b>
            <small>{s.source}</small>
          </div>
          <em>{t.exampleTag}</em>
        </div>
        <div className="thread" ref={thread}>
          <p className="bubble me">{s.client}</p>
          {step >= 1 && <p className="bubble ai"><Typed text={s.take} /></p>}
          {step >= 2 && <p className="bubble ai"><Typed text={s.ask} /></p>}
          {step >= 3 && (
            <div className="offer">
              <div>
                <b>{s.offer.name}</b>
                <small>{s.offer.meta}</small>
              </div>
              <span className="offer-price">{s.offer.price}</span>
              <span className="offer-buy">{t.buy}</span>
            </div>
          )}
          {step >= 4 && <p className="delivered">{s.delivered}</p>}
        </div>
      </div>
      {step >= 5 && (
        <div className="toast">
          <Egg size={18} />
          <span>{s.notify}</span>
        </div>
      )}
      {step >= 3 && <span className="float float-b">{t.floatBooked}</span>}
      <span className="float float-c">✓ {t.floatEval}</span>
    </div>
  );
}

function Story({ t, s }: { t: LandingCopy; s: Scenario }) {
  const [step, setStep] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);

  return (
    <section className="story" id="story">
      <div className="story-steps">
        <h2 className="title">{t.storyTitle(s.field)}</h2>
        {t.storySteps.map((st, i) => (
          <article
            key={st.title}
            data-i={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={`story-step ${i === step ? "on" : ""}`}
          >
            <span className="step-n">0{i + 1}</span>
            <h3>
              {st.title}
              {st.soon && <em className="soon">{t.soonTag}</em>}
            </h3>
            <p>{st.body}</p>
          </article>
        ))}
      </div>
      <div className="story-phone">
        <Phone t={t} s={s} step={step} />
      </div>
    </section>
  );
}

function StepArt({ tag }: { tag: string }) {
  if (tag === "READ") {
    return (
      <div className="sk-card" aria-hidden="true">
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
      <div className="sk-card" aria-hidden="true">
        <span className="sk-label">INTERVIEW · 3/11</span>
        <div className="sk-bubble"><Bar w="80%" tone="dark" /><Bar w="55%" tone="dark" /></div>
        <div className="sk-bubble sk-bubble-me"><Bar w="60%" /></div>
        <div className="sk-bubble"><Bar w="72%" tone="yolk" /></div>
      </div>
    );
  }
  return (
    <div className="sk-card" aria-hidden="true">
      <span className="sk-label">EVAL · ROUND 2</span>
      <div className="sk-row"><span className="sk-pass">✓</span><Bar w="64%" /></div>
      <div className="sk-row"><span className="sk-fail">✗</span><Bar w="56%" /></div>
      <div className="sk-row"><span className="sk-redo">↻</span><Bar w="48%" tone="yolk" /></div>
      <div className="sk-row"><span className="sk-pass">✓</span><span className="sk-label">8/8 PASSED</span></div>
    </div>
  );
}

const PHOTO = (id: string) => `assets/web/photos/${id}.jpg`;

function Photo({ id, alt, className = "" }: { id: string; alt: string; className?: string }) {
  return <img className={`ph ${className}`} src={PHOTO(id)} alt={alt} loading="lazy" />;
}

function Reveal({ segments }: { segments: [string, string | null][] }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      setP(Math.min(1, Math.max(0, (vh * 0.85 - r.top) / (r.height + vh * 0.45))));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const chars = segments.flatMap(([text, tone]) => Array.from(text).map((ch) => [ch, tone] as const));
  const lit = Math.round(p * chars.length);
  return (
    <section className="reveal">
      <p ref={ref}>
        {chars.map(([ch, tone], i) => (
          <span key={i} className={`${tone ? `tone-${tone}` : ""} ${i < lit ? "lit" : ""}`}>{ch}</span>
        ))}
      </p>
    </section>
  );
}

function Memory({ t }: { t: LandingCopy }) {
  return (
    <section className="section mem">
      <span className="pill">{t.memLabel}</span>
      <h2 className="title center">{t.memTitle}</h2>
      <p className="lead center">{t.memBody}</p>
      <div className="mem-stage">
        <div className="glass mem-method">
          {t.memMethod.map((m, i) => (
            <p key={m}><i className={`dot dot-${i}`} />{m}</p>
          ))}
          <span className="chip chip-yolk">{t.memMethodTag}</span>
        </div>
        <Photo className="mem-photo" id="mem" alt={t.memPhoto.alt} />
        <div className="glass mem-clients">
          <span className="chip chip-green">{t.memClientsTag}</span>
          {t.memClients.map((c) => (
            <div className="mem-client" key={c.name}>
              <span className="mini-avatar">{c.name.slice(0, 1)}</span>
              <div><b>{c.name}</b><small>{c.meta}</small></div>
            </div>
          ))}
        </div>
      </div>
      <div className="people">
        {t.memPeople.map((pp, i) => (
          <div className="person" key={pp.name}>
            <Photo className="ph-avatar" id={`av${i + 1}`} alt={pp.name} />
            <div><b>{pp.name}</b><small>{pp.role}</small></div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Proactive({ t }: { t: LandingCopy }) {
  return (
    <section className="section pro">
      <span className="pill">{t.proLabel}</span>
      <h2 className="title center">{t.proTitle}</h2>
      <p className="lead center">{t.proBody}</p>
      <div className="pro-cards">
        <div className="pro-card">
          <Photo className="fill" id="pro" alt={t.proPhoto.alt} />
          <div className="pro-bubble">
            <Egg size={20} />
            <p>{t.proBubble}</p>
          </div>
        </div>
        <div className="pro-card">
          <Photo className="fill" id="pro2" alt={t.proPhoto2.alt} />
          <div className="glass pro-tasks">
            {t.proTasks.map((task) => (
              <p key={task.t}><i className="ring" /><span><b>{task.t}</b><small>{task.m}</small></span></p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Stories({ t }: { t: LandingCopy }) {
  return (
    <section className="section stories">
      <span className="pill">{t.storiesLabel}</span>
      <h2 className="title center">{t.storiesTitle}</h2>
      <div className="stories-track">
        {t.stories.map((s, i) => (
          <article className="story-card" key={s.who}>
            <Photo className="fill" id={`s${i + 1}`} alt={s.what} />
            <div className="story-cap">
              <p>{t.storyPrefix} <mark>{s.who}</mark></p>
              <p className="story-what">{s.what}</p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function HatchPage() {
  const { locale, setLocale } = useLocale();
  const lang = locale as Lang;
  const t = landingCopy[lang];
  const [field, setField] = useState(6);
  const s = t.scenarios[field];
  const [contactStatus, setContactStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [isContactDialogOpen, setIsContactDialogOpen] = useState(false);
  const contactDialogRef = useRef<HTMLDialogElement>(null);

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

  const tryButton = (
    <a className="btn btn-yolk" href={TRY_HREF}>
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
          <a href="#story">{t.nav.story}</a>
          <a href="#learn">{t.nav.learn}</a>
          <a href="#pricing">{t.nav.pricing}</a>
          <a href="#faq">{t.nav.faq}</a>
        </nav>
        <div className="nav-right">
          <a className="nav-login" href="/studio">{t.nav.login}</a>
          <a className="btn btn-ink btn-sm" href={TRY_HREF}>{t.nav.try}</a>
        </div>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">{t.heroEyebrow}</p>
        <h1>
          <span>{t.heroTitleA}</span>
          <em>{t.heroTitleB}</em>
        </h1>
        <p className="hero-body">{t.heroBody}</p>
        <FieldPicker t={t} value={field} onChange={setField} />
      </section>

      <Story key={`${lang}-${field}`} t={t} s={s} />

      <Reveal key={`reveal-${lang}`} segments={t.revealSegments} />
      <Memory t={t} />
      <Proactive t={t} />

      <section className="asset">
        <p className="eyebrow">{t.assetLabel}</p>
        <h2 className="title">{t.assetTitle}</h2>
        <div className="asset-grid">
          {t.assets.map((a) => (
            <article key={a.title}>
              <h3>{a.title}</h3>
              <p>{a.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="where">
        <p className="eyebrow">{t.whereLabel}</p>
        <div className="logos">
          {PLATFORMS.map(([slug, zhName, name]) => (
            <Logo key={slug} slug={slug} name={lang === "zh" ? zhName : name} />
          ))}
        </div>
        <p className="fine">{t.whereNote}</p>
      </section>

      <section className="section section-panel" id="learn">
        <p className="eyebrow">{t.learnLabel}</p>
        <div className="learn">
          <div>
            <h2 className="title">{t.learnTitle}</h2>
            <p className="lead">{t.learnBody}</p>
          </div>
          <div className="interview">
            <span className="sk-label">INTERVIEW · {s.field}</span>
            <p className="iv">
              <Typed key={s.interviewQ} text={s.interviewQ} />
            </p>
          </div>
        </div>
        <div className="steps">
          {t.learnSteps.map((st, i) => (
            <article className="step" key={st.tag}>
              <StepArt tag={st.tag} />
              <span className="step-n">0{i + 1}</span>
              <h3>{st.title}</h3>
              <p>{st.body}</p>
            </article>
          ))}
        </div>
      </section>

      <Stories t={t} />

      <section className="section section-panel">
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
              {p.cta && tryButton}
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
        <Egg size={56} />
        <h2>{t.finalTitle}</h2>
        <p>{t.finalBody}</p>
        {tryButton}
        <p className="fine">{t.tryNote}</p>
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
        <div className="footer-brand">
          <a className="nav-brand" href="#top">
            <Egg />
            <img src={WORDMARK} alt="Hatch" width={72} height={28} />
          </a>
          <label className="lang-select">
            <span>{t.footer.language}</span>
            <select value={lang} onChange={(e) => setLocale(e.target.value)}>
              {LOCALES.map((l: Lang) => (
                <option key={l} value={l}>{LANG_NAMES[l]}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="footer-cols">
          <div>
            <p className="eyebrow">{t.footer.product}</p>
            <a href={TRY_HREF}>{t.nav.try}</a>
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
      </footer>
    </main>
  );
}
