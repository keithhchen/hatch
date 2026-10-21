import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Accordion, AccordionDetails, AccordionSummary, Box, Button, Chip,
  Checkbox, FormControl, FormControlLabel, FormGroup, FormLabel,
  CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress,
  IconButton, List, ListItemButton, ListItemIcon, ListItemText,
  Paper, Radio, RadioGroup, Skeleton, Snackbar, Stack, TextField, Toolbar, Tooltip,
  Typography
} from "@mui/material";
import {
  ArrowForward, AutoAwesome, ChevronRight, DeleteOutlineOutlined,
  Description, Download, ExpandMore, FolderOpen, Lock,
  PlayArrow, Send, Stop, UploadFile
} from "@mui/icons-material";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { ChatComposer, ChatComposerTextArea, ChatComposerToolbar } from "@mui/x-chat";
import { ChatProvider } from "@mui/x-chat/headless";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { hatchMuiThemeOptions } from "@hatch/ui";
import { dashboardRequest } from "./data.js";
import { chatEntries, describeToolCall, groupToolEntries, toolDetailRows, toolResultRows } from "./factoryMessages.js";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { FactoryVoicePlayer } from "./factoryVoicePlayer.js";
import { createFactoryAgentTranslator } from "./factoryAgentsI18n.js";
import { agentDependencyGaps, agentStateKey, changedDependencies, localizeAgentText } from "./factoryAgentState.js";
import { creatorFactoryPath, creatorProductPath, factorySectionForAgent } from "./creatorRoutes.js";
import { STUDIO_PATH, studioNextStep, studioPathStates, studioStepForRoute } from "./studioPath.js";
import "./factoryAgents.css";

