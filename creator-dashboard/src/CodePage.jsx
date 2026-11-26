import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check } from "lucide-react";
import { WebChatEgg } from "./webChatGate.jsx";
import CoBrandLockup from "./CoBrandLockup.jsx";
import { LanguageSwitcher } from "./LanguageSwitcher.jsx";
import { useLocale } from "./locale.jsx";
import { codePageErrorText, codePageT } from "./codePageI18n.js";
import { BUYER_FIELDS, CodeRoute, advance, fieldLabel, pickText, hookCopy, reachableStep, stepFromHash, stepHash, PendingIntake, accessCodePayUrl, createStatusPoller, feedPool, feedWindow, formatPrice, inWeChat, intakeAnswers, isDesktop, invalidField, missingField, siteDomain, stepStates, waitLine, readyLine, typedCode, visibleSteps } from "./codePageModel.js";
import "./webChat.css";
import "./artifact.css";
import "./codePage.css";

const POLL_MS = 8000;
const API = "/v1/web-chat/code";
const FEED_MS = 2400;
const SCAN_QR = "https://hatch-downloads.oss-cn-shanghai.aliyuncs.com/brand/cobrand/gethatchapp-c-qr.jpg";
const WAIT_TICK_MS = 30000;
const INPUT_TYPES = { email: "email", tel: "tel", url: "url" };

/** The page's language and its translator: the visitor's pick, else their browser's (LocaleProvider). */
function useCopy() {
  const { locale } = useLocale();
  const t = useCallback((key, values) => codePageT(locale, key, values), [locale]);
  return { locale, t };
}

/** Top right of every state, where the visitor changes the language. */
const LanguageCorner = () => <div className="code-page__lang"><LanguageSwitcher /></div>;

/** The card every state sits in. */
const Card = ({ children }) => <main className="code-page"><LanguageCorner /><div className="code-page__card">{children}</div></main>;

/** The mark of WeChat Pay: two speech bubbles, in the button's own colour. */
const WeChatPayMark = () => <svg className="code-page__wxmark" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
  <path fill="currentColor" d="M9.5 3C5.4 3 2 5.8 2 9.3c0 2 1.1 3.7 2.8 4.9l-.7 2.1 2.5-1.3c.9.3 1.8.4 2.9.4h.5a5.5 5.5 0 0 1-.3-1.7c0-3.2 3-5.8 6.7-5.8h.4C16.1 5 13.1 3 9.5 3Zm-3 3.6a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm6 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z" />
  <path fill="currentColor" d="M22 14.2c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.8 0 1.6-.1 2.3-.4l2 1.1-.6-1.8c1.5-.9 2.3-2.3 2.3-3.9Zm-7.9-.7a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Zm3.8 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Z" />
</svg>;

/** The header of every state of a code's page: the MSC × Hatch lockup, the Product, and the website being diagnosed. The lockup carries the expert. */
function Header({ product, website }) {
  const { t } = useCopy();
  const domain = siteDomain(website);
  return <header className="code-page__header">
    <CoBrandLockup cap={17} />
    <div className="code-page__who">
      <strong>{product?.name ?? t("productFallback")}</strong>
      {domain ? <span className="code-page__site">{domain}</span> : null}
    </div>
  </header>;
}

/** Desktop browsers cannot pay by WeChat H5: the buyer scans this static code (it opens gethatchapp.com/c) with a phone and pays there. */
function ScanToPay() {
  const { t } = useCopy();
  return <div className="code-page__scan" role="status">
    <p><strong>{t("scanTitle")}</strong></p>
    <img src={SCAN_QR} width="180" height="180" alt={t("scanAlt")} />
  </div>;
}

/** One field: the label above, the box below. A Brief field of type text is a textarea; the rest are one line. */
function Field({ field, label, value, onChange, autoFocus }) {
  const { t } = useCopy();
  const common = { id: `cp-${field.id}`, name: field.id, autoFocus, value, onChange: event => onChange(event.target.value), autoComplete: field.autoComplete };
  return <div className="code-page__field">
    <label htmlFor={common.id}>{label}{field.required ? null : <em>{t("optional")}</em>}</label>
    {field.type === undefined || field.type === "text"
      ? <textarea {...common} maxLength={32000} rows={4} />
      : <input {...common} type={INPUT_TYPES[field.type] ?? "text"} maxLength={field.type === "email" ? 254 : 2000} />}
  </div>;
}

