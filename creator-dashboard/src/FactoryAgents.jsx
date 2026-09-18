import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, Accordion, AccordionDetails, AccordionSummary, Avatar, Box, Button, Chip,
  Checkbox, FormControl, FormControlLabel, FormGroup, FormLabel,
  CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  IconButton, List, ListItemButton, ListItemIcon, ListItemText,
  Paper, Radio, RadioGroup, Skeleton, Snackbar, Stack, TextField, Toolbar, Tooltip,
  Typography
} from "@mui/material";
import {
  ArrowBack, ArrowForward, AutoAwesome, ChevronRight, DeleteOutlineOutlined,
  DashboardOutlined, Description, Download, ExpandMore, FactCheck, FolderOpen, Lock,
  PlayArrow, Send, Source, Stop, UploadFile
} from "@mui/icons-material";
import { createTheme, ThemeProvider, alpha } from "@mui/material/styles";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { SimpleTreeView, TreeItem } from "@mui/x-tree-view";
import { ChatComposer, ChatComposerTextArea, ChatComposerToolbar } from "@mui/x-chat";
import { ChatProvider } from "@mui/x-chat/headless";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { hatchMuiThemeOptions } from "@hatch/ui";
import { dashboardRequest } from "./data.js";
import { chatEntries, groupToolEntries } from "./factoryMessages.js";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { FactoryVoicePlayer } from "./factoryVoicePlayer.js";
import { createFactoryAgentTranslator } from "./factoryAgentsI18n.js";
import { agentDependencyGaps, agentStateKey, changedDependencies, localizeAgentText } from "./factoryAgentState.js";
import { creatorFactoryPath, FACTORY_SECTION_AGENTS, FACTORY_SECTION_PAGES, factorySectionForAgent } from "./creatorRoutes.js";
import "./factoryAgents.css";

