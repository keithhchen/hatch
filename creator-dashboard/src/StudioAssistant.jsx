import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button, InlineAlert } from "@hatch/ui";
import { friendlyError, LoadingState, mutationKey } from "./studioShellKit.jsx";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { BrowserImageAttachments } from "./webChatClient.js";
import { WebChatImageViewer } from "./components/WebChatImageViewer.jsx";

const ROOT = "/v1/creator/assistant";
const CHANNEL_NAMES = { telegram: "Telegram", line: "LINE", lark: "Lark", imessage: "iMessage" };
const REVIEW_ACTIONS = { content: ["sxaContentYes", "sxaContentNo"], change: ["sxaChangeYes", "sxaChangeNo"] };

/** One assistant per Expert: a conversation and the things that need them. */
export function StudioAssistant({ request, t }) {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState("");
  const [pendingLines, setPendingLines] = useState([]);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(null);
  const [larkForm, setLarkForm] = useState(false);
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const endRef = useRef(null);
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
      if (value.type === "delta") { setStreaming(current => current + (value.text ?? "")); return; }
      if (value.type === "message" || value.type === "assistant" || value.type === "state") { setStreaming(""); void refresh(); }
    },
  }), [refresh, t]);

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: "end" }); }, [view?.messages?.length, streaming, pendingLines.length]);

  const submit = async event => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    setPendingLines(lines => [...lines, content]);
    try { await send(`${ROOT}/messages`, { content }); }
    catch (cause) { setError(friendlyError(cause, t)); setDraft(content); setPendingLines(lines => lines.filter(line => line !== content)); }
  };
  const act = async (task, action) => {
    try { await send(`${ROOT}/tasks/${task.id}/${action}`); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };
  const attach = async event => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const upload = file.type.startsWith("image/") ? await BrowserImageAttachments.compress(file) : file;
      const bytes = new Uint8Array(await upload.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      await send(`${ROOT}/files`, { name: upload.name, base64: btoa(binary) });
      await refresh();
    } catch (cause) { setError(friendlyError(cause, t)); }
  };
  const connectChannel = async kind => {
    try {
      const value = await send(`${ROOT}/channels/${kind}/connect`);
      setConnecting({ kind, ...value });
      if (value.url) window.open(value.url, "_blank", "noopener");
    } catch (cause) { setError(friendlyError(cause, t)); }
  };
  const saveLark = async event => {
    event.preventDefault();
    try { await send(`${ROOT}/channels/lark/credentials`, Object.fromEntries(new FormData(event.currentTarget))); setLarkForm(false); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };
  const disconnectChannel = async kind => {
    try { await request(`${ROOT}/channels/${kind}`, { method: "DELETE", body: JSON.stringify({}) }); setConnecting(null); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };

  if (!view && !error) return <LoadingState t={t} />;
  const needs = (view?.tasks ?? []).filter(task => task.status === "needs_you");
  const lines = view?.messages ?? [];
  const channels = (view?.channels ?? []).filter(channel => channel.available || channel.own_app);
  return <div className="sxa">
    <section className="sxa-chat" aria-label={t("sxNavAssistant")}>
      <h1 className="sxa-title">{t("sxNavAssistant")}</h1>
      <div className="sxa-log" aria-live="polite">
        {!lines.length && !pendingLines.length && !streaming ? <p className="sxa-empty">{t("sxaEmpty")}</p> : null}
        {lines.map((line, index) => <div key={`${line.at}-${index}`} className={`sxa-line sxa-line--${line.role}`}>
          {line.images?.map(file => <WebChatImageViewer key={file} src={`${ROOT}/images/${file}`} alt="" title={t("sxaImage")} closeLabel={t("sxaImageClose")} viewLabel={t("sxaImageView")}>
            <img className="sxa-image" alt="" src={`${ROOT}/images/${file}`} />
          </WebChatImageViewer>)}
          {line.text ? <p>{line.text}</p> : null}
        </div>)}
        {pendingLines.map((line, index) => <p key={`pending-${index}`} className="sxa-line sxa-line--expert">{line}</p>)}
        {streaming ? <p className="sxa-line sxa-line--assistant">{streaming}</p> : null}
        <div ref={endRef} />
      </div>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <form className="sxa-input" onSubmit={submit}>
        <textarea ref={inputRef} value={draft} rows={2} aria-label={t("sxaInputLabel")} placeholder={t("sxaInputPlaceholder")} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) submit(event); }} />
        <input ref={fileRef} type="file" hidden accept="image/*,.txt,.md,.docx,.pptx,.xlsx,.pdf" onChange={attach} />
        <Button variant="secondary" type="button" onClick={() => fileRef.current?.click()}>{t("sxaAttach")}</Button>
        <Button className="web-btn-yolk" type="submit" disabled={!draft.trim()}>{t("sxaSend")}</Button>
      </form>
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
          {task.needs === "answer" ? <Button variant="secondary" type="button" onClick={() => inputRef.current?.focus()}>{t("sxaAnswerHere")}</Button> : null}
          {task.needs === "blocked" ? <Button variant="secondary" type="button" onClick={() => act(task, "decline")}>{t("sxaDismiss")}</Button> : null}
        </li>)}
      </ul> : <p className="sxa-empty">{t("sxaNothingNeeded")}</p>}
      {channels.length ? <div className="sxa-channels">
        <h2>{t("sxaChannels")}</h2>
        <p>{t("sxaChannelsBody")}</p>
        {channels.map(channel => <div className="sxa-channel" key={channel.kind}>
          <div className="sxa-channel__row">
            <strong>{CHANNEL_NAMES[channel.kind]}</strong>
            {channel.linked
              ? <Button variant="secondary" type="button" onClick={() => disconnectChannel(channel.kind)}>{t("sxaChannelDisconnect")}</Button>
              : channel.available
                ? <Button variant="secondary" type="button" onClick={() => connectChannel(channel.kind)}>{t("sxaChannelConnect")}</Button>
                : <Button variant="secondary" type="button" onClick={() => setLarkForm(open => !open)}>{t("sxaChannelSetup")}</Button>}
          </div>
          {channel.own_app && !channel.linked && (larkForm || channel.available) ? <div className="sxa-channel__code">
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
          {channel.linked ? <p className="sxa-channel__status">{t("sxaChannelLinked")}</p> : null}
          {!channel.linked && connecting?.kind === channel.kind ? <div className="sxa-channel__code">
            <p>{t("sxaChannelCodeHint", CHANNEL_NAMES[channel.kind])}</p>
            <code>{connecting.code}</code>
            {connecting.url ? <a href={connecting.url} target="_blank" rel="noopener noreferrer">{t("sxaChannelOpen", CHANNEL_NAMES[channel.kind])}</a> : null}
          </div> : null}
        </div>)}
      </div> : null}
    </aside>
  </div>;
}
