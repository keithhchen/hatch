import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  CircularProgress,
  IconButton,
  Paper,
  Radio,
  RadioGroup,
  Skeleton,
  Snackbar,
  Stack,
  TextField,
  Typography
} from "@mui/material";
import {
  ArrowForward,
  AutoAwesome,
  ExpandMore,
  Lock,
  Send,
  Stop,
  UploadFile
} from "@mui/icons-material";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { ChatComposer, ChatComposerTextArea, ChatComposerToolbar } from "@mui/x-chat";
import { ChatProvider } from "@mui/x-chat/headless";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button as HatchButton, Dialog, DialogContent, IconButton as HatchIconButton, InlineAlert, SegmentedControl, Textarea, hatchMuiThemeOptions } from "@hatch/ui";
import { ArrowRight, ArrowUpRight, Play, Sparkles, ChevronLeft as PrevIcon, ChevronRight as NextIcon, Download as DownloadIcon, Plus, Send as SendIcon } from "lucide-react";
import { MicButton, RecordingActions, RecordingWave, canRecord, useVoiceInput } from "@hatch/chat/react";
import { dashboardRequest } from "./data.js";
import { FileList } from "./FileList.jsx";
import { AI_LINKS, copyImportPrompt } from "./importDialog.js";
import { createIngestPort, createJobStore, ingestFile, settleJob, tooLarge } from "./ingestPort.js";
import { neighbour, orderedPaths } from "./fileListModel.js";
import { browserDictation } from "./webChatClient.js";
import { chatEntries, describeToolCall, groupToolEntries, toolDetailRows, toolResultRows } from "./factoryMessages.js";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { createFactoryAgentTranslator } from "./factoryAgentsI18n.js";
import { BUILD_NEEDS, agentStateKey, localizeAgentText, updatedSources } from "./factoryAgentState.js";
import { creatorFactoryPath, creatorProductPath, factorySectionForAgent } from "./creatorRoutes.js";
import { ADVANCED_STEP, STUDIO_PATH, studioNextStep, studioPathStates, studioStepForRoute } from "./studioPath.js";
import "./factoryAgents.css";