const STAGES = [
  ["sources", "sourcesStage", "sourcesStageDescription", FACTORY_SECTION_AGENTS.sources, Source],
  ["build", "generationStage", "generationStageDescription", FACTORY_SECTION_AGENTS.build, AutoAwesome],
  ["evaluate", "evaluationStage", "evaluationStageDescription", FACTORY_SECTION_AGENTS.evaluate, FactCheck]
];
const api = (route, options = {}) => dashboardRequest(route, { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
const factoryRoot = productId => `/v1/creator/products/${encodeURIComponent(productId)}/factory-agents`;
const endpoint = (root, id, action = "") => `${root}/sessions/${id}${action ? `/${action}` : ""}`;

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
  const [sessions, setSessions] = useState([]); const [agents, setAgents] = useState([]); const [manualFiles, setManualFiles] = useState([]); const [config, setConfig] = useState(null); const [product, setProduct] = useState(null); const [productName, setProductName] = useState(""); const [productDraft, setProductDraft] = useState({ name: "", promise: "" }); const [productSave, setProductSave] = useState({ busy: false, notice: "" }); const [error, setError] = useState(""); const importPicker = useRef(null);
  const root = useMemo(() => factoryRoot(productId), [productId]);
  const stage = section ?? null;
  const selected = agent ?? null;
  const goToFactory = (nextStage, nextAgent) => navigate(creatorFactoryPath(productId, nextStage, nextAgent));
  const applyNavigation = value => { setSessions(value.sessions || []); setAgents(value.agents || []); setManualFiles(value.manualFiles || []); };
  const refreshSnapshot = () => api(`${root}/sessions`).then(applyNavigation);
  const refreshConfig = () => api(`${root}/config`).then(value => { setConfig(value); if (value.agents) setAgents(value.agents); }).catch(e => setError(e.message));
  const refreshProduct = () => api(`/v1/creator/products/${encodeURIComponent(productId)}`).then(value => { const next = value.product ?? value; setProduct(next); setProductName(next?.name ?? next?.product_name ?? ""); setProductDraft({ name: next?.name ?? next?.product_name ?? "", promise: next?.promise ?? next?.product_promise ?? "" }); }).catch(e => setError(e.message));
  const saveProduct = async event => {
    event?.preventDefault();
    const name = productDraft.name.trim();
    const promise = productDraft.promise.trim();
    if (!product || !name || !promise || productSave.busy) return;
    setProductSave({ busy: true, notice: "" }); setError("");
    try {
      const response = await api(`/v1/creator/products/${encodeURIComponent(productId)}`, { method: "PATCH", headers: { "idempotency-key": crypto.randomUUID() }, body: { name, promise, expected_updated_at: product.updated_at } });
      const saved = response.product ?? response;
      setProduct(current => ({ ...current, ...saved, name, promise })); setProductName(saved?.name ?? name); setProductDraft({ name: saved?.name ?? name, promise: saved?.promise ?? promise }); setProductSave({ busy: false, notice: t("productDetailsSaved") });
    } catch (nextError) { setProductSave({ busy: false, notice: "" }); setError(nextError.message); }
  };
  useEffect(() => { refreshConfig(); refreshProduct(); return subscribeFactoryEvents({ url: `${root}/events`, onMessage: event => { const value = JSON.parse(event.data); if (value.type === "snapshot") applyNavigation(value); }, onError: () => setError(t("workspaceConnectionLost")), onOpen: () => { setError(""); refreshConfig(); refreshProduct(); } }); }, [productId, root, t]);
  const agentEntry = role => agents.find(item => item.role === role);
  const agentName = role => localizeAgentText(agentEntry(role)?.name, locale);
  const agentSession = role => sessions.filter(item => item.role === role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const openAgent = async role => { try { const targetStage = factorySectionForAgent(role); if (!targetStage) throw new Error(t("agentStateUnavailable")); const entry = agentEntry(role); if (!entry) throw new Error(t("agentStateUnavailable")); if (entry.state === "locked") { goToFactory(targetStage, role); return; } if (!agentSession(role)) await api(`${root}/sessions`, { method: "POST", body: { role } }); goToFactory(targetStage, role); } catch (e) { setError(factoryError(e, t, agentName)); } };
  const uploadProjectFiles = async files => { try { let transport = agentSession("research"); if (!transport) transport = await api(`${root}/sessions`, { method: "POST", body: { role: "research" } }); for (const file of files) { if (file.size > 20 * 1024 * 1024) throw new Error(t("fileTooLarge", file.name)); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(root, transport.id, "files"), { method: "POST", body: { path: `input/manual/${file.name}`, base64: btoa(binary), mimeType: file.type || undefined } }); } } catch (e) { setError(factoryError(e, t, agentName)); } };
  const stageSummary = roles => { const entries = roles.map(agentEntry).filter(Boolean); const running = entries.filter(item => item.state === "running").length; const updates = entries.filter(item => item.state === "update_available").length; const completed = entries.filter(item => item.state === "complete").length; if (running) return t("stageRunning", running); if (updates) return t("stageHasUpdates", updates); if (completed) return t("stageComplete", completed); return entries.some(item => item.state === "ready") ? t("stageReady") : t("stageWaiting"); };
  const selectedEntry = selected ? agentEntry(selected) : null; const selectedSession = selected ? agentSession(selected) : null;
  return <ThemeProvider theme={theme}><Box className="factory-app" aria-label={t("factory")}><FactoryHeader productName={productName} stage={stage} selected={selected} agentName={agentName} t={t} navigate={navigate} /><Box className="factory-body" sx={{ display: "flex", flex: 1, minHeight: 0 }}><FactorySidebar stage={stage} selected={selected} agents={agents} agentName={agentName} stageSummary={stageSummary} goToFactory={goToFactory} locale={locale} t={t} /><Box className="factory-content" sx={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative" }}><ErrorNotice error={error} onClose={() => setError("")} />{selected === "uploads" ? <SourceUploadWorkspace sessions={sessions} importPicker={importPicker} uploadProjectFiles={uploadProjectFiles} onOpenAgent={openAgent} t={t} /> : selected ? selectedSession ? <Workspace key={selectedSession.id} root={root} id={selectedSession.id} entry={selectedEntry} agents={agents} config={config} onChanged={() => undefined} onOpenAgent={openAgent} agentName={agentName} t={t} /> : <AgentStartWorkspace entry={selectedEntry} agents={agents} onOpenAgent={openAgent} agentName={agentName} t={t} /> : stage ? <StageOverview stage={stage} agents={agents} sessions={sessions} agentName={agentName} onOpenAgent={openAgent} locale={locale} t={t} /> : <FactoryOverview product={product} draft={productDraft} onDraftChange={setProductDraft} saveState={productSave} onSave={saveProduct} stages={STAGES} stageSummary={stageSummary} goToFactory={goToFactory} t={t} />}</Box></Box></Box></ThemeProvider>;
}

function FactoryHeader({ productName, stage, selected, agentName, t, navigate }) {
  const title = selected === "uploads" ? t("uploadSources") : selected ? agentName(selected) : stage ? t(STAGES.find(item => item[0] === stage)?.[1]) : t("overview");
  return <Box component="header" className="factory-header" sx={{ height: 56, flexShrink: 0, display: "flex", alignItems: "center", px: 1.5, gap: 1.5, borderBottom: 1, borderColor: "divider", bgcolor: "background.paper" }}><Tooltip title={t("product")}><IconButton size="small" onClick={() => navigate("/studio/products")}><ArrowBack fontSize="small" /></IconButton></Tooltip><Divider orientation="vertical" flexItem sx={{ my: 1.25 }} /><Box sx={{ minWidth: 0 }}><Typography variant="caption" color="text.secondary" sx={{ display: "block", lineHeight: 1.1 }}>{productName || t("product")}</Typography><Typography variant="subtitle1" noWrap sx={{ fontWeight: 700 }}>{title}</Typography></Box><Box sx={{ flex: 1 }} /></Box>;
}

function FactorySidebar({ stage, selected, agents, agentName, stageSummary, goToFactory, locale, t }) {
  const selectedItem = selected || stage || "overview";
  const handleSelection = (_, itemId) => { const id = String(itemId); const parent = STAGES.find(item => item[3].includes(id)); const pageParent = Object.entries(FACTORY_SECTION_PAGES).find(([, pages]) => pages.includes(id)); if (parent) goToFactory(parent[0], id); else if (pageParent) goToFactory(pageParent[0], id); else if (STAGES.some(item => item[0] === id)) goToFactory(id); else if (id === "overview") goToFactory(); };
  return <Box component="aside" className="factory-stage-rail" sx={{ width: 248, flexShrink: 0, borderRight: 1, borderColor: "divider", bgcolor: "var(--hatch-ui-surface-sidebar)", overflow: "auto", py: 1.5 }}><SimpleTreeView aria-label={t("factory")} selectedItems={selectedItem} defaultExpandedItems={stage ? [stage] : STAGES.map(item => item[0])} expansionTrigger="iconContainer" onSelectedItemsChange={handleSelection} sx={{ px: 1 }}>
    <TreeItem itemId="overview" label={<Stack direction="row" spacing={1} alignItems="center" sx={{ py: .5 }}><DashboardOutlined fontSize="small" /><Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="body2" fontWeight={650} noWrap>{t("overview")}</Typography><Typography variant="caption" color="text.secondary" noWrap>{t("overviewDescription")}</Typography></Box></Stack>} />
    {STAGES.map(([id, title, description, roles, Icon]) => <TreeItem key={id} itemId={id} label={<Stack direction="row" spacing={1} alignItems="center" sx={{ py: .5 }}><Icon fontSize="small" /><Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="body2" fontWeight={650} noWrap>{t(title)}</Typography><Typography variant="caption" color="text.secondary" noWrap>{stageSummary(roles)}</Typography></Box></Stack>}>{roles.map(role => { const entry = agents.find(item => item.role === role); if (!entry) return null; return <TreeItem key={role} itemId={role} label={<Stack direction="row" spacing={1} alignItems="center" sx={{ py: .35 }}><Typography variant="caption" noWrap sx={{ flex: 1 }}>{localizeAgentText(entry.name, locale)}</Typography><DependencyBadges entry={entry} agents={agents} agentName={agentName} t={t} compact /><AgentState entry={entry} agentName={agentName} t={t} compact /></Stack>} />; })}{id === "sources" ? <TreeItem itemId="uploads" label={<Stack direction="row" spacing={1} alignItems="center" sx={{ py: .35 }}><UploadFile fontSize="small" /><Typography variant="caption" noWrap>{t("uploadSources")}</Typography></Stack>} /> : null}</TreeItem>)}
  </SimpleTreeView></Box>;
}

function FactoryOverview({ product, draft, onDraftChange, saveState, onSave, stages, stageSummary, goToFactory, t }) {
  return <Box className="factory-overview" sx={{ height: "100%", overflow: "auto", p: { xs: 3, md: 5 }, maxWidth: 980 }}>
    <Typography variant="h4" sx={{ mt: 1, mb: 1 }}>{t("productOverview")}</Typography>
    <Typography color="text.secondary" sx={{ maxWidth: 680, mb: 3 }}>{t("overviewDescription")}</Typography>
    <Paper component="form" onSubmit={onSave} variant="outlined" sx={{ p: { xs: 2, md: 3 }, mb: 4 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>{t("productDetails")}</Typography>
      <Stack spacing={2}>
        <TextField label={t("productName")} value={draft.name} onChange={event => onDraftChange(current => ({ ...current, name: event.target.value }))} disabled={!product || saveState.busy} fullWidth required />
        <TextField label={t("productPromise")} value={draft.promise} onChange={event => onDraftChange(current => ({ ...current, promise: event.target.value }))} disabled={!product || saveState.busy} fullWidth required multiline minRows={3} />
        <Stack direction="row" spacing={1} alignItems="center">
          <Button type="submit" variant="contained" disabled={!product || saveState.busy || !draft.name.trim() || !draft.promise.trim()}>{saveState.busy ? t("saving") : t("save")}</Button>
          {saveState.notice ? <Typography variant="body2" color="success.main" role="status">{saveState.notice}</Typography> : null}
        </Stack>
      </Stack>
    </Paper>
    <Typography variant="h6" sx={{ mb: 1.5 }}>{t("factory")}</Typography>
    <Paper variant="outlined" sx={{ overflow: "hidden" }}><List disablePadding>{stages.map(([id, title, description, roles, Icon], index) => <React.Fragment key={id}><ListItemButton onClick={() => goToFactory(id)} sx={{ px: 2.5, py: 2 }}><ListItemIcon><Avatar sx={{ width: 36, height: 36, bgcolor: alpha(theme.palette.primary.main, .1), color: "primary.main" }}><Icon fontSize="small" /></Avatar></ListItemIcon><ListItemText primary={<Typography fontWeight={700}>{`${index + 1}  ${t(title)}`}</Typography>} secondary={<>{t(description)}<br /><Typography component="span" variant="caption" color="text.secondary">{stageSummary(roles)}</Typography></>} /><ArrowForward color="action" fontSize="small" /></ListItemButton>{index < stages.length - 1 && <Divider />}</React.Fragment>)}</List></Paper>
  </Box>;
}

function StageOverview({ stage, agents, sessions, agentName, onOpenAgent, locale, t }) {
  const data = STAGES.find(item => item[0] === stage); const entries = (data?.[3] || []).map(role => agents.find(item => item.role === role)).filter(Boolean).sort((a, b) => a.order - b.order);
  return <Box className="factory-stage-overview" sx={{ height: "100%", overflow: "auto", p: { xs: 3, md: 5 } }}><Typography variant="h4">{t(data?.[1])}</Typography><Typography color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 680 }}>{t(data?.[2])}</Typography><Paper variant="outlined" sx={{ overflow: "hidden" }}><List disablePadding>{entries.map((entry, index) => <React.Fragment key={entry.role}><AgentRow entry={entry} agents={agents} session={sessions.filter(item => item.role === entry.role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]} agentName={agentName} locale={locale} onClick={() => onOpenAgent(entry.role)} t={t} />{index < entries.length - 1 && <Divider />}</React.Fragment>)}</List></Paper></Box>;
}

function SourceUploadWorkspace({ sessions, importPicker, uploadProjectFiles, onOpenAgent, t }) {
  const researchSession = sessions.filter(item => item.role === "research").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const manualFiles = researchSession?.files?.filter(record => record.path.startsWith("input/manual/"));
  return <Box className="factory-upload-page" sx={{ height: "100%", overflow: "auto", p: { xs: 3, md: 5 }, maxWidth: 980 }}>
    <Typography variant="h4">{t("uploadSources")}</Typography>
    <Typography color="text.secondary" sx={{ mt: 1, mb: 3, maxWidth: 680 }}>{t("uploadSourcesBody")}</Typography>
    <Paper variant="outlined" sx={{ mb: 2 }}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems={{ xs: "stretch", sm: "center" }} sx={{ px: 2.5, py: 2 }}>
        <ListItemIcon sx={{ minWidth: 40 }}><UploadFile color="primary" /></ListItemIcon>
        <ListItemText primary={t("uploadSources")} secondary={t("uploadSourcesBody")} sx={{ flex: 1 }} />
        <Button variant="contained" size="small" onClick={() => importPicker.current?.click()} sx={{ alignSelf: { xs: "flex-start", sm: "center" } }}>{t("chooseFiles")}</Button>
      </Stack>
      <input ref={importPicker} hidden type="file" multiple aria-label={t("uploadInputFiles")} onChange={event => { uploadProjectFiles([...event.target.files]); event.target.value = ""; }} />
    </Paper>
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Box sx={{ px: 2.5, py: 1.5, display: "flex", alignItems: "center", gap: 1, borderBottom: 1, borderColor: "divider" }}>
        <FolderOpen fontSize="small" /><Typography variant="subtitle2" fontWeight={750}>{t("manualUploads")}</Typography><Chip size="small" label={t("fileCount", manualFiles?.length || 0)} sx={{ ml: "auto" }} />
      </Box>
      {manualFiles?.length ? <List dense disablePadding>{manualFiles.map(record => <ListItemButton key={record.path} onClick={() => onOpenAgent("research")}><ListItemIcon><Description fontSize="small" /></ListItemIcon><ListItemText primary={record.path.replace("input/manual/", "")} secondary={record.mimeType || t("files")} primaryTypographyProps={{ noWrap: true }} /><ChevronRight fontSize="small" color="disabled" /></ListItemButton>)}</List> : <Typography variant="body2" color="text.secondary" sx={{ px: 2.5, py: 3 }}>{t("noFiles")}</Typography>}
    </Paper>
  </Box>;
}

function AgentRow({ entry, agents, session, agentName, locale, onClick, t }) { const completed = session?.todos?.filter(todo => todo.status === "completed").length || 0; return <ListItemButton onClick={onClick} sx={{ px: 2.5, py: 2 }}><ListItemIcon><Avatar sx={{ width: 36, height: 36, bgcolor: entry.state === "locked" ? "action.disabledBackground" : "primary.main" }}>{entry.state === "locked" ? <Lock fontSize="small" /> : <AutoAwesome fontSize="small" />}</Avatar></ListItemIcon><ListItemText primary={localizeAgentText(entry.name, locale)} secondary={<>{localizeAgentText(entry.hint, locale)} {session?.todos?.length ? `· ${completed}/${session.todos.length}` : ""}</>} primaryTypographyProps={{ fontWeight: 700 }} secondaryTypographyProps={{ fontSize: 12 }} /><DependencyBadges entry={entry} agents={agents} agentName={agentName} t={t} /><AgentState entry={entry} agentName={agentName} t={t} /><ChevronRight fontSize="small" color="disabled" /></ListItemButton>; }

function Workspace({ root, id, entry, agents, config, onChanged, onOpenAgent, agentName, t }) {
  const layoutStorage = typeof window !== "undefined" ? window.localStorage : undefined; const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: `factory-workspace-${id}`, storage: layoutStorage, onlySaveAfterUserInteractions: true });
  const [session, setSession] = useState(null); const [error, setError] = useState(""); const [draft, setDraft] = useState(() => sessionStorage.getItem(`factory-draft:${id}`) || ""); const [stream, setStream] = useState(""); const [activity, setActivity] = useState(""); const [activityVisible, setActivityVisible] = useState(true); const [file, setFile] = useState(null); const [busy, setBusy] = useState(false); const [speaking, setSpeaking] = useState(null);
  const composer = useRef(null); const chat = useRef(null); const stick = useRef(true); const voiceHandler = useRef(() => {}); const refresh = () => api(endpoint(root, id)).then(setSession);
  useEffect(() => { let live = true; const load = (clearStream = false) => api(endpoint(root, id)).then(value => { if (live) { setSession(value); setError(""); if (clearStream) { setStream(""); setActivityVisible(false); } } }).catch(e => { if (live) setError(e.message); }); load(); const unsubscribe = subscribeFactoryEvents({ url: `${root}/sessions/${id}/events`, onMessage: event => { const value = JSON.parse(event.data); if (value.type.startsWith("voice.")) voiceHandler.current(value); if (value.type === "delta") { setActivityVisible(false); setStream(previous => previous + value.text); } if (value.type === "message") load(true); if (value.type === "state") load(); if (value.type === "tool") { setActivityVisible(true); setActivity(t("callingTool", t(toolActionKey(value.name)))); } if (value.type === "thinking") { setActivityVisible(true); setActivity(t("thinking")); } if (value.type === "compacting") { setActivityVisible(true); setActivity(t("compacting")); } if (value.type === "tool_end") { setActivityVisible(true); setActivity(value.isError ? t("toolErrorContinuing") : t("continuing")); } if (["files", "todos"].includes(value.type)) load(); }, onError: () => { if (live) setActivity(t("reconnecting")); }, onOpen: () => { if (live) { setActivity(""); load(); } } }); return () => { live = false; unsubscribe(); }; }, [root, id, t]);
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
  if (!session) return <Stack sx={{ p: 4 }} spacing={1}><Skeleton width="35%" /><Skeleton width="80%" /><Skeleton width="70%" /><ErrorNotice error={error} onClose={() => setError("")} /></Stack>;
  const running = session.status === "running"; const locked = entry?.state === "locked"; const visibleSession = { ...session, files: session.files.filter(record => !record.path.startsWith("input/handoff/")) };
  const upload = files => perform(async () => { for (const f of files) { if (f.size > 20 * 1024 * 1024) throw new Error(t("fileTooLarge", f.name)); const bytes = new Uint8Array(await f.arrayBuffer()); let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(root, id, "files"), { method: "POST", body: { path: `input/manual/${f.name}`, base64: btoa(binary), mimeType: f.type || undefined } }); } });
  const openFile = path => setFile(path); const addToChat = (path, quote) => { const reference = `${t("fileReference", path)}${quote ? `\n\n${quote.split("\n").map(line => `> ${line}`).join("\n")}` : ""}`; setDraft(previous => `${previous}${previous.trim() ? "\n\n" : ""}${reference}\n\n`); requestAnimationFrame(() => composer.current?.focus()); }; const useLatest = () => { setActivityVisible(true); return perform(async () => { await api(endpoint(root, id, "message"), { method: "POST", body: { content: t("useLatestMessage") } }); setActivity(t("thinking")); }); };
  return <Group className="factory-workspace" id="factory-workspace" orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged} style={{ height: "100%", minHeight: 0 }}><Panel className="factory-workspace-pane" id="factory-main" defaultSize="72%" minSize="58%"><ChatPanel session={visibleSession} entry={entry} root={root} id={id} config={config} busy={busy} draft={draft} setDraft={setDraft} stream={stream} activity={activity} activityVisible={activityVisible} composer={composer} composerAdapter={composerAdapter} chat={chat} stick={stick} running={running} locked={locked} error={error} setError={setError} perform={perform} onOpenFile={openFile} agentName={agentName} voiceHandler={voiceHandler} speaking={speaking} setSpeaking={setSpeaking} t={t} /></Panel><Separator className="factory-resize-handle" /><Panel className="factory-workspace-pane" id="factory-inspector" defaultSize="28%" minSize="24%" collapsible collapsedSize="0%"><InspectorPanel entry={entry} agents={agents} session={visibleSession} root={root} id={id} running={running} busy={busy} file={file} setFile={setFile} upload={upload} addToChat={addToChat} agentName={agentName} onOpenAgent={onOpenAgent} useLatest={useLatest} t={t} perform={perform} /></Panel></Group>;
}