/** A code typed in opens its own page: a 兑换码 its report, an 活动码 a new code of the person's own. */
function CodeBox({ navigate, label, action }) {
  const { t } = useCopy();
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const open = event => {
    event.preventDefault();
    const typed = typedCode(code);
    if (!typed) { setError(t("codeNotFound", { label })); return; }
    navigate(CodeRoute.codePath(typed));
  };
  return <form className="code-page__code" onSubmit={open}>
    <input autoFocus autoCapitalize="characters" autoComplete="off" placeholder={label} aria-label={label} value={code} onChange={event => { setCode(event.target.value); setError(null); }} />
    <button type="submit" className="code-page__button code-page__button--quiet" disabled={!code.trim()}>{action}</button>
    {error ? <p className="code-page__error" role="alert">{error}</p> : null}
  </form>;
}

/** The way back to the screen before. */
function BackArrow({ onClick }) {
  const { t } = useCopy();
  return <button type="button" className="code-page__back" aria-label={t("back")} onClick={onClick}><ArrowLeft size={22} aria-hidden /></button>;
}

/** Step 1: the Agent introduces itself, in the Product's own words. */
function Hook({ landing, reason, onStart, navigate }) {
  const { locale, t } = useCopy();
  const { agentName, hook, cta } = hookCopy(landing, locale, t);
  // Below the main button: 有活动码？ opens the event code (offline events only); from there, a one-person 兑换码.
  const [entry, setEntry] = useState(null);
  return <main className="code-page code-page--hook">
    <LanguageCorner />
    {reason ? <p className="code-page__error" role="alert">{codePageErrorText({ code: reason }, locale)}</p> : null}
    <div className="code-page__intro">
      <CoBrandLockup cap={24} />
      {hook ? <h1 className="code-page__hook">{hook}</h1> : null}
      <p className="code-page__by"><strong>{agentName}</strong></p>
    </div>
    <div className="code-page__actions">
      <button type="button" className="code-page__button" disabled={!landing} onClick={onStart}>{cta}</button>
      {entry === null ? <button type="button" className="code-page__link" onClick={() => setEntry("event")}>{t("hasEventCode")}</button> : null}
      {entry === "event" ? <div className="code-page__entry">
        <CodeBox key="event" navigate={navigate} label={t("eventCode")} action={t("use")} />
        <p className="code-page__hint">{t("eventHint")}</p>
        <button type="button" className="code-page__link code-page__link--small" onClick={() => setEntry("code")}>{t("toAccessCode")}</button>
      </div> : null}
      {entry === "code" ? <div className="code-page__entry">
        <CodeBox key="code" navigate={navigate} label={t("accessCode")} action={t("open")} />
        <p className="code-page__hint">{t("accessHint")}</p>
        <button type="button" className="code-page__link code-page__link--small" onClick={() => setEntry("event")}>{t("toEventCode")}</button>
      </div> : null}
    </div>
  </main>;
}

