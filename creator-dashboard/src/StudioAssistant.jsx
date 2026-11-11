import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, InlineAlert } from "@hatch/ui";
import { ConversationController } from "@hatch/chat";
import { ChatView } from "@hatch/chat/react";
import { friendlyError, mutationKey } from "./studioShellKit.jsx";
import { UnavailableToolExecutor, browserDictation } from "./webChatClient.js";
import { ASSISTANT_CONVERSATION, SessionPendingStore, StudioAssistantTransport, StudioAttachments } from "./studioAssistantTransport.js";
import { useLocale } from "./locale.jsx";
import { webChatErrorText, webChatT } from "./webChatI18n.js";
import "./webChat.css";

const ROOT = "/v1/creator/assistant";
const CONNECTIONS = "/v1/creator/connections";
const CHANNEL_NAMES = { telegram: "Telegram", line: "LINE", lark: "Lark", feishu: "飞书", wecom: "WeCom", wechatkf: "WeChat", slack: "Slack", imessage: "iMessage" };
// Thinking and tool steps, as Product web chat shows them.
const STEP_KINDS = ["thinking", "tool"];
const REVIEW_ACTIONS = { content: ["sxaContentYes", "sxaContentNo"], change: ["sxaChangeYes", "sxaChangeNo"] };
const ATTACHABLE = "image/*,.txt,.md,.docx,.pptx,.xlsx,.pdf";

/** The Assistant's conversation on the shared chat: what the Expert sends goes out through the transport, the replies come back through it. */
function openAssistant(request, describeError) {
  const transport = new StudioAssistantTransport(request);
  const controller = new ConversationController({
    transport, attachments: new StudioAttachments(request), tools: new UnavailableToolExecutor(),
    pendingStore: new SessionPendingStore(), draftScope: "studio-assistant", describeError,
    // The page keeps listening for as long as it is open; the delay between attempts is capped.
    reconnectAttempts: Number.POSITIVE_INFINITY
  });
  controller.open(ASSISTANT_CONVERSATION);
  return { transport, controller, dictate: browserDictation(request) };
}

/** One assistant per Expert: a conversation and the things that need them. */
export function StudioAssistant({ request, t }) {
  const { locale } = useLocale();
  const chatT = useCallback((key, values) => webChatT(locale, key, values), [locale]);
  const latest = useRef({});
  latest.current = { t, locale };
  const errorText = useCallback(cause => cause?.status ? friendlyError(cause, latest.current.t) : webChatErrorText(cause, latest.current.locale), []);
  const [assistant, setAssistant] = useState(null);
  useEffect(() => {
    const opened = openAssistant(request, errorText);
    setAssistant(opened);
    return () => opened.controller.dispose();
  }, [request, errorText]);
  if (!assistant) return null;
  return <Assistant {...assistant} request={request} t={t} chatT={chatT} errorText={errorText} />;
}

function Assistant({ transport, controller, dictate, request, t, chatT, errorText }) {
  const view = useSyncExternalStore(transport.subscribe, transport.getView);
  const [error, setError] = useState("");
  const [larkForm, setLarkForm] = useState(false);
  const chatRef = useRef(null);

  const post = useCallback((path, body) => request(path, { method: "POST", headers: { "idempotency-key": mutationKey() }, body: JSON.stringify(body ?? {}) }), [request]);
  const refresh = () => controller.refresh(ASSISTANT_CONVERSATION).catch(cause => setError(friendlyError(cause, t)));
  const act = async (task, action) => {
    try { await post(`${ROOT}/tasks/${task.id}/${action}`); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };
  const saveLark = async event => {
    event.preventDefault();
    try { await post(`${CONNECTIONS}/lark/credentials`, Object.fromEntries(new FormData(event.currentTarget))); setLarkForm(false); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };
  const disconnectChannel = async kind => {
    try { await request(`${CONNECTIONS}/${kind}`, { method: "DELETE", body: JSON.stringify({}) }); await refresh(); }
    catch (cause) { setError(friendlyError(cause, t)); }
  };

  const identity = { creatorName: t("sxNavAssistant"), productName: t("sxNavAssistant") };
  const needs = (view?.tasks ?? []).filter(task => task.status === "needs_you");
  const ownApps = (view?.channels ?? []).filter(channel => channel.own_app && CHANNEL_NAMES[channel.kind] && (channel.linked || channel.available));
  const hasSide = needs.length > 0 || ownApps.length > 0;
  return <div className={`sxa${hasSide ? "" : " sxa--solo"}`}>
    <section className="sxa-chat web-chat web-chat--embedded" aria-label={t("sxNavAssistant")} ref={chatRef}>
      <h1 className="sxa-title">{t("sxNavAssistant")}</h1>
      <ChatView controller={controller} identity={identity} agentName={t("sxNavAssistant")} t={chatT} errorText={errorText}
        attachments={controller.attachments} activityKinds={STEP_KINDS} dictate={dictate} accept={ATTACHABLE} onNewConversation={() => undefined}
        empty={<p className="sxa-empty">{t("sxaEmpty")}</p>}
        dockAccessory={error ? <InlineAlert tone="error">{error}</InlineAlert> : null} />
    </section>
    {hasSide ? <aside className="sxa-side">
      {needs.length ? <ul className="sxa-needs">
        {needs.map(task => <li key={task.id} className="sxa-need">
          <span className="sxa-need__label">{t(task.needs === "review" ? "sxaNeedReview" : task.needs === "answer" ? "sxaNeedAnswer" : "sxaNeedBlocked")}</span>
          <p>{task.payload?.question ?? task.payload?.questions?.[0] ?? task.summary ?? ""}</p>
          {task.lastError ? <p className="sxa-need__error">{task.lastError}</p> : null}
          {task.needs === "review" && REVIEW_ACTIONS[task.kind] ? <div className="sxa-need__actions">
            <Button className="web-btn-yolk" type="button" onClick={() => act(task, "approve")}>{t(REVIEW_ACTIONS[task.kind][0])}</Button>
            <Button variant="secondary" type="button" onClick={() => act(task, "decline")}>{t(REVIEW_ACTIONS[task.kind][1])}</Button>
          </div> : null}
          {task.needs === "answer" ? <Button variant="secondary" type="button" onClick={() => chatRef.current?.querySelector("textarea")?.focus()}>{t("sxaAnswerHere")}</Button> : null}
          {task.needs === "blocked" ? <Button variant="secondary" type="button" onClick={() => act(task, "decline")}>{t("sxaDismiss")}</Button> : null}
        </li>)}
      </ul> : null}
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
    </aside> : null}
  </div>;
}
