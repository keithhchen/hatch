import React, { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Avatar } from "@hatch/ui";
import { WebChatEgg } from "./webChatGate.jsx";
import { CodeRoute, accessCodePayUrl, intakeAnswers, missingField, stepStates, typedCode } from "./codePageModel.js";
import "./webChat.css";
import "./artifact.css";
import "./codePage.css";

const POLL_MS = 5000;
const API = "/v1/web-chat/code";
const REFUSALS = { not_found: "兑换码不存在", not_paid: "尚未支付" };

/** The card every state sits in: the Brief's own look from Product Chat, with nothing else around it. */
const Card = ({ children, ...props }) => <main className="code-page"><div className="web-chat__brief code-page__card" {...props}>{children}</div></main>;

/** No code, or one that opens nothing: a new diagnosis (buy a code) or an old one (type its code). Reports are found by code only. */
function Landing({ request, navigate, reason }) {
  const [productId, setProductId] = useState(null);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [typedError, setTypedError] = useState(null);
  useEffect(() => { request("/v1/web-chat/code-landing").then(({ product_id }) => setProductId(product_id), () => setProductId(null)); }, [request]);
  const open = event => {
    event.preventDefault();
    const typed = typedCode(code);
    if (!typed) { setTypedError("兑换码不存在"); return; }
    navigate(CodeRoute.codePath(typed));
  };
  const ready = productId && email.trim() && /^[^\s@]+@[^\s@]+$/.test(email.trim());
  return <Card>
    {reason ? <p className="web-chat__brief-error" role="alert">{REFUSALS[reason]}</p> : null}
    <h2>新的诊断</h2>
    <label><input type="email" autoComplete="email" placeholder="邮箱" aria-label="邮箱" value={email} onChange={event => setEmail(event.target.value)} /></label>
    <a className={`web-chat__button web-chat__button--yolk code-page__pay${ready ? "" : " is-disabled"}`} aria-disabled={!ready} role="link"
      href={ready ? accessCodePayUrl({ productId, email, origin: window.location.origin }) : undefined}>支付 9.9 元获取兑换码</a>
    <hr className="code-page__rule" />
    <form onSubmit={open}>
      <h2>输入兑换码</h2>
      <label><input autoCapitalize="characters" autoComplete="off" placeholder="兑换码" aria-label="兑换码" value={code} onChange={event => { setCode(event.target.value); setTypedError(null); }} /></label>
      {typedError ? <p className="web-chat__brief-error" role="alert">{typedError}</p> : null}
      <button type="submit" className="web-chat__button" disabled={!code.trim()}>打开</button>
    </form>
  </Card>;
}

const INPUT_TYPES = { email: "email", tel: "tel" };

/** The Brief's own fields, as the Product defines them; the code is the page's address, so it is not asked. */
function Intake({ status, code, request, onStatus }) {
  const [values, setValues] = useState({});
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const submit = async event => {
    event.preventDefault();
    const missing = missingField(status.fields, values);
    if (missing) { setError(`请填写：${missing.label}`); return; }
    setSending(true);
    setError(null);
    try { onStatus(await request(`${API}/${encodeURIComponent(code)}/intake`, { method: "POST", body: JSON.stringify(intakeAnswers(status.fields, values)) })); }
    catch (cause) { setError(cause?.message ?? "提交失败，请重试"); setSending(false); }
  };
  return <Card><form onSubmit={submit}>
    <h2>{status.product?.name}</h2>
    {status.fields.map((field, index) => <label key={field.id}>
      <span className="web-chat__brief-label">{field.label}{field.required ? <em>必填</em> : null}</span>
      {field.type === undefined || field.type === "text"
        ? <textarea autoFocus={index === 0} value={values[field.id] ?? ""} maxLength={32000} onChange={event => setValues(current => ({ ...current, [field.id]: event.target.value }))} />
        : <input type={INPUT_TYPES[field.type] ?? "text"} autoFocus={index === 0} value={values[field.id] ?? ""} maxLength={field.type === "email" ? 254 : 2000} onChange={event => setValues(current => ({ ...current, [field.id]: event.target.value }))} />}
    </label>)}
    {error ? <p className="web-chat__brief-error" role="alert">{error}</p> : null}
    <div className="web-chat__brief-actions"><button type="submit" className="web-chat__button web-chat__button--yolk" disabled={sending}>开始诊断</button></div>
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
export default function CodePage({ code, request, navigate }) {
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
  if (error && !status) return <Card><p className="web-chat__brief-error" role="alert">{error?.message ?? "暂时无法读取，请稍后再试"}</p></Card>;
  if (!status) return <Card><div className="web-chat__loading" role="status"><WebChatEgg size={34} className="web-chat-egg--bob" /></div></Card>;
  switch (status.state) {
    case "entry": return <Landing request={request} navigate={navigate} reason={status.reason} />;
    case "intake": return <Intake status={status} code={code} request={request} onStatus={next => { setStatus(next); setError(null); }} />;
    case "generating": return <Generating status={status} />;
    case "ready": return <Card><div className="code-page__done">
      <a className="web-chat__button web-chat__button--yolk code-page__report" href={status.report_url} rel="noopener">查看报告</a>
    </div></Card>;
    default: return <Card><p className="code-page__failed" role="alert">生成遇到问题，我们会尽快处理</p></Card>;
  }
}