const api = (route, options = {}) => dashboardRequest(route, { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
const factoryRoot = productId => `/v1/creator/products/${encodeURIComponent(productId)}/factory-agents`;
const endpoint = (root, id, action = "") => `${root}/sessions/${id}${action ? `/${action}` : ""}`;
// A section URL without a page opens the first task of that step.
const FIRST_PAGE = { sources: "research", build: "generation", evaluate: "case-generation" };
const STEP_STATE_KEY = { done: "stepDone", running: "stepRunning", todo: "stepReady", locked: "stepLocked" };

const theme = createTheme({ ...hatchMuiThemeOptions, components: { ...hatchMuiThemeOptions.components, MuiTextField: { defaultProps: { size: "small" } } } });

function Markdown({ children, filePath = "output/chat.md", files = [], onOpenFile, t }) {
  const link = ({ href, ...props }) => {
    let local;
    if (href && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) {
      try { const relative = /^(input|output)\//.test(href) ? `/${href}` : href; const path = decodeURIComponent(new URL(relative, `https://workspace.invalid/${filePath}`).pathname.slice(1)); local = files.find(file => file.path === path)?.path; } catch { /* keep unsupported links normal */ }
    }
    return local && onOpenFile ? <a {...props} href={href} onClick={event => { event.preventDefault(); onOpenFile(local); }} /> : <a {...props} href={href} target="_blank" rel="noreferrer" />;
  };
  return <div className="factory-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: link, img: ({ alt }) => <Typography component="span" color="text.secondary">{t("imageAlt", alt || t("externalImage"))}</Typography> }}>{children || ""}</ReactMarkdown></div>;
}

function ErrorNotice({ error, onClose }) {
  return <Snackbar open={Boolean(error)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} onClose={onClose} sx={{ maxWidth: "min(420px, calc(100vw - 32px))" }}>
    <Alert severity="error" variant="filled" onClose={onClose} sx={{ width: "100%" }}>{error}</Alert>
  </Snackbar>;
}

export function FactoryAgents({ productId, section, agent, navigate, locale = "en" }) {
  const t = useMemo(() => createFactoryAgentTranslator(locale), [locale]);
  const [sessions, setSessions] = useState([]); const [agents, setAgents] = useState([]); const [manualFiles, setManualFiles] = useState([]); const [uploadItems, setUploadItems] = useState([]); const [config, setConfig] = useState(null); const [product, setProduct] = useState(null); const [error, setError] = useState(""); const importPicker = useRef(null);
  const root = useMemo(() => factoryRoot(productId), [productId]);
  const stage = section ?? null;
  const selected = agent ?? (stage ? FIRST_PAGE[stage] : null);
  const goToFactory = (nextStage, nextAgent) => navigate(creatorFactoryPath(productId, nextStage, nextAgent));
  const goToStep = step => step.id === "ship" ? navigate(creatorProductPath(productId, "publish")) : goToFactory(...step.items[0]);
  const applyNavigation = value => { setSessions(value.sessions || []); setAgents(value.agents || []); setManualFiles(value.manualFiles || []); };
  const refreshConfig = () => api(`${root}/config`).then(value => { setConfig(value); if (value.agents) setAgents(value.agents); }).catch(e => setError(e.message));
  const refreshProduct = () => api(`/v1/creator/products/${encodeURIComponent(productId)}`).then(value => setProduct(value.product ?? value)).catch(e => setError(e.message));
  useEffect(() => { refreshConfig(); refreshProduct(); return subscribeFactoryEvents({ url: `${root}/events`, onMessage: event => { const value = JSON.parse(event.data); if (value.type === "snapshot") applyNavigation(value); }, onError: () => setError(t("workspaceConnectionLost")), onOpen: () => { setError(""); refreshConfig(); refreshProduct(); } }); }, [productId, root, t]);
  const agentEntry = role => agents.find(item => item.role === role);
  const agentName = role => localizeAgentText(agentEntry(role)?.name, locale);
  const agentSession = role => sessions.filter(item => item.role === role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const openAgent = async role => { try { const targetStage = factorySectionForAgent(role); if (!targetStage) throw new Error(t("agentStateUnavailable")); const entry = agentEntry(role); if (!entry) throw new Error(t("agentStateUnavailable")); if (entry.state === "locked") { goToFactory(targetStage, role); return; } if (!agentSession(role)) await api(`${root}/sessions`, { method: "POST", body: { role } }); goToFactory(targetStage, role); } catch (e) { setError(factoryError(e, t, agentName)); } };
  const uploadProjectFiles = async files => { const accepted = /\.(txt|md|docx|pptx|xlsx|pdf)$/i; const items = files.map(file => ({ id: `${file.name}-${file.lastModified}-${Math.random()}`, file, path: `input/manual/${file.name}`, status: accepted.test(file.name) && file.size <= 20 * 1024 * 1024 ? "uploading" : "failed", error: accepted.test(file.name) ? file.size > 20 * 1024 * 1024 ? t("fileTooLarge", file.name) : "" : t("unsupportedFileType", file.name) })); setUploadItems(previous => [...items, ...previous]); let transport = agentSession("research"); try { if (!transport) transport = await api(`${root}/sessions`, { method: "POST", body: { role: "research" } }); } catch (e) { setUploadItems(previous => previous.map(item => item.status === "uploading" ? { ...item, status: "failed", error: e.message } : item)); return; } await Promise.all(items.filter(item => item.status === "uploading").map(async item => { try { const bytes = new Uint8Array(await item.file.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); const record = await api(endpoint(root, transport.id, "files"), { method: "POST", body: { path: item.path, base64: btoa(binary), mimeType: item.file.type || undefined } }); setUploadItems(previous => previous.map(current => current.id === item.id ? { ...current, path: record.path, status: "completed" } : current)); } catch (e) { setUploadItems(previous => previous.map(current => current.id === item.id ? { ...current, status: "failed", error: e.message } : current)); } })); };
  const deleteManualFile = async record => { const transport = agentSession("research"); if (!transport) return; try { await api(endpoint(root, transport.id, "files"), { method: "DELETE", body: { path: record.path } }); setManualFiles(previous => previous.filter(file => file.path !== record.path)); setUploadItems(previous => previous.filter(item => item.path !== record.path)); } catch (e) { setError(factoryError(e, t, agentName)); } };
  const states = studioPathStates(agents, product);
  const currentStep = studioStepForRoute(stage, selected);
  const step = STUDIO_PATH.find(item => item.id === currentStep);
  const selectedEntry = selected ? agentEntry(selected) : null; const selectedSession = selected ? agentSession(selected) : null;
  const workbench = Boolean(selected && selected !== "uploads" && selectedSession);
  return <ThemeProvider theme={theme}><div className={`factory-app${workbench ? " factory-app--workbench" : ""}`} aria-label={t("factory")}>
    <nav className="factory-rail" aria-label={t("factoryStepsLabel")}>
      <button type="button" className={`factory-rail__overview${step ? "" : " is-current"}`} aria-current={step ? undefined : "page"} onClick={() => goToFactory()}>{t("sxNavOverview")}</button>
      <FactoryStepper states={states} current={currentStep} onStep={goToStep} t={t} />
    </nav>
    <ErrorNotice error={error} onClose={() => setError("")} />
    {step ? <div className="factory-step">
      {step.items.length > 1 ? <nav className="factory-tasks" aria-label={t("factoryTasksLabel")}>{step.items.map(([itemSection, page]) => <button key={page} type="button" className={page === selected ? "is-active" : ""} aria-current={page === selected ? "page" : undefined} onClick={() => goToFactory(itemSection, page)}>{page === "uploads" ? t("uploadSources") : agentName(page) || t("loadingAgentState")}{page !== "uploads" && agentEntry(page) ? <span className={`factory-dot is-${agentEntry(page).state}`} aria-hidden="true" /> : null}</button>)}</nav> : null}
      {selected === "uploads" ? <SourceUploadWorkspace manualFiles={manualFiles} uploadItems={uploadItems} importPicker={importPicker} uploadProjectFiles={uploadProjectFiles} deleteManualFile={deleteManualFile} onOpenAgent={openAgent} t={t} /> : selectedSession ? <Workspace key={selectedSession.id} root={root} id={selectedSession.id} entry={selectedEntry} agents={agents} config={config} onChanged={() => undefined} onOpenAgent={openAgent} agentName={agentName} t={t} /> : <AgentIntro entry={selectedEntry} agents={agents} onOpenAgent={openAgent} agentName={agentName} locale={locale} t={t} />}
    </div> : <FactoryOverview product={product} states={states} agentEntry={agentEntry} agentName={agentName} goToStep={goToStep} t={t} />}
  </div></ThemeProvider>;
}

function FactoryStepper({ states, current, onStep, t }) {
  const next = studioNextStep(states);
  return <ol className="factory-stepper" aria-label={t("factoryStepsLabel")}>{states.map(({ step, state }) => <li key={step.id}><button type="button" className={`is-${state}${current === step.id ? " is-current" : ""}${next?.step.id === step.id ? " is-next" : ""}`} aria-current={current === step.id ? "step" : undefined} onClick={() => onStep(step)}><span className="factory-stepper__n" aria-hidden="true">{state === "done" ? "✓" : ""}</span><span className="factory-stepper__text"><span>{t(step.title)}</span><small>{t(next?.step.id === step.id && state === "todo" ? "stepNow" : STEP_STATE_KEY[state])}</small></span></button></li>)}</ol>;
}

function FactoryOverview({ product, states, agentEntry, agentName, goToStep, t }) {
  const next = studioNextStep(states);
  if (!product) return <div className="factory-overview"><Skeleton variant="rounded" height={240} sx={{ borderRadius: "20px" }} /></div>;
  return <div className="factory-overview">
    {next ? <article className="factory-next web-card">
      <div className="factory-next__body">
        <span className="factory-next__label">{t("factoryNextUp")}</span>
        <h2>{t(next.step.title)}</h2>
        <p>{t(next.step.body)}</p>
        {next.step.items.length ? <ul className="factory-next__tasks">{next.step.items.map(([, page]) => <li key={page}><span>{page === "uploads" ? t("uploadSources") : agentName(page)}</span><small>{page === "uploads" ? "" : t(agentStateKey(agentEntry(page)))}</small></li>)}</ul> : null}
        <Button className="factory-cta" variant="contained" endIcon={<ArrowForward />} onClick={() => goToStep(next.step)}>{t("stepGo")}</Button>
      </div>
    </article> : <p className="factory-all-done web-card">{t("factoryAllDone")}</p>}
  </div>;
}

function AgentIntro({ entry, agents, onOpenAgent, agentName, locale, t }) {
  if (!entry) return <div className="factory-agent-intro"><div className="factory-agent-intro__card web-card"><Skeleton width="40%" /><Skeleton width="70%" height={48} /><Skeleton width="90%" /></div></div>;
  const gaps = agentDependencyGaps(entry);
  const locked = entry.state === "locked";
  const dependencies = [...gaps.required, ...gaps.alternatives];
  return <section className="factory-agent-intro">
    <div className="factory-agent-intro__card web-card">
      <span className={`factory-state is-${entry.state}`}>{t(agentStateKey(entry))}</span>
      <h2>{agentName(entry.role)}</h2>
      <p className="factory-agent-intro__hint">{localizeAgentText(entry.hint, locale)}</p>
      <div className="factory-youdo"><strong>{t("factoryYouDo")}</strong><p>{t("factoryYouDoRole", entry.role)}</p></div>
      {locked ? <div className="factory-needs"><strong>{gaps.alternatives.length && !gaps.required.length ? t("finishOneAgentFirst", gaps.alternatives.map(agentName).join(t("roleSeparator"))) : t("factoryNeedsFirst")}</strong><div>{dependencies.map(role => <Button key={role} variant="outlined" size="small" onClick={() => onOpenAgent(role)} endIcon={<ArrowForward />}>{agentName(role)}</Button>)}</div></div>
        : <Button className="factory-cta" variant="contained" startIcon={<PlayArrow />} onClick={() => onOpenAgent(entry.role)}>{t(entry.state === "failed" ? "tryAgain" : "factoryStart")}</Button>}
    </div>
  </section>;
}

function SourceUploadWorkspace({ manualFiles, uploadItems, importPicker, uploadProjectFiles, deleteManualFile, onOpenAgent, t }) {
  const [dragging, setDragging] = useState(false);
  const pending = new Map((uploadItems || []).map(item => [item.path, item]));
  const records = [...(manualFiles || [])];
  for (const item of uploadItems || []) if (item.status !== "completed" || !records.some(record => record.path === item.path)) records.unshift({ path: item.path, uploadItem: item });
  return <section className="factory-upload-page">
    <div className="factory-upload-intro"><h2>{t("uploadSources")}</h2><p>{t("factoryYouDoRole", "uploads")}</p></div>
    <button type="button" className={`factory-dropzone${dragging ? " is-dragging" : ""}`} onClick={() => importPicker.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); uploadProjectFiles([...event.dataTransfer.files]); }}>
      <UploadFile aria-hidden="true" /><strong>{t("factoryUploadDrop")}</strong><small>{t("factoryUploadTypes")}</small>
    </button>
    <input ref={importPicker} hidden type="file" accept=".txt,.md,.docx,.pdf,.pptx,.xlsx" multiple aria-label={t("uploadInputFiles")} onChange={event => { uploadProjectFiles([...event.target.files]); event.target.value = ""; }} />
    <div className="factory-files web-card">
      <div className="factory-files__head"><strong>{t("factoryUploadedTitle")}</strong><span>{t("fileCount", manualFiles?.length || 0)}</span></div>
      {records.length ? <List dense disablePadding>{records.map(record => { const item = record.uploadItem || pending.get(record.path); const status = item?.status || "completed"; return <ListItemButton key={record.path} onClick={() => status === "completed" && onOpenAgent("research")}><ListItemIcon><Description fontSize="small" /></ListItemIcon><ListItemText primary={record.path.replace("input/manual/", "")} secondary={item?.error || t(status === "completed" ? "uploadComplete" : status === "failed" ? "uploadFailed" : "uploadProcessing")} primaryTypographyProps={{ noWrap: true }} /><Box sx={{ width: 110, ml: 2, display: "flex", justifyContent: "flex-end" }}>{status === "uploading" ? <LinearProgress sx={{ width: 90 }} /> : status === "completed" ? <IconButton size="small" aria-label={t("deleteFile")} onClick={event => { event.stopPropagation(); deleteManualFile(record); }}><DeleteOutlineOutlined fontSize="small" /></IconButton> : <Typography variant="caption" color="error.main">{t("uploadFailed")}</Typography>}</Box></ListItemButton>; })}</List> : <p className="factory-files__empty">{t("noFiles")}</p>}
    </div>
    <Button variant="outlined" endIcon={<ArrowForward />} onClick={() => onOpenAgent("research")}>{t("factoryUploadNext")}</Button>
  </section>;
}

function Workspace({ root, id, entry, agents, config, onChanged, onOpenAgent, agentName, t }) {
  const [session, setSession] = useState(null); const [error, setError] = useState(""); const [draft, setDraft] = useState(() => sessionStorage.getItem(`factory-draft:${id}`) || ""); const [stream, setStream] = useState(""); const [settled, setSettled] = useState([]); const [activity, setActivity] = useState(""); const [activityVisible, setActivityVisible] = useState(true); const [file, setFile] = useState(null); const [busy, setBusy] = useState(false); const [speaking, setSpeaking] = useState(null);
  const composer = useRef(null); const chat = useRef(null); const stick = useRef(true); const voiceHandler = useRef(() => {}); const refresh = () => api(endpoint(root, id)).then(setSession);
  useEffect(() => { let live = true; let seq = 0; const load = () => { const mine = ++seq; return api(endpoint(root, id)).then(value => { if (!live || mine !== seq) return; setSession(value); setError(""); const saved = savedReplyTexts(value); setSettled(previous => previous.filter(text => !saved.has(replyKey(text)))); }).catch(e => { if (live && mine === seq) setError(e.message); }); }; load(); const unsubscribe = subscribeFactoryEvents({ url: `${root}/sessions/${id}/events`, onMessage: event => { const value = JSON.parse(event.data); if (!value?.type) return; if (value.type.startsWith("voice.")) voiceHandler.current(value); if (value.type === "delta") { setActivityVisible(false); setStream(previous => previous + value.text); } if (value.type === "message_end") { setStream(previous => { if (previous) setSettled(list => [...list, previous]); return ""; }); setActivityVisible(false); } if (value.type === "message") load(); if (value.type === "state") load(); if (value.type === "tool") { setActivityVisible(true); setActivity(t("callingTool", t(toolActionKey(value.name)))); } if (value.type === "thinking") { setActivityVisible(true); setActivity(t("thinking")); } if (value.type === "compacting") { setActivityVisible(true); setActivity(t("compacting")); } if (value.type === "tool_end") { setActivityVisible(true); setActivity(value.isError ? t("toolErrorContinuing") : t("continuing")); } if (["files", "todos"].includes(value.type)) load(); }, onError: () => { if (live) setActivity(t("reconnecting")); }, onOpen: () => { if (live) { setActivity(""); setStream(""); setSettled([]); load(); } } }); return () => { live = false; unsubscribe(); }; }, [root, id, t]);
  useEffect(() => { sessionStorage.setItem(`factory-draft:${id}`, draft); }, [id, draft]); useEffect(() => { if (stick.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [stream, session?.messages.length]);
  const perform = async fn => { setError(""); setBusy(true); try { await fn(); await refresh(); onChanged(); } catch (e) { setError(factoryError(e, t, agentName)); } finally { setBusy(false); } };
  const composerAdapter = useMemo(() => ({
    sendMessage: async ({ message, signal }) => {
      const content = (message.parts || []).filter(part => part.type === "text").map(part => part.text).join("\n").trim();
      if (!content) return new ReadableStream({ start(controller) { controller.close(); } });
      setError(""); setActivityVisible(true); setActivity(t("thinking"));
      try {
        await api(endpoint(root, id, "message"), { method: "POST", body: { content }, signal });
        onChanged();
        return new ReadableStream({ start(controller) { controller.close(); } });
      } catch (e) {
        setError(factoryError(e, t, agentName));
        throw e;
      }
    },
    stop: () => { void perform(() => api(endpoint(root, id, "stop"), { method: "POST", body: {} })); }
  }), [root, id, t, agentName, onChanged]);
  if (!session) return <Stack className="factory-workspace-loading" spacing={1}><Skeleton width="35%" /><Skeleton width="80%" /><Skeleton width="70%" /><ErrorNotice error={error} onClose={() => setError("")} /></Stack>;
  const running = session.status === "running"; const locked = entry?.state === "locked"; const visibleSession = { ...session, files: session.files.filter(record => !record.path.startsWith("input/handoff/")) };
  const upload = files => perform(async () => { for (const f of files) { if (f.size > 20 * 1024 * 1024) throw new Error(t("fileTooLarge", f.name)); const bytes = new Uint8Array(await f.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(root, id, "files"), { method: "POST", body: { path: `input/manual/${f.name}`, base64: btoa(binary), mimeType: f.type || undefined } }); } });
  const openFile = path => setFile(path); const addToChat = (path, quote) => { const reference = `${t("fileReference", path)}${quote ? `\n\n${quote.split("\n").map(line => `> ${line}`).join("\n")}` : ""}`; setDraft(previous => `${previous}${previous.trim() ? "\n\n" : ""}${reference}\n\n`); requestAnimationFrame(() => composer.current?.focus()); }; const useLatest = () => { setActivityVisible(true); return perform(async () => { await api(endpoint(root, id, "message"), { method: "POST", body: { content: t("useLatestMessage", session.role) } }); setActivity(t("thinking")); }); };
  return <div className="factory-workspace"><div className="factory-workspace-pane factory-workspace-main"><ChatPanel session={visibleSession} entry={entry} agents={agents} root={root} id={id} config={config} busy={busy} draft={draft} setDraft={setDraft} stream={stream} settled={settled} activity={activity} activityVisible={activityVisible} composer={composer} composerAdapter={composerAdapter} chat={chat} stick={stick} running={running} locked={locked} error={error} setError={setError} perform={perform} onOpenFile={openFile} onUseLatest={useLatest} agentName={agentName} voiceHandler={voiceHandler} speaking={speaking} setSpeaking={setSpeaking} t={t} /></div><div className="factory-workspace-pane factory-workspace-side"><InspectorPanel entry={entry} agents={agents} session={visibleSession} root={root} id={id} running={running} busy={busy} file={file} setFile={setFile} upload={upload} addToChat={addToChat} agentName={agentName} onOpenAgent={onOpenAgent} t={t} perform={perform} /></div></div>;
}

function ChatPanel({ session, entry, agents, root, id, config, busy, draft, setDraft, stream, settled, activity, activityVisible, composer, composerAdapter, chat, stick, running, locked, error, setError, perform, onOpenFile, onUseLatest, agentName, voiceHandler, speaking, setSpeaking, t }) {
  const entries = groupToolEntries(chatEntries(session.messages));
  const pendingAskUser = [...entries].reverse().find(item => item.type === "askUser" && item.pending);
  const updatedDependencies = entry?.state === "update_available" ? changedDependencies(entry, agents) : [];
  const composerDisabled = locked || busy || Boolean(pendingAskUser) || !config?.services.model;
  const sendDisabled = composerDisabled || !(draft || "").trim();
  const stopResponse = () => perform(() => api(endpoint(root, id, "stop"), { method: "POST", body: {} }));
  const answerAskUser = content => composerAdapter.sendMessage({ message: { parts: [{ type: "text", text: content }] } });
  const composerSx = { border: "1px solid var(--hatch-ui-border-soft)", borderRadius: "var(--hatch-radius-dialog)", backgroundColor: "var(--hatch-ui-surface-solid)", px: 1.5, py: 1, "&:focus-within": { borderColor: "var(--hatch-ui-border-soft)", boxShadow: "none" }, "&:focus-within:not([data-disabled])": { borderColor: "var(--hatch-ui-border-soft)", boxShadow: "none" }, "& textarea:focus": { outline: "none", boxShadow: "none" } };
  return <Box className="factory-chat-panel" sx={{ height: "100%", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", bgcolor: "background.paper" }}>
    <Box className="factory-chat-scroll" ref={chat} sx={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", px: 2.5, py: 2 }} onScroll={event => { const target = event.currentTarget; stick.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80; }}>
      {!session.messages.length && <div className="factory-chat-empty"><AutoAwesome aria-hidden="true" /><h3>{agentName(session.role)}</h3><p>{t("factoryYouDoRole", session.role)}</p></div>}
      {entries.map(item => item.type === "toolGroup" ? <ToolGroup key={item.key} items={item.items} running={running && item.isCurrentTurn} t={t} /> : item.type === "tool" ? <ToolMessage key={item.key} call={item.call} result={item.result} running={running && item.isCurrentTurn} t={t} /> : item.type === "askUser" ? <AskUserBlock key={item.key} entry={item} onSubmit={answerAskUser} t={t} /> : <Message key={item.key} message={item.message} files={session.files} onOpenFile={onOpenFile} speaking={speaking} t={t} />)}
      {settled.map((text, index) => <Message key={`settled-${index}`} message={{ role: "assistant", content: text }} files={session.files} onOpenFile={onOpenFile} speaking={speaking} t={t} />)}
      {stream && <Message message={{ role: "assistant", content: stream }} files={session.files} onOpenFile={onOpenFile} speaking={speaking} t={t} />}
      {session.status === "failed" && session.error ? <div className="factory-failure" role="alert"><strong>{t("factoryFailedTitle")}</strong><p>{t("factoryFailedBody")}</p><p className="factory-failure__detail">{session.error}</p></div> : null}
      {running && activityVisible && <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}><CircularProgress size={14} /><Typography variant="caption" color="primary.main">{activity || (session.activeTool ? t("callingTool", t(toolActionKey(session.activeTool))) : t("working"))}</Typography></Stack>}
    </Box>
    <ErrorNotice error={error || (["interrupted", "failed"].includes(session.status) ? "" : session.error)} onClose={() => setError("")} />
    <Stack className="factory-composer-toolbar" direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, pb: 1 }}>
      <StartAgentButton role={session.role} draft={draft} setDraft={setDraft} composer={composer} disabled={composerDisabled || running} t={t} />
      {session.role === "voice" && <VoiceControls root={root} id={id} enabled={!locked && config?.services.voice} handler={voiceHandler} onSpeaking={setSpeaking} onError={setError} t={t} />}
      {updatedDependencies.length > 0 && <Button size="small" variant="contained" color="primary" disabled={busy} onClick={onUseLatest} sx={{ ml: "auto", maxWidth: "100%", whiteSpace: "normal", textAlign: "left" }}>{`${updatedDependencies.map(role => t("dependencyUpdated", agentName(role))).join(" · ")} · ${t("improveWithLatest")}`}</Button>}
    </Stack>
    <Box className="factory-chat-composer" sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}>
      <ChatProvider adapter={composerAdapter} composerValue={draft} onComposerValueChange={setDraft}>
        <ChatComposer disabled={composerDisabled} features={{ attachments: false }} sx={composerSx}>
          <ChatComposerTextArea ref={composer} maxRows={7} disabled={running} aria-label={t("messageLabel")} placeholder={t(locked ? "completeDependenciesToStart" : "messagePlaceholder", session.role)} />
          <ChatComposerToolbar sx={{ minHeight: 30, pt: 0.5 }}>
            {running ? <IconButton type="button" aria-label={t("stop")} onClick={stopResponse} disabled={busy} size="small" sx={{ ml: "auto", width: 36, height: 36, borderRadius: "50%", bgcolor: "error.main", color: "error.contrastText", "&:hover": { bgcolor: "error.dark" } }}><Stop fontSize="small" /></IconButton> : <IconButton type="submit" aria-label={t("send")} disabled={sendDisabled} size="small" sx={{ ml: "auto", width: 36, height: 36, borderRadius: "50%", bgcolor: "primary.main", color: "primary.contrastText", "&:hover": { bgcolor: "primary.dark" }, "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" } }}><Send fontSize="small" /></IconButton>}
          </ChatComposerToolbar>
        </ChatComposer>
      </ChatProvider>
    </Box>
  </Box>;
}

function StartAgentButton({ role, draft, setDraft, composer, disabled, t }) {
  const start = () => {
    const message = t("startAgentMessage", role);
    setDraft(current => current.trim() ? current : message);
    requestAnimationFrame(() => composer.current?.focus());
  };
  return <Button type="button" size="small" variant="outlined" startIcon={<PlayArrow />} disabled={disabled || Boolean(draft.trim())} onClick={start}>{t("startAgentLabel", role)}</Button>;
}

function InspectorPanel({ entry, agents, session, root, id, running, busy, file, setFile, upload, addToChat, agentName, onOpenAgent, t, perform }) {
  const inputFiles = session.files.filter(record => record.path.startsWith("input/") && !record.path.startsWith("input/handoff/")); const outputFiles = session.files.filter(record => record.path.startsWith("output/"));
  const selectedFile = file ? session.files.find(record => record.path === file) : null;
  return <Box component="aside" className="factory-inspector" aria-label={t("nextSteps")} sx={{ height: "100%", minWidth: 0, display: "flex", flexDirection: "column", bgcolor: "var(--hatch-ui-surface-sidebar)" }}>{entry && (entry.state !== "complete" || changedDependencies(entry, agents).length > 0) ? <div className="factory-inspector-status"><DependencyBadges entry={entry} agents={agents} agentName={agentName} t={t} /><AgentState entry={entry} agentName={agentName} t={t} /></div> : null}<Box className="factory-inspector-scroll" sx={{ overflow: "auto", flex: 1, minHeight: 0, p: 1.5 }}><Binding s={session} t={t} />{entry && <NextSteps entry={entry} agents={agents} todos={session.todos || []} onOpenAgent={onOpenAgent} agentName={agentName} t={t} />}<Paper variant="outlined" sx={{ mb: 1.5, overflow: "hidden" }}><Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: "divider", display: "flex", alignItems: "center", gap: 1 }}><FolderOpen fontSize="small" /><Typography variant="caption" fontWeight={750}>{t("files")}</Typography><Chip size="small" label={session.files.length} sx={{ ml: "auto" }} /><Button component="label" size="small" startIcon={<UploadFile />} disabled={running || busy}>{t("addFiles")}<input hidden type="file" multiple onChange={event => { upload([...event.target.files]); event.target.value = ""; }} /></Button></Box><Box sx={{ p: 1.5 }}><FileSection title={t("attachments")} records={inputFiles} onOpen={setFile} onDelete={path => perform(() => api(endpoint(root, id, "files"), { method: "DELETE", body: { path } }))} canDelete={!running} t={t} /><FileSection title={t("outputs")} records={outputFiles} onOpen={setFile} t={t} /></Box></Paper>{selectedFile && <FileViewer key={file} root={root} running={running} id={id} record={selectedFile} files={session.files} onOpenFile={setFile} onAddToChat={addToChat} onClose={() => setFile(null)} t={t} perform={perform} />}</Box></Box>;
}