function ChatPanel({ session, entry, root, id, config, busy, draft, setDraft, stream, activity, activityVisible, composer, composerAdapter, chat, stick, running, locked, error, setError, perform, onOpenFile, agentName, voiceHandler, speaking, setSpeaking, t }) {
  const entries = groupToolEntries(chatEntries(session.messages));
  const pendingAskUser = [...entries].reverse().find(item => item.type === "askUser" && item.pending);
  const composerDisabled = locked || busy || Boolean(pendingAskUser) || !config?.services.model;
  const sendDisabled = composerDisabled || !(draft || "").trim();
  const stopResponse = () => perform(() => api(endpoint(root, id, "stop"), { method: "POST", body: {} }));
  const answerAskUser = content => composerAdapter.sendMessage({ message: { parts: [{ type: "text", text: content }] } });
  const composerSx = { border: "1px solid var(--hatch-ui-border-soft)", borderRadius: "var(--hatch-radius-dialog)", backgroundColor: "var(--hatch-ui-surface-solid)", px: 1.5, py: 1, "&:focus-within": { borderColor: "var(--hatch-ui-border-soft)", boxShadow: "none" }, "&:focus-within:not([data-disabled])": { borderColor: "var(--hatch-ui-border-soft)", boxShadow: "none" }, "& textarea:focus": { outline: "none", boxShadow: "none" } };
  return <Box className="factory-chat-panel" sx={{ height: "100%", minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", bgcolor: "background.paper" }}>
    <Toolbar className="factory-pane-header" variant="dense" sx={{ minHeight: 56, px: 2, borderBottom: 1, borderColor: "divider" }}>
      <Box sx={{ minWidth: 0, flex: 1 }}><Typography variant="subtitle1" fontWeight={750} noWrap>{agentName(session.role)}</Typography></Box>
    </Toolbar>
    <Box className="factory-chat-scroll" ref={chat} sx={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain", px: 2.5, py: 2 }} onScroll={event => { const target = event.currentTarget; stick.current = target.scrollHeight - target.scrollTop - target.clientHeight < 80; }}>
      {!session.messages.length && <Box sx={{ py: 8, textAlign: "center" }}><AutoAwesome color="primary" sx={{ fontSize: 32, mb: 1 }} /><Typography variant="h6" fontWeight={750}>{t("startChatHeading")}</Typography><Typography variant="body2" color="text.secondary">{t("messagePlaceholder", session.role)}</Typography></Box>}
      {entries.map(item => item.type === "toolGroup" ? <ToolGroup key={item.key} items={item.items} running={running && item.isCurrentTurn} t={t} /> : item.type === "tool" ? <ToolMessage key={item.key} call={item.call} result={item.result} running={running && item.isCurrentTurn} t={t} /> : item.type === "askUser" ? <AskUserBlock key={item.key} entry={item} onSubmit={answerAskUser} t={t} /> : <Message key={item.key} message={item.message} files={session.files} onOpenFile={onOpenFile} speaking={speaking} t={t} />)}
      {stream && <Message message={{ role: "assistant", content: stream }} files={session.files} onOpenFile={onOpenFile} speaking={speaking} t={t} />}
      {running && activityVisible && <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}><CircularProgress size={14} /><Typography variant="caption" color="primary.main">{activity || (session.activeTool ? t("callingTool", t(toolActionKey(session.activeTool))) : t("working"))}</Typography></Stack>}
    </Box>
    <ErrorNotice error={error || session.error} onClose={() => setError("")} />
    <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1.5, pb: 1 }}>
      <StartAgentButton role={session.role} draft={draft} setDraft={setDraft} composer={composer} disabled={composerDisabled || running} t={t} />
      {session.role === "voice" && <VoiceControls root={root} id={id} enabled={!locked && config?.services.voice} handler={voiceHandler} onSpeaking={setSpeaking} onError={setError} t={t} />}
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
  return <Button type="button" size="small" variant="outlined" startIcon={<PlayArrow />} disabled={disabled || Boolean(draft.trim())} onClick={start}>{t("startAgent")}</Button>;
}