/** /c/: the product page, three screens: the Agent's hook, the form, and the order with its payment. The hash says which; Back moves between them. */
function Landing({ request, navigate, reason }) {
  const { t } = useCopy();
  const [landing, setLanding] = useState(null);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [wanted, setWanted] = useState(() => stepFromHash(window.location.hash));
  const pushed = useRef(0);
  const step = reachableStep(wanted, values);
  const path = `${window.location.pathname}${window.location.search}`;
  useEffect(() => { request("/v1/web-chat/code-landing").then(setLanding, () => setFailed(true)); }, [request]);
  useEffect(() => {
    const sync = () => { setWanted(stepFromHash(window.location.hash)); setError(null); };
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  useEffect(() => { if (step !== wanted) window.history.replaceState(null, "", `${path}${stepHash(step)}`); }, [step, wanted, path]);
  const go = to => { pushed.current += 1; window.history.pushState(null, "", `${path}${stepHash(to)}`); setWanted(to); setError(null); };
  const back = () => {
    if (pushed.current > 0) { pushed.current -= 1; window.history.back(); return; }
    window.history.replaceState(null, "", `${path}${stepHash(step === "pay" ? "form" : "hook")}`);
    setWanted(step === "pay" ? "form" : "hook");
  };
  const next = event => {
    event?.preventDefault();
    const result = advance(step, values, t);
    if (result.error) { setError(result.error); return; }
    go(result.step);
  };
  const ready = Boolean(landing?.product_id && landing.price_fen);
  const [scan, setScan] = useState(false);
  const pay = () => {
    if (isDesktop({ userAgent: window.navigator.userAgent, maxTouchPoints: window.navigator.maxTouchPoints })) { setScan(true); return; }
    PendingIntake.save(window.localStorage, values);
    window.location.assign(accessCodePayUrl({ productId: landing.product_id, email: values.email, origin: window.location.origin, site: values.website, name: values.name, locale }));
  };
  if (failed) return <Card><p className="code-page__error" role="alert">{t("unreachable")}</p></Card>;
  if (step === "hook") return <Hook landing={landing} reason={reason} onStart={next} navigate={navigate} />;
  const header = <Header product={landing} website={step === "pay" ? values.website : undefined} />;
  if (step === "form") return <Card>
    {header}
    <BackArrow onClick={back} />
    <form onSubmit={next} noValidate>
      {BUYER_FIELDS.map(field => <Field key={field.id} field={field} label={t(`field_${field.id}`)} value={values[field.id] ?? ""} onChange={value => { setValues(current => ({ ...current, [field.id]: value })); setError(null); }} />)}
      {error ? <p className="code-page__error" role="alert">{error}</p> : null}
      <button type="submit" className="code-page__button">{t("next")}</button>
    </form>
  </Card>;
  return <Card>
    {header}
    <BackArrow onClick={back} />
    <dl className="code-page__order">
      <div><dt>{t("orderProduct")}</dt><dd>{landing?.name}</dd></div>
      {landing?.creator_name ? <div><dt>{t("orderExpert")}</dt><dd>{landing.creator_name}</dd></div> : null}
      <div><dt>{t("orderWebsite")}</dt><dd>{siteDomain(values.website)}</dd></div>
      <div><dt>{t("field_name")}</dt><dd>{values.name?.trim()}</dd></div>
      <div><dt>{t("field_email")}</dt><dd>{values.email?.trim()}</dd></div>
    </dl>
    {landing?.price_fen ? <p className="code-page__price">{formatPrice(landing.price_fen)}</p> : null}
    <button type="button" className="code-page__button code-page__button--wechat" disabled={!ready} onClick={pay}><WeChatPayMark /><span>{t("wechatPay")} {landing?.price_fen ? formatPrice(landing.price_fen) : ""}</span></button>
    {scan ? <ScanToPay /> : null}
  </Card>;
}

/**
 * The Brief's own fields, as the Product defines them; the code is the page's address, so it is not asked. Answers given on the product
 * page before paying are submitted here by themselves, once; without them (or with some missing) the form is shown for the buyer to fill.
 */
function Intake({ status, code, request, onStatus }) {
  const { locale, t } = useCopy();
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const started = useRef(false);
  const send = async answers => {
    setSending(true);
    setError(null);
    try { onStatus(await request(`${API}/${encodeURIComponent(code)}/intake`, { method: "POST", body: JSON.stringify({ ...intakeAnswers(status.fields, answers), locale }) })); }
    catch (cause) { setError(codePageErrorText(cause, locale, "submitFailed")); setSending(false); }
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const saved = PendingIntake.take(window.localStorage);
    if (!saved) return;
    setValues(saved);
    if (!missingField(status.fields, saved)) void send(saved);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = event => {
    event.preventDefault();
    const missing = missingField(status.fields, values);
    if (missing) { setError(t("missingField", { field: fieldLabel(missing, locale) })); return; }
    void send(values);
  };
  if (sending) return <Card><div className="web-chat__loading code-page__sending" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /><span>{t("starting")}</span></div></Card>;
  return <Card><Header product={status.product} website={values.website} /><form onSubmit={submit} noValidate>
    {status.fields.map((field, index) => <Field key={field.id} field={field} label={fieldLabel(field, locale)} autoFocus={index === 0} value={values[field.id] ?? ""} onChange={value => setValues(current => ({ ...current, [field.id]: value }))} />)}
    {error ? <p className="code-page__error" role="alert">{error}</p> : null}
    <button type="submit" className="code-page__button">{t("startDiagnosis")}</button>
  </form></Card>;
}

/** An event code's page: it issues this person a code of their own and moves to that code's page, which then runs as any free code's. */
function EventIssue({ code, request, navigate }) {
  const { locale } = useCopy();
  const [error, setError] = useState(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    request(`${API}/${encodeURIComponent(code)}/issue`, { method: "POST", body: JSON.stringify({ locale }) })
      .then(issued => navigate(CodeRoute.codePath(issued.code), { replace: true }), cause => setError(codePageErrorText(cause, locale)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <Card><p className="code-page__error" role="alert">{error}</p></Card>;
  return <Card><div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /></div></Card>;
}

/** Buying another report: back to the product page. */
function NewReport({ navigate }) {
  const { t } = useCopy();
  return <button type="button" className="code-page__button code-page__button--quiet code-page__new" onClick={() => navigate(CodeRoute.landingPath())}>{t("newReport")}</button>;
}

/** The wait: the steps of the Product's own map, marked by what the Run has really done. Without a map, only the wait. */
function Generating({ status, navigate }) {
  const { locale, t } = useCopy();
  const steps = stepStates(visibleSteps(status.steps).map(step => ({ ...step, label: pickText(step.label, locale) })), status.step);
  const [tick, setTick] = useState(0);
  useEffect(() => { const timer = setInterval(() => setTick(value => value + 1), FEED_MS); return () => clearInterval(timer); }, []);
  const lines = feedWindow(feedPool({ steps, step: status.step, t }), tick);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), WAIT_TICK_MS); return () => clearInterval(timer); }, []);
  return <Card><Header product={status.product} website={status.website} /><div className="code-page__wait">
    <p className="code-page__generating" role="status">{t("generating")}</p>
    {steps.length ? <ol className="code-page__steps">{steps.map(step => <li key={step.id} className={`code-page__step code-page__step--${step.state}`} aria-current={step.state === "now" ? "step" : undefined}>
      {step.state === "done" ? <Check size={16} aria-hidden /> : step.state === "now" ? <span className="code-page__spinner" aria-hidden /> : <span className="code-page__dot" aria-hidden />}
      <span>{step.label}</span>
    </li>)}</ol> : null}
    <ul className="code-page__feed" aria-live="off">{lines.map(line => <li key={`${tick}-${line}`}>{line}</li>)}</ul>
    <p className="code-page__note">{waitLine({ startedAt: status.started_at, now, email: status.email, t })}</p>
    <NewReport navigate={navigate} />
  </div></Card>;
}

/** The page of one code. What shows is whatever the server says the code stands at, read again every few seconds while the report is being made. */
function CodePageBody({ code, request, navigate }) {
  const { locale, t } = useCopy();
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const poller = useRef(null);

  useEffect(() => {
    setStatus(null);
    setError(null);
    if (!code) return undefined;
    const next = createStatusPoller({
      read: () => request(`${API}/${encodeURIComponent(code)}`),
      onStatus: value => { setStatus(value); setError(null); },
      onError: setError, every: POLL_MS
    });
    poller.current = next;
    void next.start();
    return () => next.stop();
  }, [code, request]);

  if (!code) return <Landing request={request} navigate={navigate} />;
  if (error && !status) return <Card><p className="code-page__error" role="alert">{codePageErrorText(error, locale, "readFailed")}</p></Card>;
  if (!status) return <Card><div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /></div></Card>;
  switch (status.state) {
    case "entry": return <Landing request={request} navigate={navigate} reason={status.reason} />;
    case "event": return <EventIssue code={code} request={request} navigate={navigate} />;
    case "intake": return <Intake status={status} code={code} request={request} onStatus={next => poller.current.accept(next)} />;
    case "generating": return <Generating status={status} navigate={navigate} />;
    case "ready": return <Card><Header product={status.product} website={status.website} /><div className="code-page__done">
      <div className="code-page__success"><span className="code-page__success-mark"><Check size={28} strokeWidth={3} aria-hidden /></span><p role="status">{readyLine(status.name, t)}</p></div>
      <a className="code-page__button code-page__report" href={status.report_url} rel="noopener">{t("viewReport")}</a>
      <NewReport navigate={navigate} />
    </div></Card>;
    default: return <Card><Header product={status.product} website={status.website} /><p className="code-page__failed" role="alert">{t("failed")}</p></Card>;
  }
}

/** In WeChat's own browser only the way out is shown, whatever the address. */
export default function CodePage(props) {
  const { t } = useCopy();
  return inWeChat(window.navigator.userAgent)
    ? <main className="code-page__guide"><ArrowUpRight className="code-page__arrow" size={72} strokeWidth={2.5} aria-hidden /><p>{t("wechatGuide")}</p></main>
    : <CodePageBody {...props} />;
}