function FileSection({ title, records, onOpen, onDelete, canDelete, t }) {
  return <Paper variant="outlined" sx={{ mb: 1.5, overflow: "hidden" }}><Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: "divider" }}><Typography variant="caption" fontWeight={750}>{title}</Typography></Box>{records.length ? <List dense disablePadding>{records.map(record => <ListItemButton key={record.path} onClick={() => onOpen(record.path)} sx={{ py: .65, px: 1.5 }}><ListItemIcon sx={{ minWidth: 28 }}><Description fontSize="small" color="action" /></ListItemIcon><ListItemText primary={record.path.replace(/^(input|output)\//, "")} primaryTypographyProps={{ noWrap: true, fontSize: 12 }} />{canDelete && /^(input\/manual)\//.test(record.path) && <IconButton size="small" aria-label={t("removeFile", record.path)} onClick={event => { event.stopPropagation(); onDelete(record.path); }}><DeleteOutlineOutlined fontSize="small" /></IconButton>}<ChevronRight fontSize="small" color="disabled" /></ListItemButton>)}</List> : <Typography variant="caption" color="text.secondary" sx={{ display: "block", px: 1.5, py: 2 }}>{t("noFiles")}</Typography>}</Paper>;
}

function FileViewer({ root, running, id, record, files, onOpenFile, onClose, onAddToChat, t, perform }) {
  const draftKey = `factory-file-draft:${id}:${record.path}`; const [savedDraft] = useState(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) || "null"); } catch { return null; } }); const [file, setFile] = useState(savedDraft?.file || null); const [edit, setEdit] = useState(savedDraft?.edit || ""); const [copyName, setCopyName] = useState(savedDraft?.copyName || ""); const [readError, setReadError] = useState(""); const dirty = Boolean(file && file.content !== null && edit !== file.content);
  useEffect(() => { if (!file) return; if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ file, edit, copyName })); else sessionStorage.removeItem(draftKey); }, [draftKey, file, edit, copyName, dirty]); useEffect(() => { api(`${endpoint(root, id, "files")}?path=${encodeURIComponent(record.path)}`).then(value => { setReadError(""); if (!dirty) { setFile(value); setEdit(value.content || ""); } }).catch(e => setReadError(e.message)); }, [root, id, record.path]);
  const requiresCopyName = record.readonly || record.path.startsWith("input/"); const saveDisabled = running || !dirty || (requiresCopyName && !copyName.trim());
  const save = () => perform(async () => { const target = requiresCopyName ? `output/${copyName}` : record.path; if (!target.endsWith(".md") || target.includes("..")) throw new Error(t("markdownFilenameRequired")); const bytes = new TextEncoder().encode(edit); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(root, id, "files"), { method: "POST", body: { path: target, base64: btoa(binary) } }); sessionStorage.removeItem(draftKey); setFile({ ...file, content: edit }); });
  return <Dialog open onClose={onClose} fullWidth maxWidth="md" scroll="paper" aria-labelledby={`factory-file-dialog-${id}`}><DialogTitle id={`factory-file-dialog-${id}`} sx={{ p: 0 }}><Toolbar variant="dense" sx={{ minHeight: 52 }}><Description fontSize="small" sx={{ mr: 1 }} /><Typography variant="body2" fontWeight={700} noWrap sx={{ flex: 1 }} title={record.path}>{record.path.split("/").at(-1)}</Typography><Tooltip title={t("addToChat")}><IconButton size="small" onClick={() => onAddToChat(record.path)}><Send fontSize="small" /></IconButton></Tooltip><Tooltip title={t("download")}><IconButton component="a" size="small" href={`${endpoint(root, id, "files")}?path=${encodeURIComponent(record.path)}&download=1`}><Download fontSize="small" /></IconButton></Tooltip></Toolbar></DialogTitle><DialogContent dividers sx={{ p: 0 }}>{!file ? <Box sx={{ p: 2 }}><Stack spacing={1} alignItems="center"><CircularProgress size={18} /><Typography variant="caption" color="text.secondary">{readError || t("loadingFile")}</Typography></Stack></Box> : <><Box sx={{ p: 2, maxHeight: 520, overflow: "auto" }}>{readError && <ErrorNotice error={readError} onClose={() => setReadError("")} />}{file.content === null ? <Typography variant="body2">{t("downloadToView")}</Typography> : <Stack spacing={1.5}><TextField multiline minRows={16} fullWidth value={edit} onChange={event => setEdit(event.target.value)} aria-label={t("markdownEditor")} />{requiresCopyName && <TextField label={t("revisionFilename")} placeholder={t("revisionFilenamePlaceholder")} value={copyName} onChange={event => setCopyName(event.target.value)} />}</Stack>}</Box>{file.content !== null && <Stack direction="row" spacing={1} sx={{ px: 2, pb: 2 }}><Button size="small" variant="contained" disabled={saveDisabled} onClick={save}>{t("save")}</Button><Button size="small" variant="outlined" disabled={!dirty} onClick={() => { setEdit(file.content || ""); sessionStorage.removeItem(draftKey); }}>{t("discardEdits")}</Button></Stack>}</>}</DialogContent><DialogActions><Button onClick={onClose}>{t("close")}</Button></DialogActions></Dialog>;
}

