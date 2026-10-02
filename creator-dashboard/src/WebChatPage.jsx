import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HatchBrand } from "@hatch/ui";
import { BrowserImageAttachments, WebChatClient } from "./webChatClient.js";
import "./webChat.css";

export default function WebChatPage({ productId, request }) {
  const [access, setAccess] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationCursor, setConversationCursor] = useState(null);
  const [conversationId, setConversationId] = useState("");
  const [messages, setMessages] = useState([]);
  const [historyCursor, setHistoryCursor] = useState(null);
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState([]);
  const [status, setStatus] = useState("正在加载…");
  const [error, setError] = useState("");
  const [activeRun, setActiveRun] = useState(null);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [briefOpen, setBriefOpen] = useState(false);
  const [briefAnswers, setBriefAnswers] = useState({});
  const socketRef = useRef(null);
  const runRef = useRef(null);
  const pendingSubmissionRef = useRef(null);
  const taskStartRef = useRef(null);
  const liveTextRef = useRef("");
  const scrollRef = useRef(null);

  const client = useMemo(() => access ? new WebChatClient(request, access.entitlement_id) : null, [access, request]);
  const refresh = useCallback(async id => {
    const snapshot = await client.snapshot(id);
    if (snapshot.conversation?.id !== id) throw new Error("聊天记录身份不匹配。");
    setMessages(snapshot.messages ?? []);
    setHistoryCursor(snapshot.before_cursor ?? null);
    const running = snapshot.runs?.find(run => ["queued", "running", "waiting_for_tool", "waiting_for_approval"].includes(run.status));
    setActiveRun(running?.id ?? null);
    setStatus(running ? "Agent 正在回复…" : "已连接");
  }, [client]);

  useEffect(() => {
    let live = true;
    setAccess(null);
    setConversationId("");
    setStatus("正在检查订阅…");
    request("/v1/user/product-access").then(async payload => {
      const entitlement = payload.creator_agents?.find(entry => entry.product_id === productId);
      if (!entitlement) throw new Error("当前账号没有这个 Agent 的有效订阅。");
      const page = await new WebChatClient(request, entitlement.entitlement_id).list();
      if (!live) return;
      setAccess(entitlement);
      setConversations(page.conversations ?? []);
      setConversationCursor(page.next_cursor ?? null);
      setConversationId(page.conversations?.[0]?.id ?? "");
      setStatus(page.conversations?.length ? "正在加载聊天记录…" : "新建聊天即可开始");
    }).catch(cause => { if (live) { setError(cause.message); setStatus("无法打开聊天"); } });
    return () => { live = false; };
  }, [productId, request]);

  useEffect(() => {
    if (!client || !conversationId) return undefined;
    let live = true;
    const connection = client.openRuntime(conversationId);
    const socket = connection.socket;
    socketRef.current = connection;
    runRef.current = null;
    liveTextRef.current = "";
    setLiveText("");
    setMessages([]);
    setSessionReady(false);
    setStatus("正在连接…");
    socket.onopen = () => connection.hello();
    socket.onmessage = async event => {
      const message = JSON.parse(event.data);
      if (message.type === "tool_call.request") { setError("Runtime 请求了此浏览器不支持的本地工具。"); connection.close(); return; }
      if (message.type === "session.ready") {
        if (message.conversation_id !== conversationId) { connection.close(); setError("聊天会话身份不匹配。"); return; }
        try {
          await refresh(conversationId);
          if (live) setSessionReady(true);
          const pending = pendingSubmissionRef.current;
          if (pending?.conversationId === conversationId) {
            try {
              const receipt = await client.receipt(conversationId, pending.runId);
              if (receipt.submission?.client_message_id === pending.clientMessageId) {
                pendingSubmissionRef.current = null;
                setDraft(""); setImages([]);
              }
            } catch (cause) { if (cause.status !== 404) throw cause; }
          }
          if (taskStartRef.current === conversationId) {
            taskStartRef.current = null;
            const runId = `run_${crypto.randomUUID().replaceAll("-", "")}`;
            runRef.current = { id: runId };
            connection.message({ runId, clientMessageId: `message_${crypto.randomUUID().replaceAll("-", "")}`, taskStart: true });
            setActiveRun(runId);
          }
        } catch (cause) { if (live) setError(cause.message); }
        return;
      }
      if (message.type === "message.accepted" && message.run_id === runRef.current?.id) {
        pendingSubmissionRef.current = null;
        setDraft(""); setImages([]);
        return;
      }
      if (message.type === "assistant.delta" && message.run_id === runRef.current?.id) {
        if (message.delta?.kind === "text") {
          liveTextRef.current += message.delta.content;
          setLiveText(liveTextRef.current);
          setStatus("Agent 正在回复…");
        } else if (message.delta?.content) setStatus(message.delta.content);
        return;
      }
      if ((message.type === "turn.completed" || message.type === "turn.failed") && message.run_id === runRef.current?.id) {
        runRef.current = null;
        liveTextRef.current = "";
        setLiveText("");
        setActiveRun(null);
        if (message.type === "turn.failed") setError(message.error?.message ?? "回复失败。");
        try { await refresh(conversationId); } catch (cause) { if (live) setError(cause.message); }
        return;
      }
      if (message.type === "session.error") setError(message.error?.message ?? "连接失败。");
    };
    socket.onclose = () => { if (live) { setSessionReady(false); setStatus("连接已断开，请重新连接。"); setError(current => current || "连接已断开，请重新连接。"); socketRef.current = null; } };
    socket.onerror = () => { if (live) setError("无法连接 Runtime。"); };
    return () => { live = false; connection.close(); if (socketRef.current === connection) socketRef.current = null; };
  }, [client, conversationId, refresh, connectionVersion]);

  useEffect(() => { scrollRef.current?.scrollIntoView({ block: "end" }); }, [messages, status, liveText]);

  useEffect(() => {
    if (!activeRun || !conversationId || runRef.current?.id === activeRun) return undefined;
    const timer = setInterval(() => { void refresh(conversationId).catch(cause => setError(cause.message)); }, 2000);
    return () => clearInterval(timer);
  }, [activeRun, conversationId, refresh]);

  const createConversation = async briefAnswersInput => {
    if (!client) return;
    setError("");
    const result = await client.create(briefAnswersInput);
    setConversations(current => [result.conversation, ...current]);
    if (briefAnswersInput) taskStartRef.current = result.conversation.id;
    setBriefOpen(false);
    setConversationId(result.conversation.id);
  };

  const newConversation = () => {
    const fields = access?.brief_spec?.fields ?? access?.product?.brief_spec?.fields;
    if (fields?.length) { setBriefAnswers({}); setBriefOpen(true); return; }
    void createConversation().catch(cause => setError(cause.message));
  };

  const submitBrief = event => {
    event.preventDefault();
    const fields = access?.brief_spec?.fields ?? access?.product?.brief_spec?.fields ?? [];
    const missing = fields.find(field => field.required && !String(briefAnswers[field.id] ?? "").trim());
    if (missing) { setError(`请填写：${missing.label}`); return; }
    void createConversation(fields.map(field => ({ field_id: field.id, value: String(briefAnswers[field.id] ?? "") }))).catch(cause => setError(cause.message));
  };

  const loadHistory = async () => {
    if (!historyCursor) return;
    const page = await client.history(conversationId, historyCursor);
    setMessages(current => [...(page.messages ?? []), ...current]);
    setHistoryCursor(page.before_cursor ?? null);
  };

  const loadConversations = async () => {
    if (!conversationCursor) return;
    const page = await client.list(conversationCursor);
    setConversations(current => [...current, ...(page.conversations ?? []).filter(entry => !current.some(existing => existing.id === entry.id))]);
    setConversationCursor(page.next_cursor ?? null);
  };

  const send = async event => {
    event.preventDefault();
    if (!conversationId || !access || !sessionReady || activeRun || (!draft.trim() && images.length === 0)) return;
    const connection = socketRef.current;
    if (!connection?.ready) { setError("连接已断开，请重新连接。"); return; }
    setError("");
    try {
      const pending = pendingSubmissionRef.current?.conversationId === conversationId ? pendingSubmissionRef.current : null;
      if (pending) {
        try {
          const receipt = await client.receipt(conversationId, pending.runId);
          if (receipt.submission?.client_message_id === pending.clientMessageId) {
            pendingSubmissionRef.current = null;
            setDraft(""); setImages([]);
            await refresh(conversationId);
            return;
          }
        } catch (cause) { if (cause.status !== 404) throw cause; }
      }
      const attachments = pending ? pending.attachments : await BrowserImageAttachments.prepareAll(images);
      const runId = pending?.runId ?? `run_${crypto.randomUUID().replaceAll("-", "")}`;
      const clientMessageId = pending?.clientMessageId ?? `message_${crypto.randomUUID().replaceAll("-", "")}`;
      const content = pending?.content ?? draft;
      runRef.current = { id: runId };
      pendingSubmissionRef.current = { conversationId, runId, clientMessageId, content, attachments };
      liveTextRef.current = "";
      setLiveText("");
      connection.message({ runId, clientMessageId, content, attachments });
      setActiveRun(runId);
      setStatus("正在发送…");
    } catch (cause) { setError(cause.message); }
  };

  const cancel = () => {
    if (!runRef.current || !socketRef.current?.ready) return;
    socketRef.current.cancel(runRef.current.id);
  };

  const name = access?.product?.name ?? access?.product_name ?? "Creator Agent";
  return <div className="web-chat">
    <aside className="web-chat__sidebar">
      <a href="/library" className="web-chat__brand"><HatchBrand /> <span>返回订阅</span></a>
      <div className="web-chat__agent"><span>CREATOR AGENT</span><h2>{name}</h2></div>
      <button type="button" className="web-chat__new" onClick={newConversation} disabled={!access}>新建聊天</button>
      <nav aria-label="聊天记录">{conversations.map(item => <button type="button" key={item.id} className={item.id === conversationId ? "is-active" : ""} onClick={() => setConversationId(item.id)}>{item.title || new Date(item.created_at).toLocaleDateString("zh-CN")}</button>)}</nav>
      {conversationCursor ? <button type="button" className="web-chat__older" onClick={() => void loadConversations().catch(cause => setError(cause.message))}>加载更多聊天</button> : null}
    </aside>
    <main className="web-chat__main">
      <header className="web-chat__header"><h1>{name}</h1><span>{status}</span></header>
      {error ? <div className="web-chat__error" role="alert">{error}<button type="button" onClick={() => { if (!access) location.reload(); else { setError(""); setConnectionVersion(value => value + 1); } }}>重试</button></div> : null}
      {briefOpen ? <form className="web-chat__brief" onSubmit={submitBrief}><h2>开始新任务</h2>{(access?.brief_spec?.fields ?? access?.product?.brief_spec?.fields ?? []).map(field => <label key={field.id}>{field.label}<textarea required={field.required} maxLength={32000} value={briefAnswers[field.id] ?? ""} onChange={event => setBriefAnswers(current => ({ ...current, [field.id]: event.target.value }))} /></label>)}<div><button type="button" onClick={() => setBriefOpen(false)}>取消</button><button type="submit">开始</button></div></form> : null}
      <div className="web-chat__messages">
        {historyCursor ? <button type="button" className="web-chat__older" onClick={() => void loadHistory().catch(cause => setError(cause.message))}>加载更早的消息</button> : null}
        {messages.length === 0 ? <div className="web-chat__empty">{conversationId ? "发送消息，开始和 Agent 聊天。" : "新建聊天，开始和 Agent 聊天。"}</div> : null}
        {messages.map((message, index) => <article className={`web-chat__message web-chat__message--${message.role}`} key={`${message.run_id}-${message.role}-${index}`}>
          <span className="web-chat__speaker">{message.role === "user" ? "你" : name}</span>
          <div className="web-chat__content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content || ""}</ReactMarkdown></div>
          {message.attachments?.length ? <div className="web-chat__attachments">{message.attachments.map(item => <span key={item.attachment_id}>{item.display_name}</span>)}</div> : null}
          {message.attachments?.filter(item => BrowserImageAttachments.accepts(item.media_type) && item.asset_id).map(item => <img key={item.attachment_id} alt={item.display_name} src={client.assetUrl(conversationId, item.asset_id)} />)}
        </article>)}
        {activeRun ? <article className="web-chat__message" role="status"><span className="web-chat__speaker">{name}</span>{liveText ? <div className="web-chat__content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{liveText}</ReactMarkdown></div> : <div className="web-chat__working">{status}</div>}</article> : null}
        <div ref={scrollRef} />
      </div>
      <form className="web-chat__composer" onSubmit={send}>
        {images.length ? <div className="web-chat__images">{images.map(file => <span key={`${file.name}-${file.lastModified}`}>{file.name}<button type="button" aria-label={`移除 ${file.name}`} onClick={() => setImages(current => current.filter(entry => entry !== file))}>×</button></span>)}</div> : null}
        <textarea value={draft} onChange={event => setDraft(event.target.value)} placeholder="给 Agent 发消息…" disabled={!conversationId} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event); } }} />
        <div className="web-chat__actions"><label>添加图片<input type="file" accept="image/*" multiple onChange={event => { const selected = [...event.target.files]; if (images.length + selected.length > 8) setError("每条消息最多添加 8 张图片。"); else setImages(current => [...current, ...selected]); event.target.value = ""; }} disabled={!conversationId || Boolean(activeRun)} /></label>{activeRun ? <button type="button" onClick={cancel}>停止</button> : <button type="submit" disabled={!sessionReady || !conversationId || (!draft.trim() && !images.length)}>发送</button>}</div>
      </form>
    </main>
  </div>;
}
