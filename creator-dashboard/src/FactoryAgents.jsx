import { dashboardRequest } from "./data.js";
import { chatEntries } from "./factoryMessages.js";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { FactoryVoicePlayer } from "./factoryVoicePlayer.js";
import { createFactoryAgentTranslator } from "./factoryAgentsI18n.js";
import { agentDependencyGaps, agentStateKey, localizeAgentText } from "./factoryAgentState.js";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@hatch/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './factoryAgents.css';

const STAGES = [
  ['sources', 'sourcesStage', 'sourcesStageDescription', ['research', 'voice']],
  ['generation', 'generationStage', 'generationStageDescription', ['generation']],
  ['evaluation', 'evaluationStage', 'evaluationStageDescription', ['case-generation', 'evaluator']],
];
const STATUS = { idle: 'idle', running: 'running', completed: 'completed', failed: 'failed', interrupted: 'interrupted' };
const api = (route, options = {}) => dashboardRequest(route, { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
const factoryRoot = productId => `/v1/creator/products/${encodeURIComponent(productId)}/factory-agents`;
const endpoint = (root, id, action = '') => `${root}/sessions/${id}${action ? `/${action}` : ''}`;
function Markdown({ children, filePath = 'output/chat.md', files = [], onOpenFile, t }) {
  const link = ({ node, href, ...props }) => {
    let local;
    if (href && !/^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(href)) {
      try {
        const relative = /^(input|output)\//.test(href) ? `/${href}` : href;
        const path = decodeURIComponent(new URL(relative, `https://workspace.invalid/${filePath}`).pathname.slice(1));
        local = files.find(file => file.path === path)?.path;
      } catch { /* Render unsupported URLs normally. */ }
    }
    return local && onOpenFile
      ? <a {...props} href={href} onClick={event => { event.preventDefault(); onOpenFile(local); }}/>
      : <a {...props} href={href} target="_blank" rel="noreferrer"/>;
  };
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: link, img: ({ alt }) => <span className="muted">{t('imageAlt', alt || t('externalImage'))}</span> }}>{children || ''}</ReactMarkdown></div>;
}
function ErrorNotice({ error }) { return error ? <p className="error" role="alert">{error}</p> : null; }
export function FactoryAgents({ productId, locale = 'en' }) {
  const t = useMemo(() => createFactoryAgentTranslator(locale), [locale]);
  const [stage, setStage] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [config, setConfig] = useState(null);
  const importPicker = useRef(null);
  const [error, setError] = useState('');
  const root = useMemo(() => factoryRoot(productId), [productId]);
  const applyNavigation = value => { setSessions(value.sessions || []); setAgents(value.agents || []); };
  const refresh = () => api(`${root}/sessions`).then(applyNavigation).catch(e => setError(e.message));
  const refreshConfig = () => api(`${root}/config`).then(value => { setConfig(value); if (value.agents) setAgents(value.agents); }).catch(e => setError(e.message));
  useEffect(() => { refresh(); refreshConfig(); return subscribeFactoryEvents({ url: `${root}/events`, onMessage: e => { const v = JSON.parse(e.data); if (['state', 'todos', 'files'].includes(v.type)) refresh(); }, onError: () => setError(t('workspaceConnectionLost')), onOpen: () => { setError(''); refresh(); refreshConfig(); } }); }, [root, t]);
  const openAgent = async role => {
    try {
      const targetStage = STAGES.find(item => item[3].includes(role));
      if (targetStage) setStage(targetStage[0]);
      const entry = agents.find(agent => agent.role === role);
      if (!entry) throw new Error(t('agentStateUnavailable'));
      if (entry.state === 'locked') { setSelected(role); return; }
      let session = sessions.filter(s => s.role === role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (!session) session = await api(`${root}/sessions`, { method: 'POST', body: { role } });
      await refresh(); setSelected(role);
    } catch (e) { setError(factoryError(e, t, agentName)); }
  };
  const uploadProjectFiles = async files => {
    try {
      let transport = sessions.find(s => s.role === 'research');
      if (!transport) transport = await api(`${root}/sessions`, { method: 'POST', body: { role: 'research' } });
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(t('fileTooLarge', file.name));
        const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await api(endpoint(root, transport.id, 'files'), { method: 'POST', body: { path: `input/manual/${file.name}`, base64: btoa(binary), mimeType: file.type || undefined } });
      }
      await refresh();
    } catch (e) { setError(factoryError(e, t, agentName)); }
  };
  const agentSession = role => sessions.filter(s => s.role === role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const agentEntry = role => agents.find(agent => agent.role === role);
  const agentName = role => localizeAgentText(agentEntry(role)?.name, locale);
  const stageSummary = roles => {
    const entries = roles.map(agentEntry).filter(Boolean);
    const running = entries.filter(agent => agent.state === 'running').length;
    const updates = entries.filter(agent => agent.state === 'update_available').length;
    const completed = entries.filter(agent => agent.state === 'complete').length;
    if (running) return t('stageRunning', running);
    if (updates) return t('stageHasUpdates', updates);
    if (completed) return t('stageComplete', completed);
    return entries.some(agent => agent.state === 'ready') ? t('stageReady') : t('stageWaiting');
  };
  const selectedEntry = selected ? agentEntry(selected) : null;
  const selectedSession = selected ? agentSession(selected) : null;
  return <section className="factory-agents" aria-label={t('factory')}>
    <ErrorNotice error={error}/>
    {selected ? <><button className="factory-back" onClick={() => setSelected(null)}>← {t('backToStage')}</button><main className="app-main agent-open">{selectedSession ? <Workspace key={selectedSession.id} root={root} id={selectedSession.id} entry={selectedEntry} config={config} onChanged={refresh} onOpenAgent={openAgent} agentName={agentName} locale={locale} t={t}/> : <AgentStartWorkspace entry={selectedEntry} onOpenAgent={openAgent} agentName={agentName} t={t}/>}</main></>
      : stage ? <main className="factory-stage"><button className="factory-back" onClick={() => setStage(null)}>← {t('allStages')}</button><header><span>{t('product')}</span><h1>{t(STAGES.find(item => item[0] === stage)?.[1])}</h1><p>{t(STAGES.find(item => item[0] === stage)?.[2])}</p></header><div className="agent-cards">{stage === 'sources' && <><button className="agent-card source-method" onClick={() => importPicker.current?.click()}><div><span>{t('files')}</span><strong>{t('uploadSources')}</strong></div><p>{t('uploadSourcesBody')}</p><footer>{t('chooseFiles')} <span>→</span></footer></button><button className="agent-card source-method" disabled><div><span>{t('comingSoon')}</span><strong>{t('futureSources')}</strong></div><p>{t('futureSourcesBody')}</p><footer>{t('comingSoon')}</footer></button><input ref={importPicker} aria-label={t('uploadInputFiles')} hidden type="file" multiple onChange={e => { uploadProjectFiles([...e.target.files]); e.target.value = ''; }}/></>}{STAGES.find(item => item[0] === stage)?.[3].map(agentEntry).filter(Boolean).sort((a, b) => a.order - b.order).map(entry => { const session = agentSession(entry.role); const completed = session?.todos?.filter(todo => todo.status === 'completed').length || 0; return <button className="agent-card" data-agent-state={entry.state} key={entry.role} onClick={() => openAgent(entry.role)}><div><span>{localizeAgentText(entry.name, locale)}{entry.state === 'update_available' ? <i className="update-dot" aria-label={t('agentHasUpdates')}/> : null}</span><strong>{localizeAgentText(entry.hint, locale)}</strong></div><AgentState entry={entry} agentName={agentName} t={t}/>{session?.todos?.length ? <ol>{session.todos.slice(0, 4).map((todo, index) => <li key={`${todo.title}-${index}`} data-status={todo.status}>{todo.title}</li>)}</ol> : <p>{entry.state === 'locked' ? t('openToSeeNext') : t('agentBuildsTodo')}</p>}<footer>{session?.todos?.length ? `${completed}/${session.todos.length} ${t('done')}` : t('openAgent')} <span>→</span></footer></button>; })}</div></main>
      : <main className="factory-project"><header><span>{t('product')}</span><h1>{t('factoryPromise')}</h1></header><div className="stage-cards">{STAGES.map(([id, titleKey, descriptionKey, roles], index) => <button key={id} className="stage-card" onClick={() => setStage(id)}><span className="stage-number">0{index + 1}</span><div><h2>{t(titleKey)}</h2><p>{t(descriptionKey)}</p></div><footer>{stageSummary(roles)} <span>→</span></footer></button>)}</div></main>}
  </section>;
}
function Workspace({ root, id, entry, config, onChanged, onOpenAgent, agentName, locale, t }) {
  const [s, setSession] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => sessionStorage.getItem(`factory-draft:${id}`) || '');
  const [stream, setStream] = useState('');
  const [activity, setActivity] = useState('');
  const [file, setFile] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pane, setPane] = useState('chat');
  const [speaking, setSpeaking] = useState(null);
  const openFile = path => { setFile(path); setPane('files'); };
  const addToChat = (path, quote) => {
    const reference = `${t('fileReference', path)}${quote ? `\n\n${quote.split('\n').map(line => `> ${line}`).join('\n')}` : ''}`;
    setDraft(previous => `${previous}${previous.trim() ? '\n\n' : ''}${reference}\n\n`);
    setPane('chat');
    requestAnimationFrame(() => composer.current?.focus());
  };
  const composer = useRef(null);
  const chat = useRef(null);
  const stick = useRef(true);
  const voiceHandler = useRef(() => {});
  const refresh = () => api(endpoint(root, id)).then(setSession);
  useEffect(() => { let live = true; const load = () => api(endpoint(root, id)).then(v => { if (live) { setSession(v); setError(''); } }).catch(e => { if (live) setError(e.message); }); load(); const unsubscribe = subscribeFactoryEvents({ url: `${root}/events`, onMessage: e => { const v = JSON.parse(e.data); if (v.sessionId !== id) return; if (v.type.startsWith('voice.')) voiceHandler.current(v); if (v.type === 'delta') setStream(value => value + v.text); if (v.type === 'message' || v.type === 'state') { setStream(''); load(); } if (v.type === 'tool') setActivity(t('callingTool', v.name)); if (v.type === 'thinking') setActivity(t('thinking')); if (v.type === 'compacting') setActivity(t('compacting')); if (v.type === 'tool_end') setActivity(v.isError ? t('toolErrorContinuing', v.name) : t('continuing')); if (['files', 'todos', 'comments'].includes(v.type)) load(); }, onError: () => { if (live) setActivity(t('reconnecting')); }, onOpen: () => { if (live) { setActivity(''); setStream(''); load(); } } }); return () => { live = false; unsubscribe(); }; }, [root, id, t]);
  useEffect(() => { sessionStorage.setItem(`factory-draft:${id}`, draft); }, [id, draft]);
  useEffect(() => { if (stick.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [stream, s?.messages.length]);
  const perform = async fn => { setError(''); setBusy(true); try { await fn(); await refresh(); onChanged(); } catch (e) { setError(factoryError(e, t, agentName)); } finally { setBusy(false); } };
  const interruptVoice = () => voiceHandler.current({ type: 'voice.interrupt' });
  const submit = e => { e.preventDefault(); if (!draft.trim() || running || locked) return; interruptVoice(); const content = draft; perform(async () => { await api(endpoint(root, id, 'message'), { method: 'POST', body: { content } }); setDraft(''); stick.current = true; setActivity(t('thinking')); }); };
  const upload = files => perform(async () => { for (const f of files) { if (f.size > 20 * 1024 * 1024) throw new Error(t('fileTooLarge', f.name)); const bytes = new Uint8Array(await f.arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(root, id, 'files'), { method: 'POST', body: { path: `input/manual/${f.name}`, base64: btoa(text), mimeType: f.type || undefined } }); } });
  if (!s) return <section className="welcome">{t('loadingWorkspace')}<ErrorNotice error={error}/></section>;
  const running = s.status === 'running';
  const locked = entry?.state === 'locked';
  const useLatest = () => perform(async () => { await api(endpoint(root, id, 'message'), { method: 'POST', body: { content: t('useLatestMessage') } }); stick.current = true; setActivity(t('thinking')); });
  return <><div className="workspace-switch" role="tablist" aria-label={t('workspacePanels')}><button role="tab" aria-selected={pane === 'chat'} onClick={() => setPane('chat')}>{t('chat')}</button><button role="tab" aria-selected={pane === 'files'} onClick={() => setPane('files')}>{t('files')} <span>{s.files.length}</span></button><span className="pane-state">{t(running ? 'working' : STATUS[s.status])}</span></div><section className="chat-panel" data-active={pane === 'chat'}><div className="workspace-heading"><div><h1>{agentName(s.role)}</h1><span className={running ? 'status running' : 'status'}>{t(STATUS[s.status])}</span></div><button className="text-button" onClick={() => perform(async () => setPrompt((await api(endpoint(root, id, 'prompt'))).content))}>{t('viewPrompt')}</button></div>
    <Binding s={s} t={t}/><NextSteps entry={entry} todos={s.todos || []} onOpenAgent={onOpenAgent} onUseLatest={useLatest} busy={busy} agentName={agentName} t={t}/>
    <div className="chat-log" ref={chat} onScroll={() => { const e = chat.current; stick.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
    {!s.messages.length && <div className="chat-empty"><h2>{t('startChatHeading')}</h2></div>}
    {chatEntries(s.messages).map(entry => entry.type === 'tool' ? <ToolMessage key={entry.key} call={entry.call} result={entry.result} running={running && entry.isCurrentTurn} t={t}/> : <Message key={entry.key} message={entry.message} files={s.files} onOpenFile={openFile} speaking={speaking} t={t}/>)}{stream && <article className="message assistant"><span className="message-role">{t('agent')}</span><SpokenReply text={stream} speaking={speaking} files={s.files} onOpenFile={openFile} t={t}/></article>}{running && <p className="activity" role="status">{activity || (s.activeTool ? t('callingTool', s.activeTool) : t('working'))}</p>}
    </div><ErrorNotice error={error || s.error}/>{s.role === 'voice' && <VoiceControls root={root} id={id} enabled={!locked && config?.services.voice} handler={voiceHandler} onSpeaking={setSpeaking} onError={setError} t={t}/>}<form className="composer" onSubmit={submit}><textarea ref={composer} disabled={locked} aria-label={t('messageLabel')} placeholder={t(locked ? 'completeDependenciesToStart' : 'messagePlaceholder')} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e); } }}/><div>{running ? <Button type="button" variant="secondary" onClick={() => { interruptVoice(); perform(() => api(endpoint(root, id, 'stop'), { method: 'POST', body: {} })); }}>{t('stop')}</Button> : <Button disabled={locked || busy || !draft.trim() || !config?.services.model}>{t('send')}</Button>}</div></form></section>
    <section className="files-panel" data-active={pane === 'files'}><div className="section-heading"><h2>{t('files')}</h2><span className="muted">{t('fileCount', s.files.length)}</span></div><div className="file-trays"><div className="file-tray" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!running && e.dataTransfer.files.length) upload([...e.dataTransfer.files]); }}><div className="section-heading"><strong>{t('attachments')}</strong><label className={`upload ${running ? 'disabled' : ''}`}>{t('addFiles')}<input aria-label={t('uploadInputFiles')} type="file" multiple disabled={running || busy} onChange={e => { upload([...e.target.files]); e.target.value = ''; }}/></label></div>{s.files.filter(f => f.path.startsWith('input/')).map(f => <div className="file-row" key={f.path}><button className="file-link" onClick={() => { setFile(f.path); setPane('files'); }} title={f.path}>{f.path.slice(6)}</button>{f.path.startsWith('input/manual/') && <button className="remove" aria-label={t('removeFile', f.path)} disabled={running} onClick={() => perform(() => api(endpoint(root, id, 'files'), { method: 'DELETE', body: { path: f.path } }))}>×</button>}</div>)}{!s.files.some(f => f.path.startsWith('input/')) && <p className="empty-tray">{t('dropFiles')}</p>}</div><div className="file-tray"><div className="section-heading"><strong>{t('outputs')}</strong></div>{s.files.filter(f => f.path.startsWith('output/')).map(f => <div className="file-row" key={f.path}><button className="file-link" onClick={() => { setFile(f.path); setPane('files'); }} title={f.path}>{f.path.slice(7)}{f.readonly ? ' ◦' : ''}</button></div>)}{!s.files.some(f => f.path.startsWith('output/')) && <p className="empty-tray">{t('noFiles')}</p>}</div></div>

    {file && s.files.some(f => f.path === file) ? <FileViewer key={file} root={root} running={running} id={id} record={s.files.find(f => f.path === file)} comments={s.comments} perform={perform} files={s.files} onOpenFile={openFile} onAddToChat={addToChat} resultPath={s.hatch?.lastRunId ? `output/results/${s.hatch.lastRunId}.md` : undefined} locale={locale} t={t}/> : <div className="document-empty"><p>{t('chooseFile')}</p></div>}
    </section>{prompt !== null && <div className="modal-backdrop"><section className="prompt-modal" role="dialog" aria-modal="true" aria-label={t('systemPrompt')}><div className="section-heading"><h2>{t('systemPrompt')}</h2><Button variant="secondary" onClick={() => setPrompt(null)}>{t('close')}</Button></div><pre>{prompt}</pre></section></div>}</>;
}
function AgentState({ entry, agentName, t }) {
  const gaps = agentDependencyGaps(entry);
  let text = t(agentStateKey(entry));
  if (entry?.state === 'locked' && gaps.required.length) text = t('finishAgentsFirst', roleList(gaps.required, agentName, t));
  else if (entry?.state === 'locked' && gaps.alternatives.length) text = t('finishOneAgentFirst', roleList(gaps.alternatives, agentName, t));
  return <small className="agent-state"><i aria-hidden="true"/>{text}</small>;
}
function AgentStartWorkspace({ entry, onOpenAgent, agentName, t }) {
  if (!entry) return <section className="locked-workspace"><p>{t('loadingAgentState')}</p></section>;
  return <section className="locked-workspace"><div className="workspace-heading"><h1>{agentName(entry.role)}</h1></div><AgentState entry={entry} agentName={agentName} t={t}/><NextSteps entry={entry} todos={[]} onOpenAgent={onOpenAgent} agentName={agentName} t={t}/>{entry.state === 'ready' || entry.state === 'failed' ? <Button onClick={() => onOpenAgent(entry.role)}>{t(entry.state === 'failed' ? 'tryAgain' : 'startAgent')}</Button> : null}</section>;
}
function NextSteps({ entry, todos, onOpenAgent, onUseLatest, busy, agentName, t }) {
  const gaps = agentDependencyGaps(entry);
  const locked = entry?.state === 'locked';
  const updated = entry?.state === 'update_available';
  if (!locked && !updated && !todos.length) return null;
  return <section className={`next-steps ${locked ? 'is-locked' : ''}`} aria-label={t('nextSteps')}>
    {locked ? <><header><strong>{t('beforeStarting')}</strong><span>{t('completeUpstreamWork')}</span></header><DependencyRows roles={gaps.required} onOpenAgent={onOpenAgent} agentName={agentName} t={t}/>{gaps.alternatives.length ? <><p>{t('completeOneOf')}</p><DependencyRows roles={gaps.alternatives} onOpenAgent={onOpenAgent} agentName={agentName} t={t}/></> : null}</> : null}
    {updated ? <UpdateNotice roles={entry.availability?.updatedDependencies || []} onOpenAgent={onOpenAgent} onUseLatest={onUseLatest} agentName={agentName} busy={busy} t={t}/> : null}
    <TodoList todos={todos} t={t}/>
  </section>;
}
function UpdateNotice({ roles, onOpenAgent, onUseLatest, agentName, busy, t }) { return <div className="update-notice"><div><strong>{t('newWorkAvailable')}</strong><span>{roles.length ? t('newWorkAvailableBody', roleList(roles, agentName, t)) : t('newWorkAvailableBodyGeneric')}</span></div><div>{roles.map(role => <button type="button" className="text-button" key={role} onClick={() => onOpenAgent(role)}>{t('viewAgent', agentName(role))}</button>)}<Button size="compact" disabled={busy} onClick={onUseLatest}>{t('improveWithLatest')}</Button></div></div>; }
function DependencyRows({ roles, onOpenAgent, agentName, t }) { return roles.map(role => <button type="button" className="dependency-row" key={role} onClick={() => onOpenAgent(role)}><span><i aria-hidden="true"/>{agentName(role)}</span><small>{t('goThere')} →</small></button>); }
function TodoList({ todos, t }) { if (!todos.length) return null; return <div className="todo-list"><header><span>{t('todo')}</span><small>{todos.filter(todo=>todo.status==='completed').length}/{todos.length}</small></header><ol>{todos.map((todo,index)=><li key={`${todo.title}-${index}`} data-status={todo.status}><span aria-hidden="true">{todo.status==='completed'?'✓':todo.status==='in_progress'?'●':'○'}</span>{todo.title}</li>)}</ol></div>; }
function roleList(roles, agentName, t) { return roles.map(agentName).join(t('roleSeparator')); }
function VoiceControls({ root, id, enabled, handler, onSpeaking, onError, t }) {
  const [active, setActive] = useState(false); const [partial, setPartial] = useState('');
  const resources = useRef(null); const audioQueue = useRef(Promise.resolve()); const player = useRef(null);
  if (!player.current) player.current = new FactoryVoicePlayer(onSpeaking, onError);
  useEffect(() => { handler.current = event => {
    if (event.type === 'voice.interrupt' || event.type === 'voice.user_speaking' || event.type === 'voice.transcript.final') player.current.stop();
    if (event.type === 'voice.transcript.partial') setPartial(event.text || '');
    if (event.type === 'voice.transcript.final') setPartial('');
    if (event.type === 'voice.audio.start') player.current.start(event);
    if (event.type === 'voice.speech.start') player.current.registerSpeech(event);
    if (event.type === 'voice.speech.end') player.current.endSpeech(event);
    if (event.type === 'voice.audio.chunk') player.current.chunk(event);
    if (event.type === 'voice.audio.end') player.current.end();
    if (event.type === 'voice.error') onError(event.message);
  }; return () => { handler.current = () => {}; player.current.stop(); }; }, [handler, onError, onSpeaking]);
  const stop = async () => { player.current.stop(); const current = resources.current; resources.current = null; current?.processor.disconnect(); current?.source.disconnect(); current?.silence.disconnect(); current?.stream.getTracks().forEach(track => track.stop()); void current?.context.close(); setActive(false); setPartial(''); await api(endpoint(root, id, 'voice/stop'), { method: 'POST', body: {} }).catch(error => onError(error.message)); };
  const start = async () => { try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const context = new AudioContext({ sampleRate: 16000 }); await context.resume(); const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1); const silence = context.createGain(); silence.gain.value = 0;
    processor.onaudioprocess = event => { const input = event.inputBuffer.getChannelData(0); const bytes = new Uint8Array(input.length * 2); const view = new DataView(bytes.buffer); for (let i = 0; i < input.length; i++) { const value = Math.max(-1, Math.min(1, input[i])); view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true); } let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); audioQueue.current = audioQueue.current.then(() => api(endpoint(root, id, 'voice/audio'), { method: 'POST', body: { base64: btoa(binary) } })).catch(error => onError(error.message)); };
    resources.current = { stream, context, source, processor, silence }; await api(endpoint(root, id, 'voice/start'), { method: 'POST', body: {} }); source.connect(processor); processor.connect(silence); silence.connect(context.destination); setActive(true);
  } catch (error) { await stop(); onError(error.message); } };
  useEffect(() => () => { void stop(); }, [id]);
  return <div className="voice-controls"><Button type="button" variant={active ? 'secondary' : 'primary'} disabled={!enabled} onClick={active ? stop : start}>{t(active ? 'stopVoice' : 'startVoice')}</Button><span>{partial || (enabled ? (active ? t('listening') : '') : t('voiceUnavailable'))}</span></div>;
}
function voiceText(text) { return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s*#{1,6}\s+/gm, '').replace(/^\s*(?:[-*+] |\d+\. )/gm, '').replace(/[*_~]/g, '').replace(/\s+/g, ' ').trim(); }
function SpokenReply({ text, speaking, files, onOpenFile, t }) {
  const display = voiceText(text); const needle = voiceText(speaking?.text || ''); const index = needle ? display.indexOf(needle) : -1;
  if (index < 0) return <Markdown files={files} onOpenFile={onOpenFile} t={t}>{text}</Markdown>;
  return <div className="markdown spoken-reply"><span>{display.slice(0, index)}</span><mark>{display.slice(index, index + needle.length)}</mark><span>{display.slice(index + needle.length)}</span></div>;
}
function Message({ message: m, files, onOpenFile, speaking, t }) {
  const text = typeof m.content === 'string' ? m.content : m.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (!text) return null;
  return <article className={`message ${m.role}`}><span className="message-role">{t(m.role === 'user' ? 'you' : 'agent')}</span>{m.role === 'assistant' ? <SpokenReply text={text} speaking={speaking} files={files} onOpenFile={onOpenFile} t={t}/> : <Markdown files={files} onOpenFile={onOpenFile} t={t}>{text}</Markdown>}</article>;
}
function ToolMessage({ call, result, running, t }) {
  const [open, setOpen] = useState(false);
  const status = result ? t(result.isError ? 'toolFailed' : 'toolReturned') : t(running ? 'toolCalling' : 'toolMissing');
  return <details className={`tool-message ${result?.isError ? 'error' : ''}`} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{call?.name || result?.toolName} · {status}</summary>
    {open && <>{call && <><small>{t('arguments')}</small><pre>{JSON.stringify(call.arguments, null, 2)}</pre></>}{result && <><small>{t('result')}</small><pre>{typeof result.content === 'string' ? result.content : result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n')}</pre></>}</>}
  </details>;
}
function Binding({ s, t }) {
  if (s.role === 'generation') return <div className="binding">{t(s.corpus ? 'agentPublished' : 'agentUnpublished')}</div>;
  return null;
}
function FileViewer({ root, running, id, record, comments, perform, files, onOpenFile, onAddToChat, resultPath, locale, t }) {
  const draftKey = `factory-file-draft:${id}:${record.path}`;
  const [savedDraft] = useState(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch { return null; } });
  const [file, setFile] = useState(savedDraft?.file || null);
  const [mode, setMode] = useState(savedDraft ? 'edit' : 'read');
  const [edit, setEdit] = useState(savedDraft?.edit || '');
  const [selection, setSelection] = useState(null);
  const [comment, setComment] = useState('');
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [copyName, setCopyName] = useState(savedDraft?.copyName || '');
  const dirty = mode === 'edit' && edit !== file?.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!file) return;
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ file, edit, copyName }));
      else sessionStorage.removeItem(draftKey);
    } catch { setError(t('draftSaveFailed')); }
  }, [draftKey, file, edit, copyName, dirty]);
  useEffect(() => {
    const warn = e => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const load = async () => { const f = await api(`${endpoint(root, id, 'files')}?path=${encodeURIComponent(record.path)}`); setReadError(''); if (!dirtyRef.current) { setFile(f); setEdit(f.content || ''); setSelection(null); } };
  useEffect(() => { load().catch(e => setReadError(e.message)); }, [root, id, record]);
  const save = () => perform(async () => { const target = record.readonly || record.path.startsWith('input/') ? `output/${copyName}` : record.path; if (!target.endsWith('.md') || target.includes('..')) throw new Error(t('markdownFilenameRequired')); const bytes = new TextEncoder().encode(edit); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(root, id, 'files'), { method: 'POST', body: { path: target, base64: btoa(binary) } }); dirtyRef.current = false; sessionStorage.removeItem(draftKey); setEdit(file.content || ''); setMode('read'); if (target === record.path) await load(); });
  if (!file) return <div className="document-empty">{t('loadingFile')}<ErrorNotice error={readError}/><ErrorNotice error={error}/></div>;
  const commentPath = record.path === 'output/RESULT.md' ? (record.origin?.sessionId === id ? record.origin.path : resultPath || record.path) : record.path;
  const related = comments.filter(c => c.path === commentPath);
  const lines = file.content?.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  const rows = lines.map((text, i) => { const start = offset; offset += text.length; return { start, end: offset, text, number: i + 1 }; });
  return <div className="document"><div className="document-toolbar"><strong title={record.path}>{record.path.split('/').at(-1)}</strong><Button size="compact" variant="ghost" onClick={() => onAddToChat(record.path, mode === 'lines' && selection ? file.content.slice(selection.start, selection.end) : undefined)}>{t(mode === 'lines' && selection ? 'quoteInChat' : 'addToChat')}</Button><a href={`${endpoint(root, id, 'files')}?path=${encodeURIComponent(record.path)}&download=1`}>{t('download')}</a></div><div className="document-tabs">{[['read', t('read')], ['lines', t('annotateLines')], ['edit', t(record.readonly || record.path.startsWith('input/') ? 'writeRevision' : 'edit')]].map(([value, label]) => <button key={value} disabled={dirty && value !== 'edit'} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}</div><ErrorNotice error={readError}/><ErrorNotice error={error}/>
    <div className="document-content">{file.content === null ? <p>{t('downloadToView')}</p> : mode === 'read' ? <Markdown filePath={record.path} files={files} onOpenFile={onOpenFile} t={t}>{file.content}</Markdown> : mode === 'edit' ? <><textarea className="editor" aria-label={t('markdownEditor')} value={edit} onChange={e => setEdit(e.target.value)}/>{(record.readonly || record.path.startsWith('input/')) && <input aria-label={t('revisionFilename')} placeholder={t('revisionFilenamePlaceholder')} value={copyName} onChange={e => setCopyName(e.target.value)}/>}<div className="edit-actions"><Button size="compact" disabled={running} onClick={save}>{t(running ? 'stopBeforeSave' : 'save')}</Button><Button size="compact" variant="secondary" onClick={() => { setEdit(file.content); setMode('read'); }}>{t('discardEdits')}</Button></div></> : <><p className="muted">{t('lineSelectionHelp')}</p><div className="source-lines">{rows.map(r => <button key={r.number} className={selection && r.start >= selection.start && r.end <= selection.end ? 'line selected-line' : 'line'} onClick={e => setSelection(e.shiftKey && selection ? { start: Math.min(selection.start, r.start), end: Math.max(selection.end, r.end) } : { start: r.start, end: r.end })}><span className="line-number">{r.number}</span><span>{r.text.replace(/\n$/, '') || ' '}</span></button>)}</div>{selection && <form className="comment-form" onSubmit={e => { e.preventDefault(); perform(async () => { await api(endpoint(root, id, 'comments'), { method: 'POST', body: { path: record.path, ...selection, quote: file.content.slice(selection.start, selection.end), text: comment, ...(replacement ? { replacement } : {}) } }); setComment(''); setReplacement(''); setSelection(null); }); }}><blockquote>{file.content.slice(selection.start, selection.end)}</blockquote><textarea aria-label={t('commentLabel')} placeholder={t('commentPlaceholder')} value={comment} onChange={e => setComment(e.target.value)} required/><textarea aria-label={t('replacementLabel')} placeholder={t('replacementPlaceholder')} value={replacement} onChange={e => setReplacement(e.target.value)}/><Button size="compact" disabled={!comment.trim()}>{t('saveComment')}</Button></form>}</>}
    {related.length > 0 && <section className="comments"><div className="section-heading"><h3>{t('comments', related.length)}</h3><Button size="compact" variant="secondary" onClick={() => perform(() => api(endpoint(root, id, 'comments/export'), { method: 'POST', body: { locale } }))}>{t('exportReview')}</Button></div>{related.map(c => <article key={c.id}><blockquote>{c.quote}</blockquote><p>{c.text}</p>{c.replacement && <pre>{c.replacement}</pre>}</article>)}</section>}</div></div>;
}

function factoryError(error, t, agentName) {
  if (error?.code === 'agent_dependencies_not_ready') {
    const required = error.details?.missingRequired || [];
    const alternatives = error.details?.normalCandidates || [];
    if (required.length) return t('finishAgentsFirst', roleList(required, agentName, t));
    if (alternatives.length) return t('finishOneAgentFirst', roleList(alternatives, agentName, t));
    return t('agentNeedsPreparation');
  }
  if (error?.code === 'agent_definitions_unavailable' || error?.code === 'agent_definitions_invalid') return t('agentSetupUnavailable');
  return error?.message || t('unknownFactoryError');
}