function AgentState({ entry, agentName, t, compact = false }) { if (entry?.state === "complete" || entry?.state === "update_available") return null; const gaps = agentDependencyGaps(entry); let text = t(agentStateKey(entry)); if (entry?.state === "locked" && gaps.required.length) text = t("finishAgentsFirst", gaps.required.map(agentName).join(t("roleSeparator"))); else if (entry?.state === "locked" && gaps.alternatives.length) text = t("finishOneAgentFirst", gaps.alternatives.map(agentName).join(t("roleSeparator"))); return <Chip size="small" icon={entry?.state === "locked" ? <Lock /> : undefined} label={compact ? undefined : text} color={entry?.state === "failed" ? "error" : entry?.state === "running" ? "primary" : "default"} variant={entry?.state === "running" ? "filled" : "outlined"} sx={compact ? { width: 10, height: 10, "& .MuiChip-icon": { display: "none" }, "& .MuiChip-label": { display: "none" } } : undefined} />; }
function DependencyBadges({ entry, agents, agentName, t, compact = false }) { const roles = changedDependencies(entry, agents); if (!roles.length) return null; return <Stack direction="row" spacing={.5} sx={{ flexWrap: "wrap", justifyContent: "flex-end" }}>{roles.map(role => <Chip key={role} size="small" color="warning" variant="outlined" label={compact ? agentName(role) : t("dependencyUpdated", agentName(role))} title={t("dependencyUpdated", agentName(role))} sx={compact ? { maxWidth: 76, height: 18, fontSize: 10, "& .MuiChip-label": { px: .5, overflow: "hidden", textOverflow: "ellipsis" } } : undefined} />)}</Stack>; }
function NextSteps({ entry, agents, todos, onOpenAgent, agentName, t }) {
  const gaps = agentDependencyGaps(entry);
  const locked = entry?.state === "locked";
  const dependencies = [...gaps.required, ...gaps.alternatives];
  if (!locked && !todos.length) return null;
  return <Stack spacing={1} sx={{ mb: 1.5 }}>
    {locked && <Alert severity="warning" variant="outlined" sx={{ alignItems: "flex-start", "& .MuiAlert-message": { width: "100%", minWidth: 0 } }}>
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="body2" component="p" fontWeight={700} sx={{ m: 0 }}>{t("beforeStarting")}</Typography>
          <Typography variant="caption" component="p" sx={{ mt: .35, mb: 0, lineHeight: 1.5 }}>{t("completeUpstreamWork")}</Typography>
        </Box>
        <Stack direction="row" spacing={.75} useFlexGap sx={{ flexWrap: "wrap" }}>
          {dependencies.map(role => <Button key={role} variant="outlined" size="small" onClick={() => onOpenAgent(role)} endIcon={<ArrowForward />}>{agentName(role)}</Button>)}
        </Stack>
      </Stack>
    </Alert>}
    {todos.length > 0 && <Paper variant="outlined" sx={{ p: 1.25 }}><Stack direction="row" justifyContent="space-between"><Typography variant="caption" fontWeight={750}>{t("todo")}</Typography><Typography variant="caption" color="text.secondary">{todos.filter(todo => todo.status === "completed").length}/{todos.length}</Typography></Stack><Box className="factory-todo-list" sx={{ maxHeight: 220, overflowY: "auto", pr: 0.5 }}><Stack spacing={0.75}>{todos.map((todo, index) => <Box key={`${todo.title}-${index}`} className="factory-todo-row"><Typography component="span" variant="caption" className="factory-todo-marker" aria-hidden="true">{todo.status === "completed" ? "✓" : "○"}</Typography><Typography component="span" variant="caption" className="factory-todo-title" sx={{ color: todo.status === "completed" ? "text.secondary" : "text.primary", textDecoration: todo.status === "completed" ? "line-through" : "none" }}>{todo.title}</Typography></Box>)}</Stack></Box></Paper>}
  </Stack>;
}
const toolActionKey = name => { const value = String(name || "").toLowerCase(); if (value.includes("update_todo")) return "toolActionUpdateTodo"; if (value.includes("corpus_upload")) return "toolActionCorpusUpload"; if (value.includes("evaluate")) return "toolActionEvaluate"; if (value.includes("search")) return "toolActionSearch"; if (value.includes("write")) return "toolActionWrite"; if (value.includes("read")) return "toolActionRead"; if (value.includes("list")) return "toolActionList"; return "toolActionUnknown"; };
const toolWorkKey = items => { const names = items.map(item => item.call?.name || item.result?.toolName || "").join(" ").toLowerCase(); if (names.includes("corpus_upload")) return "toolWorkPublish"; if (names.includes("list") || names.includes("read") || names.includes("search")) return "toolWorkGather"; if (names.includes("write") || names.includes("update_todo")) return "toolWorkBuild"; return "toolWorkMethod"; };
function ToolGroup({ items, running, t }) { const pending = items.some(item => !item.result); const failed = items.some(item => item.result?.isError); const status = pending ? t(running ? "toolCalling" : "toolMissing") : failed ? t("toolFailed") : ""; return <Accordion disableGutters variant="outlined" className="factory-tool-group" sx={{ mb: 1, "&:before": { display: "none" } }}><AccordionSummary expandIcon={<ExpandMore />}><Stack spacing={0.25}><Typography variant="body2" fontWeight={700}>{t(toolWorkKey(items))}</Typography><Typography variant="caption" color="text.secondary">{t("toolActionsCompleted", items.length)}{status ? ` · ${status}` : ""}</Typography></Stack></AccordionSummary><AccordionDetails sx={{ pt: 0 }}><ul className="factory-tool-list">{items.map(item => <li key={item.key}><ToolMessage call={item.call} result={item.result} running={running && item.isCurrentTurn} t={t} bare /></li>)}</ul></AccordionDetails></Accordion>; }
function toolSummary(call, result, t) { const { key, target, count } = describeToolCall(call, result); const head = t(key, target ?? ""); if (count === null || count === undefined || key === "toolSumTodo") return key === "toolSumTodo" && count ? `${head} · ${t("toolItemCount", count)}` : head; return `${head} · ${count ? t("toolFileCount", count) : t("toolNoFiles")}`; }
function ToolDetailBlock({ title, rows, t }) { return <div className="factory-tool-block"><span className="factory-tool-block__title">{title}</span>{rows.length ? <dl>{rows.map((row, index) => <div key={`${row.key}-${index}`} className={row.key ? "" : "is-plain"}>{row.key ? <dt>{t("toolKeyLabel", row.key)}</dt> : null}<dd>{row.value ?? t("toolNone")}</dd></div>)}</dl> : <p>{t("toolNone")}</p>}</div>; }
function ToolMessage({ call, result, running, t, bare = false }) { const [open, setOpen] = useState(false); const status = result?.isError ? t("toolFailed") : result ? "" : t(running ? "toolCalling" : "toolMissing"); return <div className={`factory-tool${bare ? "" : " factory-tool--single"}${result?.isError ? " is-failed" : ""}`}><div className="factory-tool__row"><span className="factory-tool__summary">{toolSummary(call, result, t)}{status ? ` · ${status}` : ""}</span><button type="button" className="factory-tool__toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{t("toolDetails")}<ExpandMore fontSize="inherit" aria-hidden="true" /></button></div>{open ? <div className="factory-tool__details">{call ? <ToolDetailBlock title={t("toolArguments")} rows={toolDetailRows(call.arguments)} t={t} /> : null}{result ? <ToolDetailBlock title={t("toolResult")} rows={toolResultRows(result)} t={t} /> : null}</div> : null}</div>; }
function askUserOption(option, index) { return { id: option?.id || `option-${index + 1}`, content: option?.content || "" }; }
function AskUserBlock({ entry, onSubmit, t }) {
  const questions = Array.isArray(entry?.call?.arguments?.questions) ? entry.call.arguments.questions : [];
  const pending = entry?.pending === true;
  const [answers, setAnswers] = useState(() => Object.fromEntries(questions.map((question, index) => [question.id || `question-${index + 1}`, { selected: question.multiSelect ? [] : "", other: "" }])));
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => { setAnswers(Object.fromEntries(questions.map((question, index) => [question.id || `question-${index + 1}`, { selected: question.multiSelect ? [] : "", other: "" }]))); setSubmitting(false); }, [entry?.call?.id]);
  if (!questions.length) return null;
  const update = (id, change) => setAnswers(previous => ({ ...previous, [id]: { ...previous[id], ...change } }));
  const complete = questions.every((question, index) => {
    if (question.required === false) return true;
    const answer = answers[question.id || `question-${index + 1}`] || {};
    return Boolean((Array.isArray(answer.selected) ? answer.selected.length : answer.selected) || answer.other?.trim());
  });
  const submit = async () => {
    if (!pending) return;
    const lines = questions.map((question, index) => {
      const id = question.id || `question-${index + 1}`; const answer = answers[id] || {}; const options = (question.options || []).map(askUserOption); const selected = (Array.isArray(answer.selected) ? answer.selected : [answer.selected]).filter(Boolean).map(value => options.find(option => option.id === value)?.content || value);
      return `${question.header || question.question}: ${[selected.join(", "), answer.other?.trim()].filter(Boolean).join("; ") || "(blank)"}`;
    });
    setSubmitting(true);
    try { await onSubmit(lines.join("\n")); } catch { setSubmitting(false); }
  };
  return <Paper className="factory-ask-user" variant="outlined" sx={{ mb: 2, p: 2, borderColor: "primary.main", bgcolor: "background.paper", opacity: pending ? 1 : 0.72 }}><Stack spacing={2}><Box><Typography variant="subtitle1" fontWeight={750}>{t("askUserTitle")}</Typography><Typography variant="body2" color="text.secondary">{t("askUserDescription")}</Typography></Box>{questions.map((question, index) => { const id = question.id || `question-${index + 1}`; const answer = answers[id] || { selected: question.multiSelect ? [] : "", other: "" }; const options = (question.options || []).map(askUserOption); return <Box key={id}><FormControl fullWidth required={question.required !== false}><FormLabel sx={{ color: "text.primary", mb: 0.75 }}>{question.question}</FormLabel>{question.multiSelect ? <FormGroup>{options.map(option => <FormControlLabel key={option.id} control={<Checkbox disabled={!pending || submitting} checked={Array.isArray(answer.selected) && answer.selected.includes(option.id)} onChange={event => update(id, { selected: event.target.checked ? [...(answer.selected || []), option.id] : (answer.selected || []).filter(value => value !== option.id) })} />} label={option.content} />)}</FormGroup> : <RadioGroup value={answer.selected || ""} onChange={event => update(id, { selected: event.target.value })}>{options.map(option => <FormControlLabel key={option.id} value={option.id} disabled={!pending || submitting} control={<Radio />} label={option.content} />)}</RadioGroup>}<TextField disabled={!pending || submitting} fullWidth size="small" multiline minRows={2} value={answer.other || ""} onChange={event => update(id, { other: event.target.value })} placeholder={t("askUserOtherPlaceholder")} sx={{ mt: 1 }} /></FormControl></Box>; })}{pending && <Button variant="contained" onClick={submit} disabled={!complete || submitting} sx={{ alignSelf: "flex-start" }}>{submitting ? t("askUserSubmitting") : t("askUserSubmit")}</Button>}</Stack></Paper>;
}
// A streamed reply and its saved message match when their text matches, ignoring whitespace between text blocks.
function replyKey(text) { return String(text || "").replace(/\s+/g, ""); }
function savedReplyTexts(session) { return new Set((session?.messages || []).filter(message => message.role === "assistant").map(message => replyKey(typeof message.content === "string" ? message.content : (message.content || []).filter(item => item.type === "text").map(item => item.text).join("")))); }

