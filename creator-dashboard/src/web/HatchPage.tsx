"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { LOCALES, useLocale } from "../locale.jsx";
import { landingCopy, type Lang, type LandingCopy, type Scenario } from "./landingCopy";

const TRY_HREF = "/studio";
const SHOW_PRICING = false;
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

function FlipWords({ words }: { words: string[] }) {
  const [i, setI] = useState(2);
  useEffect(() => {
    const id = window.setInterval(() => setI((v) => (v + 1) % words.length), 2200);
    return () => window.clearInterval(id);
  }, [words]);
  const w = words[i % words.length];
  return (
    <span className="flip" aria-label={words.join(" / ")}>
      <span className="flip-w" key={w} aria-hidden="true">
        {[...w].map((ch, k) => (
          <span key={k} style={{ animationDelay: `${k * 45}ms` }}>{ch === " " ? "\u00a0" : ch}</span>
        ))}
      </span>
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

function useScrollStep() {
  const [step, setStep] = useState(0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setStep(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-62% 0px -33% 0px" },
    );
    refs.current.forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  }, []);
  return [step, refs] as const;
}

function Story({ t, s }: { t: LandingCopy; s: Scenario }) {
  const [step, refs] = useScrollStep();

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

function Count({ to }: { to: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((v) => (v >= to ? v : v + 2)), 24);
    return () => window.clearInterval(id);
  }, [to]);
  return <>{Math.min(n, to)}</>;
}

const LEARN_PHOTOS = ["l_read", "l_voice", "l_eval", "l_live"];

