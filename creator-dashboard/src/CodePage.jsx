import React, { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { WebChatEgg } from "./webChatGate.jsx";
import { BUYER_FIELDS, CodeRoute, PendingIntake, accessCodePayUrl, formatPrice, inWeChat, intakeAnswers, invalidField, missingField, stepStates, typedCode } from "./codePageModel.js";
import "./webChat.css";
import "./artifact.css";
import "./codePage.css";

const POLL_MS = 5000;
const API = "/v1/web-chat/code";
const REFUSALS = { not_found: "兑换码不存在", not_paid: "尚未支付" };
const INPUT_TYPES = { email: "email", tel: "tel", url: "url" };

/** The card every state sits in. */
const Card = ({ children }) => <main className="code-page"><div className="code-page__card">{children}</div></main>;

/** One field: the label above, the box below. A Brief field of type text is a textarea; the rest are one line. */
function Field({ field, value, onChange, autoFocus }) {
  const common = { id: `cp-${field.id}`, name: field.id, autoFocus, value, onChange: event => onChange(event.target.value), autoComplete: field.autoComplete };
  return <div className="code-page__field">
    <label htmlFor={common.id}>{field.label}{field.required ? null : <em>选填</em>}</label>
    {field.type === undefined || field.type === "text"
      ? <textarea {...common} maxLength={32000} rows={4} />
      : <input {...common} type={INPUT_TYPES[field.type] ?? "text"} maxLength={field.type === "email" ? 254 : 2000} />}
  </div>;
}

/** The way in for an old report: its code, opening its own page. */
function CodeBox({ navigate }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState(null);
  const open = event => {
    event.preventDefault();
    const typed = typedCode(code);
    if (!typed) { setError("兑换码不存在"); return; }
    navigate(CodeRoute.codePath(typed));
  };
  return <form className="code-page__code" onSubmit={open}>
    <input autoFocus autoCapitalize="characters" autoComplete="off" placeholder="兑换码" aria-label="兑换码" value={code} onChange={event => { setCode(event.target.value); setError(null); }} />
    <button type="submit" className="code-page__button code-page__button--quiet" disabled={!code.trim()}>打开</button>
    {error ? <p className="code-page__error" role="alert">{error}</p> : null}
  </form>;
}

/** /c/: the product page. What is sold, what it costs, what the audit needs; paying is the one way forward, and answers wait for the way back. */
function Landing({ request, navigate, reason }) {
  const [landing, setLanding] = useState(null);
  const [failed, setFailed] = useState(false);
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [codeOpen, setCodeOpen] = useState(false);
  useEffect(() => { request("/v1/web-chat/code-landing").then(setLanding, () => setFailed(true)); }, [request]);
  const ready = Boolean(landing?.product_id && landing.price_fen);
  const pay = event => {
    event.preventDefault();
    const invalid = invalidField(values);
    if (invalid) { setError(invalid); return; }
    PendingIntake.save(window.localStorage, values);
    window.location.assign(accessCodePayUrl({ productId: landing.product_id, email: values.email, origin: window.location.origin }));
  };
  if (failed) return <Card><p className="code-page__error" role="alert">暂时无法打开，请稍后再试</p></Card>;
  return <Card>
    {reason ? <p className="code-page__error" role="alert">{REFUSALS[reason]}</p> : null}
    <form onSubmit={pay} noValidate>
      <h1 className="code-page__title">{landing?.name ?? "外贸官网获客诊断"}</h1>
      {landing?.description ? <p className="code-page__lead">{landing.description}</p> : null}
      {landing?.price_fen ? <p className="code-page__price">{formatPrice(landing.price_fen)}</p> : null}
      {BUYER_FIELDS.map(field => <Field key={field.id} field={field} value={values[field.id] ?? ""} onChange={value => { setValues(current => ({ ...current, [field.id]: value })); setError(null); }} />)}
      {error ? <p className="code-page__error" role="alert">{error}</p> : null}
      <button type="submit" className="code-page__button" disabled={!ready}>支付 {landing?.price_fen ? formatPrice(landing.price_fen) : ""} 开始诊断</button>
    </form>
    <button type="button" className="code-page__link" aria-expanded={codeOpen} onClick={() => setCodeOpen(open => !open)}>有兑换码？</button>
    {codeOpen ? <CodeBox navigate={navigate} /> : null}
  </Card>;
}

/**
 * The Brief's own fields, as the Product defines them; the code is the page's address, so it is not asked. Answers given on the product
 * page before paying are submitted here by themselves, once; without them (or with some missing) the form is shown for the buyer to fill.
 */
function Intake({ status, code, request, onStatus }) {
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const started = useRef(false);
  const send = async answers => {
    setSending(true);
    setError(null);
    try { onStatus(await request(`${API}/${encodeURIComponent(code)}/intake`, { method: "POST", body: JSON.stringify(intakeAnswers(status.fields, answers)) })); }
    catch (cause) { setError(cause?.message ?? "提交失败，请重试"); setSending(false); }
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
    if (missing) { setError(`请填写：${missing.label}`); return; }
    void send(values);
  };
  if (sending) return <Card><div className="web-chat__loading code-page__sending" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /><span>正在开始诊断</span></div></Card>;
  return <Card><form onSubmit={submit} noValidate>
    <h1 className="code-page__title">{status.product?.name}</h1>
    {status.fields.map((field, index) => <Field key={field.id} field={field} autoFocus={index === 0} value={values[field.id] ?? ""} onChange={value => setValues(current => ({ ...current, [field.id]: value }))} />)}
    {error ? <p className="code-page__error" role="alert">{error}</p> : null}
    <button type="submit" className="code-page__button">开始诊断</button>
  </form></Card>;
}

/** The wait: the steps of the Product's own map, marked by what the Run has really done. Without a map, only the wait. */
function Generating({ status }) {
  const steps = stepStates(status.steps, status.step);
  return <Card><div className="artifact__generating">
    <div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /><span>报告正在生成</span></div>
    {steps.length ? <ol className="code-page__steps">{steps.map(step => <li key={step.id} className={`code-page__step code-page__step--${step.state}`} aria-current={step.state === "now" ? "step" : undefined}>
      {step.state === "done" ? <Check size={16} aria-hidden /> : step.state === "now" ? <span className="artifact__glyph artifact__glyph--researching code-page__pulse" aria-hidden /> : <span className="code-page__dot" aria-hidden />}
      <span>{step.label}</span>
    </li>)}</ol> : null}
  </div></Card>;
}

/** The page of one code. What shows is whatever the server says the code stands at, read again every few seconds while the report is being made. */
function CodePageBody({ code, request, navigate }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    setStatus(null);
    setError(null);
    if (!code) return undefined;
    let timer;
    const poll = async () => {
      try {
        const next = await request(`${API}/${encodeURIComponent(code)}`);
        if (!live.current) return;
        setStatus(next);
        setError(null);
        if (next.state !== "generating") return;
      } catch (cause) { if (!live.current) return; setError(cause); }
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { live.current = false; clearTimeout(timer); };
  }, [code, request]);

  if (!code) return <Landing request={request} navigate={navigate} />;
  if (error && !status) return <Card><p className="code-page__error" role="alert">{error?.message ?? "暂时无法读取，请稍后再试"}</p></Card>;
  if (!status) return <Card><div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /></div></Card>;
  switch (status.state) {
    case "entry": return <Landing request={request} navigate={navigate} reason={status.reason} />;
    case "intake": return <Intake status={status} code={code} request={request} onStatus={next => { setStatus(next); setError(null); }} />;
    case "generating": return <Generating status={status} />;
    case "ready": return <Card><div className="code-page__done">
      <a className="code-page__button code-page__report" href={status.report_url} rel="noopener">查看报告</a>
    </div></Card>;
    default: return <Card><p className="code-page__failed" role="alert">生成遇到问题，我们会尽快处理</p></Card>;
  }
}

/** In WeChat's own browser only the way out is shown, whatever the address. */
export default function CodePage(props) {
  return inWeChat(window.navigator.userAgent)
    ? <main className="code-page__guide"><ArrowUpRight className="code-page__arrow" size={72} strokeWidth={2.5} aria-hidden /><p>请点击右上角 ··· 选择『在浏览器打开』</p></main>
    : <CodePageBody {...props} />;
}
