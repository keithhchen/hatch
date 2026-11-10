import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, InlineAlert } from "@hatch/ui";
import { ChatTimeline } from "@hatch/chat";
import { friendlyError, LoadingState, mutationKey } from "./studioShellKit.jsx";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { BrowserImageAttachments, base64Of, browserDictation } from "./webChatClient.js";
import { Composer, ImageViewer, TimelineEntries } from "@hatch/chat/react";
import { useLocale } from "./locale.jsx";
import { webChatErrorText, webChatT } from "./webChatI18n.js";
import "./webChat.css";
import { ChannelBindings } from "./ChannelBindings.jsx";

const ROOT = "/v1/creator/assistant";
const CONNECTIONS = "/v1/creator/connections";
const CHANNEL_NAMES = { telegram: "Telegram", line: "LINE", lark: "Lark", feishu: "飞书", wecom: "WeCom", wechatkf: "WeChat", slack: "Slack", imessage: "iMessage" };
// Thinking and tool steps, as Product web chat shows them.
const STEP_KINDS = ["thinking", "tool"];
const NO_APPROVALS = { decisions: {}, decide: null };
const REVIEW_ACTIONS = { content: ["sxaContentYes", "sxaContentNo"], change: ["sxaChangeYes", "sxaChangeNo"] };

/** A reply as Product chat draws it: words and runs of steps in the order they happened. */
function Reply({ timeline, live, t, errorText }) {
  return <article className="web-chat__message web-chat__message--assistant sxa-reply"><div className="web-chat__message-body">
    <TimelineEntries timeline={timeline} live={live} activityKinds={STEP_KINDS} t={t} errorText={errorText} loadToolDetail={undefined} approvals={NO_APPROVALS} />
  </div></article>;
}