const api = (route, options = {}) => dashboardRequest(route, { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
const textBase64 = text => { const bytes = new TextEncoder().encode(text); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(binary); };
const factoryRoot = productId => `/v1/creator/products/${encodeURIComponent(productId)}/factory-agents`;
const endpoint = (root, id, action = "") => `${root}/sessions/${id}${action ? `/${action}` : ""}`;
// A section URL without a page opens the first task of that step.
const FIRST_PAGE = { sources: "uploads", build: "generation", evaluate: "case-generation" };
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

export function FactoryAgents({ productId, tab = "build", section, agent, navigate, locale = "en" }) {
  const t = useMemo(() => createFactoryAgentTranslator(locale), [locale]);
  const [sessions, setSessions] = useState([]); const [agents, setAgents] = useState([]); const [manualFiles, setManualFiles] = useState([]); const [uploadItems, setUploadItems] = useState([]); const [config, setConfig] = useState(null); const [product, setProduct] = useState(null); const [error, setError] = useState(""); const importPicker = useRef(null);
  const root = useMemo(() => factoryRoot(productId), [productId]);
  const stage = section ?? null;
  const selected = agent ?? (stage ? FIRST_PAGE[stage] : null);
  const goToFactory = (nextStage, nextAgent) => navigate(creatorFactoryPath(productId, nextStage, nextAgent));
  const goToStep = step => step.id === "ship" ? navigate(creatorProductPath(productId, "publish")) : goToFactory(...step.items[0]);
  const applyNavigation = value => { setSessions(value.sessions || []); setAgents(value.agents || []); setManualFiles(value.manualFiles || []); };
  const refreshConfig = () => api(`${root}/config`).then(value => { setConfig(value); if (value.agents) setAgents(value.agents); if (value.manualFiles) setManualFiles(value.manualFiles); }).catch(e => setError(e.message));
  const refreshProduct = () => api(`/v1/creator/products/${encodeURIComponent(productId)}`).then(value => setProduct(value.product ?? value)).catch(e => setError(e.message));
  useEffect(() => { refreshConfig(); refreshProduct(); return subscribeFactoryEvents({ url: `${root}/events`, onMessage: event => { const value = JSON.parse(event.data); if (value.type === "snapshot") applyNavigation(value); }, onError: () => setError(t("workspaceConnectionLost")), onOpen: () => { setError(""); refreshConfig(); refreshProduct(); } }); }, [productId, root, t]);
  const agentEntry = role => agents.find(item => item.role === role);
  const agentName = role => localizeAgentText(agentEntry(role)?.name, locale);
  const agentSession = role => sessions.filter(item => item.role === role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const openAgent = async role => { try { if (role === "uploads") { goToFactory("sources", "uploads"); return; } const targetStage = factorySectionForAgent(role); if (!targetStage) throw new Error(t("agentStateUnavailable")); const entry = agentEntry(role); if (!entry) throw new Error(t("agentStateUnavailable")); if (entry.state === "locked") { goToFactory(targetStage, role); return; } if (!agentSession(role)) await api(`${root}/sessions`, { method: "POST", body: { role } }); goToFactory(targetStage, role); } catch (e) { setError(factoryError(e, t, agentName)); } };
  const ingest = useMemo(() => createIngestPort(dashboardRequest), []);
  const patchUpload = (id, change) => setUploadItems(previous => previous.map(item => item.id === id ? { ...item, ...change } : item));
  const jobs = useMemo(() => createJobStore(productId), [productId]);
  const rowState = (id, jobId) => state => {
    if (state.status !== "ingesting" && jobId()) jobs.remove(jobId());
    if (state.status !== "completed") { patchUpload(id, state); return; }
    setUploadItems(previous => previous.filter(item => item.id !== id)); refreshConfig();
  };
  const uploadProjectFiles = files => Promise.all(files.map(file => {
    const id = `${file.name}-${file.lastModified}-${Math.random()}`; let jobId = "";
    if (tooLarge(file)) { setUploadItems(previous => [{ id, path: `input/manual/${file.name}`, status: "unsupported" }, ...previous]); return; }
    setUploadItems(previous => [{ id, path: `input/manual/${file.name}`, status: "uploading" }, ...previous]);
    return ingestFile(ingest, productId, file, rowState(id, () => jobId), { onJob: job => { jobId = job.id; jobs.add(job.id, file.name); } });
  }));
  useEffect(() => { jobs.list().forEach(({ jobId, name }) => {
    const id = `resume-${jobId}`;
    setUploadItems(previous => [{ id, path: `input/manual/${name}`, status: "ingesting" }, ...previous]);
    ingest.get(productId, jobId).then(job => settleJob(ingest, productId, job, rowState(id, () => jobId))).catch(error => { jobs.remove(jobId); patchUpload(id, { status: "failed", error: error.message }); });
  }); }, [jobs]);
  const researchTransport = async () => agentSession("research") ?? await api(`${root}/sessions`, { method: "POST", body: { role: "research" } });
  const [preview, setPreview] = useState(null);
  const previewFile = async path => { try { setPreview({ id: (await researchTransport()).id, path }); } catch (e) { setError(factoryError(e, t, agentName)); } };
  const saveManualText = async text => { const transport = await researchTransport(); await api(endpoint(root, transport.id, "files"), { method: "POST", body: { path: `input/manual/imported-from-ai-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.md`, base64: textBase64(text) } }); await refreshConfig(); };
  const dismissUpload = id => setUploadItems(previous => previous.filter(item => item.id !== id));
  const deleteManualFile = async record => { const transport = agentSession("research"); if (!transport) return; try { await api(endpoint(root, transport.id, "files"), { method: "DELETE", body: { path: record.path } }); setManualFiles(previous => previous.filter(file => file.path !== record.path)); setUploadItems(previous => previous.filter(item => item.path !== record.path)); } catch (e) { setError(factoryError(e, t, agentName)); } };
  const states = studioPathStates(agents, product, manualFiles);
  const currentStep = studioStepForRoute(stage, selected);
  const step = tab === "overview" ? null : [...STUDIO_PATH, ADVANCED_STEP].find(item => item.id === currentStep);
  const selectedEntry = selected ? agentEntry(selected) : null; const selectedSession = selected ? agentSession(selected) : null;
  const workbench = Boolean(selected && selected !== "uploads" && selectedSession);
  return <ThemeProvider theme={theme}><div className={`factory-app${workbench ? " factory-app--workbench" : ""}`} aria-label={t("factory")}>
    {tab === "overview" ? null : <nav className="factory-rail" aria-label={t("factoryStepsLabel")}>
      <FactoryStepper states={states} current={currentStep} onStep={goToStep} t={t} />
      <button type="button" className={`factory-advanced${currentStep === ADVANCED_STEP.id ? " is-current" : ""}`} aria-current={currentStep === ADVANCED_STEP.id ? "page" : undefined} onClick={() => goToStep(ADVANCED_STEP)}>{t(ADVANCED_STEP.title)}</button>
    </nav>}
    <ErrorNotice error={error} onClose={() => setError("")} />
    {selected === "uploads" && preview && manualFiles.some(file => file.path === preview.path) ? <FileViewer key={preview.path} root={root} running={false} id={preview.id} record={manualFiles.find(file => file.path === preview.path)} siblings={manualFiles} onOpenFile={path => setPreview({ ...preview, path })} onClose={() => setPreview(null)} t={t} perform={async fn => { try { await fn(); refreshConfig(); } catch (e) { setError(factoryError(e, t, agentName)); } }} /> : null}
    {step ? <div className="factory-step">
      {step.items.length > 1 ? <nav className="factory-tasks" aria-label={t("factoryTasksLabel")}>{step.items.map(([itemSection, page]) => <button key={page} type="button" className={page === selected ? "is-active" : ""} aria-current={page === selected ? "page" : undefined} onClick={() => goToFactory(itemSection, page)}>{page === "uploads" ? t("uploadSources") : agentName(page) || t("loadingAgentState")}{page !== "uploads" && agentEntry(page) ? <span className={`factory-dot is-${agentEntry(page).state}`} aria-hidden="true" /> : null}</button>)}</nav> : null}
      {selected === "uploads" ? <SourceUploadWorkspace manualFiles={manualFiles} uploadItems={uploadItems} importPicker={importPicker} uploadProjectFiles={uploadProjectFiles} saveManualText={saveManualText} locale={locale} onOpenFile={previewFile} deleteManualFile={deleteManualFile} dismissUpload={dismissUpload} onOpenAgent={openAgent} t={t} /> : selectedSession ? <Workspace key={selectedSession.id} root={root} id={selectedSession.id} entry={selectedEntry} agents={agents} config={config} onChanged={() => undefined} onOpenAgent={openAgent} agentName={agentName} t={t} /> : <AgentIntro entry={selectedEntry} agents={agents} onOpenAgent={openAgent} agentName={agentName} locale={locale} t={t} />}
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
  const locked = entry.state === "locked";
  return <section className="factory-agent-intro">
    <div className="factory-agent-intro__card web-card">
      <span className={`factory-state is-${entry.state}`}>{t(agentStateKey(entry))}</span>
      <h2>{agentName(entry.role)}</h2>
      <p className="factory-agent-intro__hint">{localizeAgentText(entry.hint, locale)}</p>
      <div className="factory-youdo"><strong>{t("factoryYouDo")}</strong><p>{t("factoryYouDoRole", entry.role)}</p></div>
      {locked ? <div className="factory-needs"><strong>{t("finishOneAgentFirst", BUILD_NEEDS.map(need => need === "uploads" ? t("uploadSources") : agentName(need)).join(t("roleSeparator")))}</strong><div>{BUILD_NEEDS.map(need => <Button key={need} variant="outlined" size="small" onClick={() => onOpenAgent(need)} endIcon={<ArrowForward />}>{need === "uploads" ? t("uploadSources") : agentName(need)}</Button>)}</div></div>
        : <Button className="factory-cta" variant="contained" startIcon={<Play size={18} strokeLinejoin="round" aria-hidden="true" />} onClick={() => onOpenAgent(entry.role)}>{t(entry.state === "failed" ? "tryAgain" : "factoryStart")}</Button>}
    </div>
  </section>;
}

const uploadStatusLabel = t => record => t({ uploading: "uploadProcessing", ingesting: "ingesting", failed: "uploadFailed", partial: "ingestPartial", unsupported: "fileTooLarge" }[record.status]);

function SourceUploadWorkspace({ onOpenFile, manualFiles, uploadItems, importPicker, uploadProjectFiles, saveManualText, locale, deleteManualFile, dismissUpload, onOpenAgent, t }) {
  const [dragging, setDragging] = useState(false);
  const records = [...(uploadItems || []), ...(manualFiles || [])];
  const statusLabel = uploadStatusLabel(t);
  return <section className="factory-upload-page">
    <div className="factory-upload-intro"><h2>{t("uploadSources")}</h2><p>{t("factoryYouDoRole", "uploads")}</p></div>
    <button type="button" className={`factory-dropzone${dragging ? " is-dragging" : ""}`} onClick={() => importPicker.current?.click()} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); uploadProjectFiles([...event.dataTransfer.files]); }}>
      <UploadFile aria-hidden="true" /><strong>{t("factoryUploadDrop")}</strong>
    </button>
    <input ref={importPicker} hidden type="file" multiple aria-label={t("uploadInputFiles")} onChange={event => { uploadProjectFiles([...event.target.files]); event.target.value = ""; }} />
    <ImportFromAi saveManualText={saveManualText} locale={locale} t={t} />
    <FileList title={t("factoryUploadedTitle")} records={records} onOpen={onOpenFile} onDelete={record => record.id ? dismissUpload(record.id) : deleteManualFile(record)} statusLabel={statusLabel} t={t} />
    <HatchButton variant="secondary" trailing={<ArrowRight aria-hidden="true" />} onClick={() => onOpenAgent("voice")}>{t("factoryUploadNext")}</HatchButton>
  </section>;
}

function ImportFromAi({ saveManualText, locale, t }) {
  const [open, setOpen] = useState(false); const [copy, setCopy] = useState("idle"); const [text, setText] = useState(""); const [saving, setSaving] = useState(false); const [error, setError] = useState("");
  const copyPrompt = async () => { const result = await copyImportPrompt(locale); setCopy(result); if (result === "copied") setTimeout(() => setCopy("idle"), 2000); };
  const save = async () => { setSaving(true); setError(""); try { await saveManualText(text); setText(""); setOpen(false); } catch (e) { setError(e.message); } finally { setSaving(false); } };
  return <>
    <HatchButton variant="secondary" className="factory-import__open" leading={<Sparkles aria-hidden="true" />} onClick={() => setOpen(true)}>{t("importFromAi")}</HatchButton>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent title={t("importFromAi")} className="factory-import" aria-describedby={undefined}>
      <p>{t("importIntro")}</p>
      <HatchButton variant="secondary" size="small" onClick={copyPrompt}>{t({ idle: "importCopy", copied: "importCopied", failed: "importCopyFailed" }[copy])}</HatchButton>
      <div className="factory-import__links">{AI_LINKS.map(link => <a key={link.name} href={link.href} target="_blank" rel="noopener noreferrer">{link.name}<ArrowUpRight aria-hidden="true" /></a>)}</div>
      <p className="factory-import__agents">{t("importOrAgent")}</p>
      <hr className="factory-import__rule" />
      <label className="factory-import__paste" htmlFor="factory-import-paste">{t("importPasteLabel")}</label>
      <Textarea id="factory-import-paste" value={text} onChange={event => setText(event.target.value)} />
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      <HatchButton size="small" loading={saving} disabled={!text.trim() || saving} onClick={save}>{t("importSave")}</HatchButton>
    </DialogContent></Dialog>
  </>;
}

function Workspace({ root, id, entry, agents, config, onChanged, onOpenAgent, agentName, t }) {
  const [session, setSession] = useState(null); const [error, setError] = useState(""); const [draft, setDraft] = useState(() => sessionStorage.getItem(`factory-draft:${id}`) || ""); const [stream, setStream] = useState(""); const [settled, setSettled] = useState([]); const [activity, setActivity] = useState(""); const [activityVisible, setActivityVisible] = useState(true); const [file, setFile] = useState(null); const [busy, setBusy] = useState(false);
  const composer = useRef(null); const chat = useRef(null); const stick = useRef(true); const refresh = () => api(endpoint(root, id)).then(setSession);
  useEffect(() => { let live = true; let seq = 0; const load = () => { const mine = ++seq; return api(endpoint(root, id)).then(value => { if (!live || mine !== seq) return; setSession(value); setError(""); const saved = savedReplyTexts(value); setSettled(previous => previous.filter(text => !saved.has(replyKey(text)))); }).catch(e => { if (live && mine === seq) setError(e.message); }); }; load(); const unsubscribe = subscribeFactoryEvents({ url: `${root}/sessions/${id}/events`, onMessage: event => { const value = JSON.parse(event.data); if (!value?.type) return; if (value.type === "delta") { setActivityVisible(false); setStream(previous => previous + value.text); } if (value.type === "message_end") { setStream(previous => { if (previous) setSettled(list => [...list, previous]); return ""; }); setActivityVisible(false); } if (value.type === "message") load(); if (value.type === "state") load(); if (value.type === "tool") { setActivityVisible(true); setActivity(t("callingTool", t(toolActionKey(value.name)))); } if (value.type === "thinking") { setActivityVisible(true); setActivity(t("thinking")); } if (value.type === "compacting") { setActivityVisible(true); setActivity(t("compacting")); } if (value.type === "tool_end") { setActivityVisible(true); setActivity(value.isError ? t("toolErrorContinuing") : t("continuing")); } if (["files", "todos"].includes(value.type)) load(); }, onError: () => { if (live) setActivity(t("reconnecting")); }, onOpen: () => { if (live) { setActivity(""); setStream(""); setSettled([]); load(); } } }); return () => { live = false; unsubscribe(); }; }, [root, id, t]);
  useEffect(() => { sessionStorage.setItem(`factory-draft:${id}`, draft); }, [id, draft]); useEffect(() => { if (stick.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [stream, session?.messages.length]);
  const perform = async fn => { setError(""); setBusy(true); try { await fn(); await refresh(); onChanged(); } catch (e) { setError(factoryError(e, t, agentName)); } finally { setBusy(false); } };
  const dictation = useMemo(() => browserDictation(dashboardRequest), []);
  // One key per message the user sends: the composer's retry of the same message sends the same key.
  const sendKeys = useRef(new Map()); const sendKey = messageId => { if (messageId === undefined) return crypto.randomUUID(); if (!sendKeys.current.has(messageId)) sendKeys.current.set(messageId, crypto.randomUUID()); return sendKeys.current.get(messageId); };
  const composerAdapter = useMemo(() => ({
    sendMessage: async ({ message, signal }) => {
      const content = (message.parts || []).filter(part => part.type === "text").map(part => part.text).join("\n").trim();
      if (!content) return new ReadableStream({ start(controller) { controller.close(); } });
      setError(""); setActivityVisible(true); setActivity(t("thinking"));
      try {
        await api(endpoint(root, id, "message"), { method: "POST", headers: { "Idempotency-Key": sendKey(message.id) }, body: { content }, signal });
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
  const openFile = path => setFile(path); const addToChat = (path, quote) => { const reference = `${t("fileReference", path)}${quote ? `\n\n${quote.split("\n").map(line => `> ${line}`).join("\n")}` : ""}`; setDraft(previous => `${previous}${previous.trim() ? "\n\n" : ""}${reference}\n\n`); requestAnimationFrame(() => composer.current?.focus()); }; const useLatest = () => { setActivityVisible(true); return perform(async () => { await api(endpoint(root, id, "message"), { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: { content: t("useLatestMessage", session.role) } }); setActivity(t("thinking")); }); };
  return <div className="factory-workspace"><div className="factory-workspace-pane factory-workspace-main"><ChatPanel dictation={dictation} session={visibleSession} entry={entry} agents={agents} root={root} id={id} config={config} busy={busy} draft={draft} setDraft={setDraft} stream={stream} settled={settled} activity={activity} activityVisible={activityVisible} composer={composer} composerAdapter={composerAdapter} chat={chat} stick={stick} running={running} locked={locked} error={error} setError={setError} perform={perform} onOpenFile={openFile} onUseLatest={useLatest} agentName={agentName} t={t} /></div><div className="factory-workspace-pane factory-workspace-side"><InspectorPanel entry={entry} agents={agents} session={visibleSession} root={root} id={id} running={running} busy={busy} file={file} setFile={setFile} addToChat={addToChat} agentName={agentName} onOpenAgent={onOpenAgent} t={t} perform={perform} /></div></div>;
}

function ChatPanel({ dictation, session, entry, agents, root, id, config, busy, draft, setDraft, stream, settled, activity, activityVisible, composer, composerAdapter, chat, stick, running, locked, error, setError, perform, onOpenFile, onUseLatest, agentName, t }) {
  const entries = groupToolEntries(chatEntries(session.messages));
  const pendingAskUser = [...entries].reverse().find(item => item.type === "askUser" && item.pending);
  const updatedDependencies = updatedSources(entry);
  const composerDisabled = locked || busy || Boolean(pendingAskUser) || !config?.services.model;
  const sendDisabled = composerDisabled || !(draft || "").trim();
  const stopResponse = () => perform(() => api(endpoint(root, id, "stop"), { method: "POST", body: {} }));
  const answerAskUser = content => composerAdapter.sendMessage({ message: { parts: [{ type: "text", text: content }] } });
  // Dictation only fills the box, like the Assistant's: the Expert edits the text and decides whether to send.
  const voice = useVoiceInput({ dictate: dictation, onText: text => { if (text) { setDraft(previous => previous.trim() ? `${previous.trimEnd()} ${text}` : text); composer.current?.focus(); } }, onError: dictationError => setError(dictationError?.message || String(dictationError)) });
  const recording = voice.phase === "recording";
  const composerSx = { border: "1px solid var(--hatch-ui-border-soft)", borderRadius: "var(--hatch-radius-dialog)", backgroundColor: "var(--hatch-ui-surface-solid)", px: 1.5, py: 1, "&:focus-within": { borderColor: "var(--hatch-ui-border-soft)", boxShadow: "none" }, "&:focus-within:not([data-disabled])": { borderColor: "var(--hatch-ui-border-soft)", boxShadow: "none" }, "& textarea:focus": { outline: "none", boxShadow: "none" } };
  return <Box className="factory-chat-panel" sx={{ minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", bgcolor: "background.paper" }}>
    <Box className="factory-chat-scroll" ref={chat} sx={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", px: 2.5, py: 2 }} onScroll={event => { const target = event.currentTarget; stick.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80; }}>
      {!session.messages.length && <div className="factory-chat-empty"><AutoAwesome aria-hidden="true" /><h3>{agentName(session.role)}</h3><p>{t("factoryYouDoRole", session.role)}</p></div>}
      {entries.map(item => item.type === "toolGroup" ? <ToolGroup key={item.key} items={item.items} running={running && item.isCurrentTurn} t={t} /> : item.type === "tool" ? <ToolMessage key={item.key} call={item.call} result={item.result} running={running && item.isCurrentTurn} t={t} /> : item.type === "askUser" ? <AskUserBlock key={item.key} entry={item} onSubmit={answerAskUser} t={t} /> : <Message key={item.key} message={item.message} files={session.files} onOpenFile={onOpenFile} t={t} />)}
      {settled.map((text, index) => <Message key={`settled-${index}`} message={{ role: "assistant", content: text }} files={session.files} onOpenFile={onOpenFile} t={t} />)}
      {stream && <Message message={{ role: "assistant", content: stream }} files={session.files} onOpenFile={onOpenFile} t={t} />}
      {session.status === "failed" && session.error ? <div className="factory-failure" role="alert"><strong>{t("factoryFailedTitle")}</strong><p>{t("factoryFailedBody")}</p><p className="factory-failure__detail">{session.errorCode === "usage_cap_exceeded" ? t("usageCapReached") : session.error}</p></div> : null}
      {running && activityVisible && <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}><CircularProgress size={14} /><Typography variant="caption" color="primary.main">{activity || (session.activeTool ? t("callingTool", t(toolActionKey(session.activeTool))) : t("working"))}</Typography></Stack>}
    </Box>
    <ErrorNotice error={error || (["interrupted", "failed"].includes(session.status) ? "" : session.error)} onClose={() => setError("")} />
    <Stack className="factory-composer-toolbar" direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, pb: 1 }}>
      <StartAgentButton role={session.role} draft={draft} setDraft={setDraft} composer={composer} disabled={composerDisabled || running} t={t} />
      {updatedDependencies.length > 0 && <Button size="small" variant="contained" color="primary" disabled={busy} onClick={onUseLatest} sx={{ ml: "auto", maxWidth: "100%", whiteSpace: "normal", textAlign: "left" }}>{`${updatedDependencies.map(role => t("dependencyUpdated", agentName(role))).join(" · ")} · ${t("improveWithLatest")}`}</Button>}
    </Stack>
    <Box className="factory-chat-composer" sx={{ p: 1.5, borderTop: 1, borderColor: "divider" }}>
      <ChatProvider adapter={composerAdapter} composerValue={draft} onComposerValueChange={setDraft}>
        <ChatComposer disabled={composerDisabled} features={{ attachments: false }} sx={composerSx}>
          {recording ? <RecordingWave voice={voice} /> : <ChatComposerTextArea ref={composer} maxRows={7} disabled={running} aria-label={t("messageLabel")} placeholder={t(locked ? "completeDependenciesToStart" : "messagePlaceholder", session.role)} />}
          <ChatComposerToolbar sx={{ minHeight: 30, pt: 0.5 }}>
            {recording ? <RecordingActions voice={voice} t={t} /> : <>
            {canRecord() ? <Box sx={{ ml: "auto" }}><MicButton voice={voice} t={t} disabled={composerDisabled || running} /></Box> : null}
            {running ? <IconButton type="button" aria-label={t("stop")} onClick={stopResponse} disabled={busy} size="small" sx={{ ml: canRecord() ? 0 : "auto", width: 36, height: 36, borderRadius: "50%", bgcolor: "error.main", color: "error.contrastText", "&:hover": { bgcolor: "error.dark" } }}><Stop fontSize="small" /></IconButton> : <IconButton type="submit" aria-label={t("send")} disabled={sendDisabled} size="small" sx={{ ml: canRecord() ? 0 : "auto", width: 36, height: 36, borderRadius: "50%", bgcolor: "primary.main", color: "primary.contrastText", "&:hover": { bgcolor: "primary.dark" }, "&.Mui-disabled": { bgcolor: "action.disabledBackground", color: "action.disabled" } }}><Send fontSize="small" /></IconButton>}
            </>}
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
  return <HatchButton type="button" size="small" variant="secondary" leading={<Play aria-hidden="true" />} disabled={disabled || Boolean(draft.trim())} onClick={start}>{t("startAgentLabel", role)}</HatchButton>;
}

const FILE_PAGE_SIZE = 8;
function InspectorPanel({ entry, agents, session, root, id, running, busy, file, setFile, addToChat, agentName, onOpenAgent, t, perform }) {
  const inputFiles = session.files.filter(record => record.path.startsWith("input/") && !record.path.startsWith("input/handoff/")); const outputFiles = session.files.filter(record => record.path.startsWith("output/"));
  const selectedFile = file ? session.files.find(record => record.path === file) : null;
  const [filesTab, setFilesTab] = useState("input");
  return <Box component="aside" className="factory-inspector" aria-label={t("nextSteps")} sx={{ height: "100%", minWidth: 0, display: "flex", flexDirection: "column", bgcolor: "var(--hatch-ui-surface-sidebar)" }}>{entry && entry.state !== "complete" ? <div className="factory-inspector-status"><AgentState entry={entry} agentName={agentName} t={t} /></div> : null}<Box className="factory-inspector-scroll" sx={{ overflow: "auto", flex: 1, minHeight: 0, p: 1.5 }}>{entry && <NextSteps entry={entry} agents={agents} onOpenAgent={onOpenAgent} agentName={agentName} t={t} />}<div className="fl-panel"><div className="fl-panel__head"><div className="fl-tabs" role="tablist" aria-label={t("files")}>{[["input", "attachments"], ["output", "outputs"]].map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={filesTab === key} className={filesTab === key ? "is-active" : ""} onClick={() => setFilesTab(key)}>{t(label)}</button>)}</div>{filesTab === "input" ? <HatchButton size="small" variant="secondary" onClick={() => onOpenAgent("uploads")}>{t("addFiles")}</HatchButton> : null}</div>{filesTab === "input" ? <FileList key="input" records={inputFiles} pageSize={FILE_PAGE_SIZE} onOpen={setFile} onDelete={record => perform(() => api(endpoint(root, id, "files"), { method: "DELETE", body: { path: record.path } }))} deletable={record => !running && /^input\/manual\//.test(record.path)} t={t} /> : <FileList key="output" records={outputFiles} pageSize={FILE_PAGE_SIZE} onOpen={setFile} t={t} />}</div>{selectedFile && <FileViewer key={file} root={root} running={running} id={id} record={selectedFile} siblings={selectedFile.path.startsWith("output/") ? outputFiles : inputFiles} onOpenFile={setFile} onAddToChat={addToChat} onClose={() => setFile(null)} t={t} perform={perform} />}</Box></Box>;
}

function FileViewer({ root, running, id, record, siblings, onOpenFile, onClose, onAddToChat, t, perform }) {
  const draftKey = `factory-file-draft:${id}:${record.path}`; const [savedDraft] = useState(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) || "null"); } catch { return null; } }); const [file, setFile] = useState(savedDraft?.file || null); const [edit, setEdit] = useState(savedDraft?.edit || ""); const [copyName, setCopyName] = useState(savedDraft?.copyName || ""); const [readError, setReadError] = useState(""); const [mode, setMode] = useState(/\.(md|markdown)$/i.test(record.path) ? "rendered" : "raw"); const dirty = Boolean(file && file.content !== null && edit !== file.content);
  useEffect(() => { if (!file) return; if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ file, edit, copyName })); else sessionStorage.removeItem(draftKey); }, [draftKey, file, edit, copyName, dirty]); useEffect(() => { api(`${endpoint(root, id, "files")}?path=${encodeURIComponent(record.path)}`).then(value => { setReadError(""); if (!dirty) { setFile(value); setEdit(value.content || ""); } }).catch(e => setReadError(e.message)); }, [root, id, record.path]);
  const requiresCopyName = record.readonly || record.path.startsWith("input/"); const saveDisabled = running || !dirty || (requiresCopyName && !copyName.trim());
  const save = () => perform(async () => { const target = requiresCopyName ? `output/${copyName}` : record.path; if (!target.endsWith(".md") || target.includes("..")) throw new Error(t("markdownFilenameRequired")); await api(endpoint(root, id, "files"), { method: "POST", body: { path: target, base64: textBase64(edit) } }); sessionStorage.removeItem(draftKey); setFile({ ...file, content: edit }); });
  const paths = orderedPaths(siblings); const previous = neighbour(paths, record.path, -1); const next = neighbour(paths, record.path, 1); const name = record.path.split("/").at(-1); const fileUrl = `${endpoint(root, id, "files")}?path=${encodeURIComponent(record.path)}`;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent title={<span title={record.path}>{name}</span>} className="fv-dialog" aria-describedby={undefined} footer={file && file.content !== null ? <><HatchButton size="small" disabled={saveDisabled} onClick={save}>{t("save")}</HatchButton><HatchButton size="small" variant="secondary" disabled={!dirty} onClick={() => { setEdit(file.content || ""); sessionStorage.removeItem(draftKey); }}>{t("discardEdits")}</HatchButton></> : undefined}>
    <div className="fv">
      <div className="fv__bar">
        <HatchIconButton label={t("previousFile")} size="small" disabled={!previous} onClick={() => onOpenFile(previous)}><PrevIcon aria-hidden="true" /></HatchIconButton>
        <span className="fv__pos">{paths.indexOf(record.path) + 1} / {paths.length}</span>
        <HatchIconButton label={t("nextFile")} size="small" disabled={!next} onClick={() => onOpenFile(next)}><NextIcon aria-hidden="true" /></HatchIconButton>
        {file && file.content !== null ? <SegmentedControl value={mode} onValueChange={setMode} ariaLabel={t("markdownEditor")} items={[{ value: "rendered", label: t("viewRendered") }, { value: "raw", label: t("viewRaw") }]} /> : null}
        <div className="fv__bar-end">
          {onAddToChat ? <HatchIconButton label={t("addToChat")} size="small" onClick={() => onAddToChat(record.path)}><SendIcon aria-hidden="true" /></HatchIconButton> : null}
          <HatchIconButton asChild label={t("download")} size="small"><a href={`${fileUrl}&download=1`}><DownloadIcon aria-hidden="true" /></a></HatchIconButton>
        </div>
      </div>
      {readError ? <InlineAlert tone="error">{readError}</InlineAlert> : null}
      {!file ? <p className="fl__empty">{readError ? "" : t("loadingFile")}</p> : file.content === null ? <p className="fl__empty">{t("downloadToView")}</p> : <>
        <div className="fv__body">{mode === "rendered" ? <Markdown filePath={record.path} files={siblings} onOpenFile={onOpenFile} t={t}>{edit}</Markdown> : <textarea className="fv__raw" value={edit} onChange={event => setEdit(event.target.value)} aria-label={t("markdownEditor")} />}</div>
        {requiresCopyName ? <input className="hui-input fv__copy" value={copyName} onChange={event => setCopyName(event.target.value)} placeholder={t("revisionFilenamePlaceholder")} aria-label={t("revisionFilename")} /> : null}
      </>}
    </div>
  </DialogContent></Dialog>;
}

function AgentState({ entry, agentName, t, compact = false }) { if (entry?.state === "complete" || entry?.state === "update_available") return null; let text = t(agentStateKey(entry)); if (entry?.state === "locked") text = t("finishOneAgentFirst", BUILD_NEEDS.map(need => need === "uploads" ? t("uploadSources") : agentName(need)).join(t("roleSeparator"))); return <Chip size="small" icon={entry?.state === "locked" ? <Lock /> : undefined} label={compact ? undefined : text} color={entry?.state === "failed" ? "error" : entry?.state === "running" ? "primary" : "default"} variant={entry?.state === "running" ? "filled" : "outlined"} sx={compact ? { width: 10, height: 10, "& .MuiChip-icon": { display: "none" }, "& .MuiChip-label": { display: "none" } } : undefined} />; }
function NextSteps({ entry, agents, onOpenAgent, agentName, t }) {
  const locked = entry?.state === "locked";
  if (!locked) return null;
  return <Stack spacing={1} sx={{ mb: 1.5 }}>
    {locked && <Alert severity="warning" variant="outlined" sx={{ alignItems: "flex-start", "& .MuiAlert-message": { width: "100%", minWidth: 0 } }}>
      <Stack spacing={1.25}>
        <Box>
          <Typography variant="body2" component="p" fontWeight={700} sx={{ m: 0 }}>{t("beforeStarting")}</Typography>
          <Typography variant="caption" component="p" sx={{ mt: .35, mb: 0, lineHeight: 1.5 }}>{t("completeUpstreamWork")}</Typography>
        </Box>
        <Stack direction="row" spacing={.75} useFlexGap sx={{ flexWrap: "wrap" }}>
          {BUILD_NEEDS.map(need => <Button key={need} variant="outlined" size="small" onClick={() => onOpenAgent(need)} endIcon={<ArrowForward />}>{need === "uploads" ? t("uploadSources") : agentName(need)}</Button>)}
        </Stack>
      </Stack>
    </Alert>}
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

function Message({ message, files, onOpenFile, t }) { if (!message) return null; const text = typeof message.content === "string" ? message.content : message.content?.filter(item => item.type === "text").map(item => item.text).join("\n"); if (!text) return null; const user = message.role === "user"; return <Box component="article" className={`factory-message factory-message--${user ? "user" : "assistant"}`} sx={{ mb: 2.5, display: "flex", justifyContent: user ? "flex-end" : "flex-start" }}><Box className={user ? "factory-message-bubble" : "factory-message-content"}>{message.role === "assistant" ? <Markdown files={files} onOpenFile={onOpenFile} t={t}>{text}</Markdown> : <Markdown files={files} onOpenFile={onOpenFile} t={t}>{text}</Markdown>}</Box></Box>; }
function factoryError(error, t, agentName) { if (error?.code === "usage_cap_exceeded") return t("usageCapReached"); if (error?.code === "build_not_ready") return t("finishOneAgentFirst", [t("uploadSources"), agentName("voice")].join(t("roleSeparator"))); if (error?.code === "agent_definitions_unavailable" || error?.code === "agent_definitions_invalid") return t("agentSetupUnavailable"); return error?.message || t("unknownFactoryError"); }