function Message({ message, files, onOpenFile, speaking, t }) { if (!message) return null; const text = typeof message.content === "string" ? message.content : message.content?.filter(item => item.type === "text").map(item => item.text).join("\n"); if (!text) return null; const user = message.role === "user"; return <Box component="article" className={`factory-message factory-message--${user ? "user" : "assistant"}`} sx={{ mb: 2.5, display: "flex", justifyContent: user ? "flex-end" : "flex-start" }}><Box className={user ? "factory-message-bubble" : "factory-message-content"}>{message.role === "assistant" ? <SpokenReply text={text} speaking={speaking} files={files} onOpenFile={onOpenFile} t={t} /> : <Markdown files={files} onOpenFile={onOpenFile} t={t}>{text}</Markdown>}</Box></Box>; }
function SpokenReply({ text, speaking, files, onOpenFile, t }) { const display = voiceText(text); const needle = voiceText(speaking?.text || ""); const index = needle ? display.indexOf(needle) : -1; if (index < 0) return <Markdown files={files} onOpenFile={onOpenFile} t={t}>{text}</Markdown>; return <Typography className="factory-markdown">{display.slice(0, index)}<mark>{display.slice(index, index + needle.length)}</mark>{display.slice(index + needle.length)}</Typography>; }
function voiceText(text) { return String(text).replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/!\[[^\]]*\]\([^)]*\)/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^\s*#{1,6}\s+/gm, "").replace(/^\s*(?:[-*+] |\d+\. )/gm, "").replace(/[*_~]/g, "").replace(/\s+/g, " ").trim(); }
function Binding({ s, t }) { return s.role === "generation" ? <Alert severity={s.corpus ? "success" : "info"} variant="outlined" sx={{ mb: 1 }}>{t(s.corpus ? "agentPublished" : "agentUnpublished")}</Alert> : null; }
function VoiceControls({ root, id, enabled, handler, onSpeaking, onError, t }) {
  const [active, setActive] = useState(false); const [partial, setPartial] = useState(""); const resources = useRef(null); const player = useRef(null);
  if (!player.current) player.current = new FactoryVoicePlayer(onSpeaking, onError);
  useEffect(() => { handler.current = event => { if (["voice.interrupt", "voice.user_speaking"].includes(event.type)) player.current.stop(); if (event.type === "voice.transcript.partial") setPartial(event.text || ""); if (event.type === "voice.transcript.final") setPartial(""); if (event.type === "voice.audio.start") player.current.start(event); if (event.type === "voice.speech.start") player.current.registerSpeech(event); if (event.type === "voice.speech.end") player.current.endSpeech(event); if (event.type === "voice.audio.chunk") player.current.chunk(event); if (event.type === "voice.audio.end") player.current.end(); if (event.type === "voice.error") onError(event.message); }; return () => { handler.current = () => {}; player.current.stop(); }; }, [handler, onError, onSpeaking]);
  const release = (current, notifyServer = false) => { current?.capture?.disconnect(); current?.source?.disconnect(); current?.silence?.disconnect(); current?.stream?.getTracks().forEach(track => track.stop()); if (notifyServer && current?.socket?.readyState === WebSocket.OPEN) current.socket.send(JSON.stringify({ type: "audio.end" })); if (current?.socket && current.socket.readyState < WebSocket.CLOSING) current.socket.close(1000, "Voice stopped"); void current?.context?.close(); };
  const stop = async () => { player.current.stop(); const current = resources.current; resources.current = null; release(current, true); setActive(false); setPartial(""); };
  const start = async () => { let pending = null; try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); pending = { stream };
    const socketUrl = new URL(endpoint(root, id, "voice/live"), window.location.href); socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(socketUrl); socket.binaryType = "arraybuffer"; pending.socket = socket;
    await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Voice connection timed out")), 20000); socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true }); socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Voice connection failed")); }, { once: true }); });
    socket.addEventListener("message", event => { if (typeof event.data !== "string") return; try { handler.current(JSON.parse(event.data)); } catch { onError("Invalid voice event"); } });
    socket.addEventListener("close", event => { if (resources.current?.socket === socket) { const current = resources.current; resources.current = null; release(current); player.current.stop(); setActive(false); setPartial(""); if (event.code !== 1000) onError(event.reason || "Voice connection closed"); } });
    const context = new AudioContext(); pending.context = context; await context.audioWorklet.addModule("/factory-voice-capture-worklet.js"); await context.resume();
    const source = context.createMediaStreamSource(stream); const capture = new AudioWorkletNode(context, "hatch-voice-capture", { outputChannelCount: [1] }); const silence = context.createGain(); silence.gain.value = 0;
    capture.port.onmessage = event => { if (event.data instanceof ArrayBuffer && socket.readyState === WebSocket.OPEN) socket.send(event.data); };
    source.connect(capture); capture.connect(silence); silence.connect(context.destination); pending = { stream, context, source, capture, silence, socket }; resources.current = pending; setActive(true);
  } catch (error) { if (resources.current === pending) resources.current = null; release(pending); setActive(false); setPartial(""); onError(error.message); } };
  useEffect(() => () => { void stop(); }, [id]);
  return <Stack className="factory-voice-controls" direction="row" spacing={1} alignItems="center"><Button size="small" variant={active ? "outlined" : "contained"} disabled={!enabled} onClick={active ? stop : start}>{t(active ? "stopVoice" : "startVoice")}</Button><Typography variant="caption" color="text.secondary">{partial || (enabled ? (active ? t("listening") : "") : t("voiceUnavailable"))}</Typography></Stack>;
}
function factoryError(error, t, agentName) { if (error?.code === "agent_dependencies_not_ready") { const required = error.details?.missingRequired || []; const alternatives = error.details?.normalCandidates || []; if (required.length) return t("finishAgentsFirst", required.map(agentName).join(t("roleSeparator"))); if (alternatives.length) return t("finishOneAgentFirst", alternatives.map(agentName).join(t("roleSeparator"))); return t("agentNeedsPreparation"); } if (error?.code === "agent_definitions_unavailable" || error?.code === "agent_definitions_invalid") return t("agentSetupUnavailable"); return error?.message || t("unknownFactoryError"); }