function Learn({ t, s }: { t: LandingCopy; s: Scenario }) {
  const [step, refs] = useScrollStep();
  const k = t.learnKit;
  return (
    <section className="story learn-story" id="learn">
      <div className="story-steps">
        <span className="pill pill-l">{t.learnLabel}</span>
        <h2 className="title">{t.learnTitle}</h2>
        <p className="lead">{t.learnBody}</p>
        {t.learnSteps.map((st, i) => (
          <article
            key={st.tag}
            data-i={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            className={`story-step ${i === step ? "on" : ""}`}
          >
            <span className="step-n">0{i + 1}</span>
            <h3>{st.title}</h3>
            <p>{st.body}</p>
          </article>
        ))}
      </div>
      <div className="story-phone">
        <div className="learn-stage">
          {LEARN_PHOTOS.map((id, i) => (
            <Photo key={id} id={id} alt="" className={`fill ${i === step ? "on" : ""}`} />
          ))}
          <div className="glass lc" key={`${step}-${s.field}`}>
            {step === 0 && (
              <>
                <span className="sk-label">{t.learnSteps[0].title}</span>
                {k.read.map(([slug, name, n], i) => (
                  <div className="lc-row" key={name} style={{ animationDelay: `${i * 160}ms` }}>
                    {slug ? <img src={`https://cdn.simpleicons.org/${slug}`} alt="" width={18} height={18} /> : <span className="lc-doc" />}
                    <b>{name}</b>
                    <small>{n}</small>
                    <span className="sk-pass">✓</span>
                  </div>
                ))}
                <span className="chip chip-green lc-pop">{k.readDone}</span>
              </>
            )}
            {step === 1 && (
              <>
                <span className="sk-label">{t.learnSteps[1].title} · {s.field}</span>
                <p className="bubble ai"><Typed text={s.interviewQ} /></p>
                <div className="bubble me lc-voice" style={{ animationDelay: "1.6s" }}>
                  <span className="wave">{Array.from({ length: 18 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 60}ms` }} />)}</span>
                  {k.voice}
                </div>
                <p className="bubble ai" style={{ animationDelay: "2.4s" }}>{k.follow}</p>
                <div className="lc-note" style={{ animationDelay: "3.2s" }}>
                  <span className="chip chip-yolk">{k.noted}</span>
                  <p>{s.take}</p>
                </div>
              </>
            )}
            {step === 2 && (
              <>
                <span className="sk-label">{k.evalTitle}</span>
                {[s.client, ...k.evalCases].map((q, i) => (
                  <div className="lc-row" key={q} style={{ animationDelay: `${i * 260}ms` }}>
                    <span className={i === 2 ? "sk-redo" : "sk-pass"}>{i === 2 ? "↻" : "✓"}</span>
                    <p>{q}</p>
                    {i === 2 && <em className="soon">{k.evalRedo}</em>}
                  </div>
                ))}
                <div className="lc-score">
                  <small>{k.score}</small>
                  <b><Count to={96} />%</b>
                </div>
                <div className="lc-meter"><i /></div>
              </>
            )}
            {step === 3 && (
              <>
                <div className="lc-head">
                  <span className="avatar">{s.field.slice(0, 1)}</span>
                  <div>
                    <b>{s.field}</b>
                    <small>{k.liveLink}</small>
                  </div>
                </div>
                <span className="lc-approve">{k.approve} ✓</span>
                <span className="chip chip-green lc-pop">● {k.liveStatus}</span>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
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
  const ref = useRef<HTMLElement>(null);
  const [p, setP] = useState(0);
  useEffect(() => {
    const onScroll = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setP(Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - window.innerHeight))));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  const k = Math.min(1, Math.max(0, (p - 0.3) / 0.35));
  return (
    <section className="pro-scroll" ref={ref}>
      <div className="pro-sticky">
        <span className="pill">{t.proLabel}</span>
        <h2 className="title center">{t.proTitle}</h2>
        <p className="lead center">{t.proBody}</p>
        <div className="pro-cards">
          <div className="pro-card" style={{ transform: `scale(${1 - 0.06 * k})`, opacity: 1 - 0.5 * k }}>
            <Photo className="fill" id="pro" alt={t.proPhoto.alt} />
            <div className="pro-bubble">
              <Egg size={20} />
              <p>{t.proBubble}</p>
            </div>
          </div>
          <div className="pro-card pro-card-2" style={{ transform: `translateY(${(1 - k) * 110}%)` }}>
            <Photo className="fill" id="pro2" alt={t.proPhoto2.alt} />
            <div className="glass pro-tasks">
              {t.proTasks.map((task, i) => (
                <p key={task.t} className={p > 0.7 + i * 0.07 ? "done" : ""}>
                  <i className="ring" />
                  <span><b>{task.t}</b><small>{task.m}</small></span>
                </p>
              ))}
            </div>
          </div>
          <div className="pro-dots"><i className={k < 0.5 ? "on" : ""} /><i className={k >= 0.5 ? "on" : ""} /></div>
        </div>
      </div>
    </section>
  );
}

function useInView<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setInView(true), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}


function useProgress(play: number, ms: number, linear = false) {
  const [p, setP] = useState(0);
  useEffect(() => {
    if (!play) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const k = Math.min((now - t0) / ms, 1);
      setP(linear ? k : 1 - Math.pow(1 - k, 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [play, ms, linear]);
  return p;
}

const MARKS = [0.12, 0.55, 1];

function Growth({ t, play }: { t: LandingCopy; play: number }) {
  const path = useRef<SVGPathElement>(null);
  const p = useProgress(play, 2600);
  const el = path.current;
  const len = el ? el.getTotalLength() : 320;
  const at = (q: number) => (el ? el.getPointAtLength(len * q) : { x: 8, y: 104 });
  const tip = at(p);
  return (
    <div className="art art-growth">
      <div className="g-like">
        <small>{t.growth.like}</small>
        <b>{Math.round(41 + 55 * p)}%</b>
      </div>
      <div className="g-plot">
        <svg viewBox="0 0 240 120" aria-hidden="true">
          <path className="g-track" d="M8 104 C 50 100, 70 88, 100 76 S 160 40, 232 14" />
          <path ref={path} className="g-line" d="M8 104 C 50 100, 70 88, 100 76 S 160 40, 232 14" style={{ strokeDasharray: len, strokeDashoffset: len * (1 - p) }} />
          {MARKS.map((m) => {
            const pt = at(m);
            return <circle key={m} className={`g-mark ${p >= m - 0.001 ? "on" : ""}`} cx={pt.x} cy={pt.y} r="4" />;
          })}
          <circle className="g-tip" cx={tip.x} cy={tip.y} r="7" />
          {p >= 1 && <circle className="g-ring" cx={tip.x} cy={tip.y} r="7" />}
        </svg>
        {MARKS.map((m, i) => {
          const pt = at(m);
          return (
            <span key={m} className={`g-label g-l${i} ${p >= m - 0.001 ? "on" : ""}`} style={{ left: `${(pt.x / 240) * 100}%`, top: `${(pt.y / 120) * 100}%` }}>
              {t.growth.marks[i]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

const EVENTS = [0.09, 0.48, 0.88];

function Clock({ t, play }: { t: LandingCopy; play: number }) {
  const p = useProgress(play, 3200);
  const c = t.clock;
  const pos = (q: number, r: number) => {
    const a = q * Math.PI * 2 - Math.PI / 2;
    return { x: 100 + r * Math.cos(a), y: 100 + r * Math.sin(a) };
  };
  const hand = pos(p, 62);
  return (
    <div className="art art-clock2">
      <div className="ck-stats">
        <div><small>{c.you}</small><b>{c.youN}</b></div>
        <div className="ck-it"><small>{c.it}</small><b>{Math.round(100 * p)}{c.unit}</b></div>
      </div>
      <div className="ck-dial">
        <svg viewBox="0 0 200 200" aria-hidden="true">
          <circle className="ck-face" cx="100" cy="100" r="78" />
          <path className="ck-night" d="M100 22 A78 78 0 0 1 100 178" transform="rotate(90 100 100)" />
          <circle className="ck-track" cx="100" cy="100" r="90" />
          <circle className="ck-arc" cx="100" cy="100" r="90" pathLength={1} style={{ strokeDashoffset: 1 - p }} transform="rotate(-90 100 100)" />
          <line className="ck-hand" x1="100" y1="100" x2={hand.x} y2={hand.y} />
          <circle className="ck-hub" cx="100" cy="100" r="6" />
          <text className="ck-sun" x="100" y="44">☀︎</text>
          <text className="ck-moon" x="100" y="166">☾</text>
        </svg>
        {EVENTS.map((q, i) => {
          const d = pos(q, 100);
          return (
            <span key={q} className={`ck-ev ck-e${i} ${p >= q ? "on" : ""}`} style={{ left: `${d.x / 2}%`, top: `${d.y / 2}%` }}>
              {c.events[i]}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function Vault({ t, play }: { t: LandingCopy; play: number }) {
  const p = useProgress(play, 4200, true);
  const v = t.vault;
  const stage = p < 0.02 ? 0 : p < 0.42 ? 1 : p < 0.55 ? 2 : p < 0.92 ? 3 : 4;
  return (
    <div className={`art art-vault s${stage}`}>
      {v.items.map((it, i) => (
        <span key={it} className={`vt-item vt-i${i}`}>{it}</span>
      ))}
      <div className="vt-lock">
        <i className="vt-ring" />
        <svg viewBox="0 0 64 72" aria-hidden="true">
          <path className="vt-shackle" d="M18 34 V22 a14 14 0 0 1 28 0 V34" />
          <rect className="vt-body" x="8" y="32" width="48" height="36" rx="10" />
          <circle className="vt-key" cx="32" cy="48" r="5" />
          <rect className="vt-key" x="30" y="50" width="4" height="9" rx="2" />
        </svg>
      </div>
      <span className="vt-other">{v.other} <b>✕</b></span>
      <span className="vt-done">✓ {v.locked}</span>
    </div>
  );
}

function Asset({ t }: { t: LandingCopy }) {
  const [ref, inView] = useInView<HTMLElement>();
  const [play, setPlay] = useState(0);
  useEffect(() => {
    if (inView) setPlay(1);
  }, [inView]);
  return (
    <section className={`section asset ${inView ? "in" : ""}`} ref={ref}>
      <span className="pill">{t.assetLabel}</span>
      <h2 className="title center">{t.assetTitle}</h2>
      <div className="bento">
        {t.assets.map((a, i) => (
          <article className={`bento-card tint-${i}`} key={a.title} onClick={() => setPlay((v) => v + 1)}>
            <h3>{a.title}</h3>
            <p>{a.body}</p>
            {i === 0 ? <Vault t={t} play={play} /> : i === 1 ? <Growth t={t} play={play} /> : <Clock t={t} play={play} />}
          </article>
        ))}
      </div>
    </section>
  );
}

function Compare({ t, s }: { t: LandingCopy; s: Scenario }) {
  const [tab, setTab] = useState(0);
  const reply = tab === 0 ? null : t.compareReplies[tab - 1];
  return (
    <section className="section">
      <span className="pill">{t.compareLabel}</span>
      <div className="seg" role="tablist">
        {t.compareCols.map((c, i) => (
          <button key={c} role="tab" aria-selected={tab === i} className={tab === i ? "on" : ""} onClick={() => setTab(i)}>
            {c}
          </button>
        ))}
      </div>
      <div className="cmp-card">
        <Photo className="fill" id="compare" alt="" />
        <div className="cmp-chat glass" key={`${tab}-${s.field}`}>
          <small>{t.compareAsk}</small>
          <p className="bubble me">{s.client}</p>
          {reply ? (
            <p className="bubble ai dim">{reply}</p>
          ) : (
            <>
              <p className="bubble ai"><Typed text={s.take} /></p>
              <p className="bubble ai" style={{ animationDelay: "1.4s" }}>{s.ask}</p>
            </>
          )}
          <div className="cmp-checks">
            {t.compareRows.map((r) => (
              <span key={r.label} className={r.v[tab] ? "yes" : "no"}>{r.v[tab] ? "✓" : "✕"} {r.label}</span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Trust({ t }: { t: LandingCopy }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  return (
    <section className="section">
      <span className="pill">{t.trustLabel}</span>
      <div className={`trust-stage ${inView ? "in" : ""}`} ref={ref}>
        <Photo className="fill" id="trust" alt="" />
        <div className="glass trust-panel">
          {t.trust.map((col, gi) => (
            <div className="trust-group" key={col.title}>
              <b>{col.title}</b>
              {col.items.map((item, i) => (
                <div className="trust-row" key={item} style={{ transitionDelay: `${(gi * 2 + i) * 140}ms` }}>
                  <span>{item}</span>
                  {gi === 2 ? <em className="trust-act">{i === 0 ? "✎" : "⌫"}</em> : <i className={`switch ${gi === 0 ? "on" : "off"}`} />}
                </div>
              ))}
            </div>
          ))}
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
    document.title = "Hatch — Private intelligence for experts";
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
          {SHOW_PRICING && <a href="#pricing">{t.nav.pricing}</a>}
          <a href="#faq">{t.nav.faq}</a>
        </nav>
        <div className="nav-right">
          <a className="nav-login" href="/studio">{t.nav.login}</a>
          <a className="btn btn-ink btn-sm" href={TRY_HREF}>{t.nav.try}</a>
        </div>
      </header>

      <section className="hero" id="top">
        <span className="pill">{t.heroEyebrow}</span>
        <h1>
          <span>{t.heroTitleA[0]}<FlipWords words={t.heroWords} />{t.heroTitleA[1]}</span>
          <em>{t.heroTitleB}</em>
        </h1>
        <p className="hero-body">{t.heroBody}</p>
        <FieldPicker t={t} value={field} onChange={setField} />
      </section>

      <Story key={`${lang}-${field}`} t={t} s={s} />

      <Reveal key={`reveal-${lang}`} segments={t.revealSegments} />
      <Memory t={t} />
      <Proactive t={t} />

      <Asset t={t} />

      <section className="where">
        <span className="pill">{t.whereLabel}</span>
        <div className="marquee">
          <div className="logos">
            {[...PLATFORMS, ...PLATFORMS].map(([slug, zhName, name], i) => (
              <Logo key={`${slug}-${i}`} slug={slug} name={lang === "zh" ? zhName : name} />
            ))}
          </div>
        </div>
        <p className="fine">{t.whereNote}</p>
      </section>

      <Learn t={t} s={s} />

      <Stories t={t} />

      <Compare key={lang} t={t} s={s} />

      <Trust t={t} />

      {SHOW_PRICING && (
      <section className="section" id="pricing">
        <span className="pill">{t.pricingLabel}</span>
        <h2 className="title center">{t.pricingTitle}</h2>
        <div className="plans">
          {t.plans.map((p) => (
            <article className={`plan ${p.cta ? "plan-main" : ""}`} key={p.name}>
              <span className="pill pill-l">{p.name}</span>
              <p className="plan-price">{p.price}</p>
              <p>{p.body}</p>
              {p.cta && tryButton}
            </article>
          ))}
        </div>
        <p className="fine">{t.pricingNote}</p>
      </section>
      )}

      <section className="section" id="faq">
        <span className="pill">{t.faqLabel}</span>
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
      <div className="giant" aria-hidden="true">Hatch<span>.</span></div>
    </main>
  );
}