/** One assistant per Expert: a conversation and the things that need them. */
export function StudioAssistant({ request, t }) {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState([]);
  const [live, setLive] = useState(null);
  const liveRef = useRef(new ChatTimeline());
  const { locale } = useLocale();
  const chatT = useCallback((key, values) => webChatT(locale, key, values), [locale]);
  const errorText = useCallback(cause => webChatErrorText(cause, locale), [locale]);
  const [pendingLines, setPendingLines] = useState([]);
  const [error, setError] = useState("");
  const [larkForm, setLarkForm] = useState(false);
  const dockRef = useRef(null);
  const endRef = useRef(null);
  const follow = useRef(true);
  const send = useCallback((path, body) => request(path, { method: "POST", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify(body ?? {}) }), [request]);
  const refresh = useCallback(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return request(`${ROOT}?tz=${encodeURIComponent(timezone)}`).then(value => { setView(value); setPendingLines([]); setError(""); }).catch(cause => setError(friendlyError(cause, t)));
  }, [request, t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => subscribeFactoryEvents({
    url: `${ROOT}/events`,
    onOpen: () => { void refresh(); },
    onError: () => setError(t("sxaConnectionLost")),
    onMessage: event => {
      const value = JSON.parse(event.data);
      const timeline = liveRef.current;
      const show = entries => setLive(entries.length ? entries : null);
      if (value.type === "delta") { show(timeline.appendText(value.text ?? "")); return; }
      if (value.type === "thinking" && !timeline.activeThinking.has(value.contentIndex)) { show(timeline.startThinking(value.contentIndex)); return; }
      if (value.type === "thinking_delta" && timeline.activeThinking.has(value.contentIndex)) { show(timeline.appendThinking(value.contentIndex, value.delta)); return; }
      if (value.type === "thinking_end" && timeline.activeThinking.has(value.contentIndex)) { show(timeline.finishThinking(value.contentIndex, value.content)); return; }
      if (value.type === "tool" || value.type === "tool_end") {
        show(timeline.upsertTool({ tool_call_id: value.id, name: value.name, activity_message: value.activity, status: value.type === "tool" ? "requested" : value.isError ? "failed" : "completed" }));
        return;
      }
      // The live reply gives way to the saved one only once the saved one is on the page.
      if (value.type === "message_end" || value.type === "assistant") { void refresh().then(() => show(timeline.reset())); return; }
      if (value.type === "message" || value.type === "state") void refresh();
    },
  }), [refresh, t]);

  useEffect(() => {
    const track = () => { if (endRef.current) follow.current = endRef.current.getBoundingClientRect().top - window.innerHeight < 120; };
    window.addEventListener("scroll", track, { passive: true });
    return () => window.removeEventListener("scroll", track);
  }, []);
  useEffect(() => { if (follow.current) endRef.current?.scrollIntoView?.({ block: "end" }); }, [view?.messages?.length, live, pendingLines.length]);

  const submit = async event => {
    event.preventDefault();
    const content = draft.trim();
    const staged = files;
    if (!content && !staged.length) return;
    setDraft("");
    setFiles([]);
    follow.current = true;
    if (content) setPendingLines(lines => [...lines, content]);
    try {
      for (const file of staged) await upload(file);
      if (content) await send(`${ROOT}/messages`, { content });
      else await refresh();
    } catch (cause) { setError(friendlyError(cause, t)); setDraft(content); setFiles(staged); setPendingLines(lines => lines.filter(line => line !== content)); }
  };
  const act = async (task, action) => {
    try { await send(`${ROOT}/tasks/${task.id}/${action}`); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };
  const upload = async file => {
    const ready = file.type.startsWith("image/") ? await BrowserImageAttachments.compress(file) : file;
    const bytes = new Uint8Array(await ready.arrayBuffer());
    await send(`${ROOT}/files`, { name: ready.name, base64: base64Of(bytes) });
  };
  // What the shared composer asks of its controller; files are chips until sent, and a Run cannot be stopped from here.
  const dictate = useMemo(() => browserDictation(request), [request]);
  const composer = useMemo(() => ({
    setDraft, cancel: () => undefined, fail: cause => setError(friendlyError(cause, t)),
    addImages: added => setFiles(current => [...current, ...added]),
    removeImage: file => setFiles(current => current.filter(item => item !== file)),
  }), [t]);
  const saveLark = async event => {
    event.preventDefault();
    try { await send(`${CONNECTIONS}/lark/credentials`, Object.fromEntries(new FormData(event.currentTarget))); setLarkForm(false); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };
  const disconnectChannel = async kind => {
    try { await request(`${CONNECTIONS}/${kind}`, { method: "DELETE", body: JSON.stringify({}) }); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };

  if (!view && !error) return <LoadingState t={t} />;
  const needs = (view?.tasks ?? []).filter(task => task.status === "needs_you");
  const lines = view?.messages ?? [];
  const ownApps = (view?.channels ?? []).filter(channel => channel.own_app && CHANNEL_NAMES[channel.kind] && (channel.linked || channel.available));
  return <div className="sxa">
    <section className="sxa-chat web-chat web-chat--embedded" aria-label={t("sxNavAssistant")}>
      <h1 className="sxa-title">{t("sxNavAssistant")}</h1>
      <div className="sxa-log" aria-live="polite">
        {!lines.length && !pendingLines.length && !live ? <p className="sxa-empty">{t("sxaEmpty")}</p> : null}
        {lines.map((line, index) => line.role === "assistant"
          ? <Reply key={`${line.at}-${index}`} timeline={ChatTimeline.fromHistory({ content: line.text, run_id: line.id.split(":")[0], ...line.steps })} t={chatT} errorText={errorText} />
          : <div key={`${line.at}-${index}`} className={`sxa-line sxa-line--${line.role}`}>
          {line.images?.map(file => <ImageViewer key={file} src={`${ROOT}/images/${file}`} alt="" title={t("sxaImage")} closeLabel={t("sxaImageClose")} viewLabel={t("sxaImageView")}>
            <img className="sxa-image" alt="" src={`${ROOT}/images/${file}`} />
          </ImageViewer>)}
          {line.text ? <p>{line.text}</p> : null}
        </div>)}
        {pendingLines.map((line, index) => <p key={`pending-${index}`} className="sxa-line sxa-line--expert">{line}</p>)}
        {live ? <Reply timeline={live} live t={chatT} errorText={errorText} /> : null}
        <div ref={endRef} />
      </div>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <div className="sxa-dock" ref={dockRef}><Composer controller={composer} state={{ draft, images: files, activeRun: null, messages: lines, status: live, error }} agentName={t("sxNavAssistant")} t={chatT} accept="image/*,.txt,.md,.docx,.pptx,.xlsx,.pdf" onSend={() => submit({ preventDefault() {} })} dictate={dictate} /></div>
    </section>
    <aside className="sxa-side">
      <h2>{t("sxaNeedsYou")}</h2>
      {needs.length ? <ul className="sxa-needs">
        {needs.map(task => <li key={task.id} className="sxa-need">
          <span className="sxa-need__label">{t(task.needs === "review" ? "sxaNeedReview" : task.needs === "answer" ? "sxaNeedAnswer" : "sxaNeedBlocked")}</span>
          <p>{task.payload?.question ?? task.payload?.questions?.[0] ?? task.summary ?? ""}</p>
          {task.lastError ? <p className="sxa-need__error">{task.lastError}</p> : null}
          {task.needs === "review" && REVIEW_ACTIONS[task.kind] ? <div className="sxa-need__actions">
            <Button className="web-btn-yolk" type="button" onClick={() => act(task, "approve")}>{t(REVIEW_ACTIONS[task.kind][0])}</Button>
            <Button variant="secondary" type="button" onClick={() => act(task, "decline")}>{t(REVIEW_ACTIONS[task.kind][1])}</Button>
          </div> : null}
          {task.needs === "answer" ? <Button variant="secondary" type="button" onClick={() => dockRef.current?.querySelector("textarea")?.focus()}>{t("sxaAnswerHere")}</Button> : null}
          {task.needs === "blocked" ? <Button variant="secondary" type="button" onClick={() => act(task, "decline")}>{t("sxaDismiss")}</Button> : null}
        </li>)}
      </ul> : <p className="sxa-empty">{t("sxaNothingNeeded")}</p>}
      <ChannelBindings request={request} t={t} />
      {ownApps.length ? <div className="sxa-channels">
        {ownApps.map(channel => <div className="sxa-channel" key={channel.kind}>
          <div className="sxa-channel__row">
            <strong>{CHANNEL_NAMES[channel.kind]}</strong>
            {channel.linked
              ? <Button variant="secondary" type="button" onClick={() => disconnectChannel(channel.kind)}>{t("sxaChannelDisconnect")}</Button>
              : <Button variant="secondary" type="button" onClick={() => setLarkForm(open => !open)}>{t("sxaChannelSetup")}</Button>}
          </div>
          {!channel.linked && (larkForm || channel.available) ? <div className="sxa-channel__code">
            <p>{t("sxaLarkSteps")}</p>
            <code>{channel.webhook_url}</code>
            {channel.available ? null : <form className="sxa-channel__form" onSubmit={saveLark}>
              <label>{t("sxaLarkDomain")}<select name="domain" defaultValue="lark"><option value="lark">Lark</option><option value="feishu">飞书</option></select></label>
              <label>App ID<input name="app_id" required autoComplete="off" /></label>
              <label>App Secret<input name="app_secret" type="password" required autoComplete="off" /></label>
              <label>Verification Token<input name="verification_token" type="password" required autoComplete="off" /></label>
              <label>Encrypt Key<input name="encrypt_key" type="password" autoComplete="off" /></label>
              <Button variant="secondary" type="submit">{t("sxaLarkSave")}</Button>
            </form>}
          </div> : null}
        </div>)}
      </div> : null}
    </aside>
  </div>;
}