function InspectorPanel({ entry, agents, session, root, id, running, busy, file, setFile, upload, addToChat, agentName, onOpenAgent, useLatest, t, perform }) {
  const inputFiles = session.files.filter(record => record.path.startsWith("input/") && !record.path.startsWith("input/handoff/")); const outputFiles = session.files.filter(record => record.path.startsWith("output/"));
  const selectedFile = file ? session.files.find(record => record.path === file) : null;
  return <Box component="aside" className="factory-inspector" aria-label={t("nextSteps")} sx={{ height: "100%", minWidth: 0, display: "flex", flexDirection: "column", bgcolor: "var(--hatch-ui-surface-sidebar)" }}><Toolbar className="factory-pane-header" variant="dense" sx={{ minHeight: 56, borderBottom: 1, borderColor: "divider" }}><AutoAwesome fontSize="small" sx={{ mr: 1 }} /><Box sx={{ flex: 1 }} />{entry && <><DependencyBadges entry={entry} agents={agents} agentName={agentName} t={t} /><AgentState entry={entry} agentName={agentName} t={t} /></>}</Toolbar><Box className="factory-inspector-scroll" sx={{ overflow: "auto", flex: 1, minHeight: 0, p: 1.5 }}><Binding s={session} t={t} />{entry && <NextSteps entry={entry} agents={agents} todos={session.todos || []} onOpenAgent={onOpenAgent} onUseLatest={useLatest} busy={busy} agentName={agentName} t={t} />}<Paper variant="outlined" sx={{ mb: 1.5, overflow: "hidden" }}><Box sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: "divider", display: "flex", alignItems: "center", gap: 1 }}><FolderOpen fontSize="small" /><Typography variant="caption" fontWeight={750}>{t("files")}</Typography><Chip size="small" label={session.files.length} sx={{ ml: "auto" }} /><Button component="label" size="small" startIcon={<UploadFile />} disabled={running || busy}>{t("addFiles")}<input hidden type="file" multiple onChange={event => { upload([...event.target.files]); event.target.value = ""; }} /></Button></Box><Box sx={{ p: 1.5 }}><FileSection title={t("attachments")} records={inputFiles} onOpen={setFile} onDelete={path => perform(() => api(endpoint(root, id, "files"), { method: "DELETE", body: { path } }))} canDelete={!running} t={t} /><FileSection title={t("outputs")} records={outputFiles} onOpen={setFile} t={t} /></Box></Paper>{selectedFile && <FileViewer key={file} root={root} running={running} id={id} record={selectedFile} files={session.files} onOpenFile={setFile} onAddToChat={addToChat} onClose={() => setFile(null)} t={t} perform={perform} />}</Box></Box>;
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
function AgentStartWorkspace({ entry, agents, onOpenAgent, agentName, t }) { return <Box sx={{ p: 5, maxWidth: 720 }}><Typography variant="h4">{agentName(entry?.role)}</Typography><Box sx={{ mt: 2, mb: 3 }}><DependencyBadges entry={entry} agents={agents} agentName={agentName} t={t} /><AgentState entry={entry} agentName={agentName} t={t} /></Box><NextSteps entry={entry} agents={agents} todos={[]} onOpenAgent={onOpenAgent} agentName={agentName} t={t} />{entry?.state === "ready" || entry?.state === "failed" ? <Button variant="contained" startIcon={<PlayArrow />} onClick={() => onOpenAgent(entry.role)}>{t(entry.state === "failed" ? "tryAgain" : "startAgent")}</Button> : null}</Box>; }
function NextSteps({ entry, agents, todos, onOpenAgent, onUseLatest, busy, agentName, t }) { const gaps = agentDependencyGaps(entry); const updatedDependencies = changedDependencies(entry, agents); const locked = entry?.state === "locked"; const updated = entry?.state === "update_available"; if (!locked && !updated && !todos.length) return null; return <Stack spacing={1} sx={{ mb: 1.5 }}>{locked && <Alert severity="warning" variant="outlined"><Typography variant="caption" display="block" fontWeight={700}>{t("beforeStarting")}</Typography><Typography variant="caption">{t("completeUpstreamWork")}</Typography>{[...gaps.required, ...gaps.alternatives].map(role => <Button key={role} size="small" onClick={() => onOpenAgent(role)} endIcon={<ArrowForward />}>{agentName(role)}</Button>)}</Alert>}{updated && <Alert severity="info" action={<Button size="small" disabled={busy} onClick={onUseLatest}>{t("improveWithLatest")}</Button>}><Stack direction="row" spacing={.5} sx={{ flexWrap: "wrap" }}>{updatedDependencies.map(role => <Chip key={role} size="small" color="warning" variant="outlined" label={t("dependencyUpdated", agentName(role))} />)}</Stack></Alert>}{todos.length > 0 && <Paper variant="outlined" sx={{ p: 1.25 }}><Stack direction="row" justifyContent="space-between"><Typography variant="caption" fontWeight={750}>{t("todo")}</Typography><Typography variant="caption" color="text.secondary">{todos.filter(todo => todo.status === "completed").length}/{todos.length}</Typography></Stack><Box className="factory-todo-list" sx={{ maxHeight: 220, overflowY: "auto", pr: 0.5 }}><Stack spacing={0.75}>{todos.map((todo, index) => <Box key={`${todo.title}-${index}`} className="factory-todo-row"><Typography component="span" variant="caption" className="factory-todo-marker" aria-hidden="true">{todo.status === "completed" ? "✓" : "○"}</Typography><Typography component="span" variant="caption" className="factory-todo-title" sx={{ color: todo.status === "completed" ? "text.secondary" : "text.primary", textDecoration: todo.status === "completed" ? "line-through" : "none" }}>{todo.title}</Typography></Box>)}</Stack></Box></Paper>}</Stack>; }
const toolActionKey = name => { const value = String(name || "").toLowerCase(); if (value.includes("update_todo")) return "toolActionUpdateTodo"; if (value.includes("corpus_upload")) return "toolActionCorpusUpload"; if (value.includes("evaluate")) return "toolActionEvaluate"; if (value.includes("search")) return "toolActionSearch"; if (value.includes("write")) return "toolActionWrite"; if (value.includes("read")) return "toolActionRead"; if (value.includes("list")) return "toolActionList"; return "toolActionUnknown"; };
const toolWorkKey = items => { const names = items.map(item => item.call?.name || item.result?.toolName || "").join(" ").toLowerCase(); if (names.includes("corpus_upload")) return "toolWorkPublish"; if (names.includes("list") || names.includes("read") || names.includes("search")) return "toolWorkGather"; if (names.includes("write") || names.includes("update_todo")) return "toolWorkBuild"; return "toolWorkMethod"; };
function ToolGroup({ items, running, t }) { const pending = items.some(item => !item.result); const failed = items.some(item => item.result?.isError); const status = pending ? t(running ? "toolCalling" : "toolMissing") : failed ? t("toolFailed") : ""; return <Accordion disableGutters variant="outlined" sx={{ mb: 1, "&:before": { display: "none" } }}><AccordionSummary expandIcon={<ExpandMore />}><Stack spacing={0.25}><Typography variant="body2" fontWeight={700}>{t(toolWorkKey(items))}</Typography><Typography variant="caption" color="text.secondary">{t("toolActionsCompleted", items.length)}{status ? ` · ${status}` : ""}</Typography></Stack></AccordionSummary><AccordionDetails sx={{ pt: 0 }}><Stack spacing={0.75}>{items.map(item => <ToolMessage key={item.key} call={item.call} result={item.result} running={running && item.isCurrentTurn} t={t} />)}</Stack></AccordionDetails></Accordion>; }
function ToolMessage({ call, result, running, t }) { const rawName = call?.name || result?.toolName || ""; const status = result?.isError ? t("toolFailed") : result ? "" : t(running ? "toolCalling" : "toolMissing"); const text = typeof result?.content === "string" ? result.content : result?.content?.filter(item => item.type === "text").map(item => item.text).join("\n"); return <Accordion disableGutters variant="outlined" sx={{ "&:before": { display: "none" } }}><AccordionSummary expandIcon={<ExpandMore />}><Stack spacing={0.25}><Typography variant="body2">{t(toolActionKey(rawName))}</Typography>{status && <Typography variant="caption" color="text.secondary">{status}</Typography>}</Stack></AccordionSummary><AccordionDetails sx={{ pt: 0 }}><Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t("toolTechnicalDetails")} · {rawName}</Typography>{call && <><Typography variant="caption" fontWeight={700}>{t("toolArguments")}</Typography><Typography component="pre" variant="caption" sx={{ whiteSpace: "pre-wrap", display: "block" }}>{JSON.stringify(call.arguments, null, 2)}</Typography></>}{result && <><Typography variant="caption" fontWeight={700}>{t("toolResult")}</Typography><Typography component="pre" variant="caption" sx={{ whiteSpace: "pre-wrap", display: "block" }}>{text || ""}</Typography></>}</AccordionDetails></Accordion>; }
function askUserOption(option, index) { return typeof option === "string" ? { id: `option-${index + 1}`, label: option } : { id: option?.id || `option-${index + 1}`, label: option?.label || "", description: option?.description || "" }; }
function AskUserBlock({ entry, onSubmit, t }) {
  const questions = Array.isArray(entry?.call?.arguments?.questions) ? entry.call.arguments.questions : [];
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
    const lines = questions.map((question, index) => {
      const id = question.id || `question-${index + 1}`; const answer = answers[id] || {}; const options = (question.options || []).map(askUserOption); const selected = (Array.isArray(answer.selected) ? answer.selected : [answer.selected]).filter(Boolean).map(value => options.find(option => option.id === value)?.label || value);
      return `${question.header || question.question}: ${[selected.join(", "), answer.other?.trim()].filter(Boolean).join("; ") || "(blank)"}`;
    });
    setSubmitting(true);
    try { await onSubmit(lines.join("\n")); } catch { setSubmitting(false); }
  };
  return <Paper className="factory-ask-user" variant="outlined" sx={{ mb: 2, p: 2, borderColor: "primary.main", bgcolor: "background.paper" }}><Stack spacing={2}><Box><Typography variant="subtitle1" fontWeight={750}>{t("askUserTitle")}</Typography><Typography variant="body2" color="text.secondary">{t("askUserDescription")}</Typography></Box>{questions.map((question, index) => { const id = question.id || `question-${index + 1}`; const answer = answers[id] || { selected: question.multiSelect ? [] : "", other: "" }; const options = (question.options || []).map(askUserOption); return <Box key={id}><FormControl fullWidth required={question.required !== false}><FormLabel sx={{ color: "text.primary", mb: 0.75 }}>{question.question}</FormLabel>{question.multiSelect ? <FormGroup>{options.map(option => <FormControlLabel key={option.id} control={<Checkbox checked={Array.isArray(answer.selected) && answer.selected.includes(option.id)} onChange={event => update(id, { selected: event.target.checked ? [...(answer.selected || []), option.id] : (answer.selected || []).filter(value => value !== option.id) })} />} label={<Box><Typography variant="body2">{option.label}</Typography>{option.description && <Typography variant="caption" color="text.secondary">{option.description}</Typography>}</Box>} />)}</FormGroup> : <RadioGroup value={answer.selected || ""} onChange={event => update(id, { selected: event.target.value })}>{options.map(option => <FormControlLabel key={option.id} value={option.id} control={<Radio />} label={<Box><Typography variant="body2">{option.label}</Typography>{option.description && <Typography variant="caption" color="text.secondary">{option.description}</Typography>}</Box>} />)}</RadioGroup>}<TextField fullWidth size="small" multiline minRows={2} value={answer.other || ""} onChange={event => update(id, { other: event.target.value })} placeholder={t("askUserOtherPlaceholder")} sx={{ mt: 1 }} /></FormControl></Box>; })}<Button variant="contained" onClick={submit} disabled={!complete || submitting} sx={{ alignSelf: "flex-start" }}>{submitting ? t("askUserSubmitting") : t("askUserSubmit")}</Button></Stack></Paper>;
}
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
