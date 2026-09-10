import { dashboardRequest } from "./data.js";
import { chatEntries } from "./factoryMessages.js";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import { FactoryVoicePlayer } from "./factoryVoicePlayer.js";
import { createFactoryAgentTranslator } from "./factoryAgentsI18n.js";
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@hatch/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './factoryAgents.css';

const ROLES = [
  ['research', 'research', 'researchDescription', 'RESEARCH.md'],
  ['voice', 'voice', 'voiceDescription', 'CREATOR_PERSONA.md'],
  ['generation', 'generation', 'generationDescription', 'SYSTEM.md · CORPUS.md'],
  ['case-generation', 'caseGeneration', 'caseDescription', 'CASE.md · RUBRIC.md'],
  ['evaluator', 'evaluator', 'evaluatorDescription', 'RESULT.md · EVALUATION.md'],
];
const STATUS = { idle: 'idle', running: 'running', completed: 'completed', failed: 'failed', interrupted: 'interrupted' };
const api = (route, options = {}) => dashboardRequest(route, { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
const endpoint = (id, action = '') => `/v1/creator/factory-agents/sessions/${id}${action ? `/${action}` : ''}`;
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
export function FactoryAgents({ creatorId, locale = 'en' }) {
  const t = useMemo(() => createFactoryAgentTranslator(locale), [locale]);
  const [role, setRole] = useState('research');
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(() => sessionStorage.getItem(`factory-selection:${creatorId}:research`) || null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const refresh = () => api('/v1/creator/factory-agents/sessions').then(v => setSessions(v.sessions)).catch(e => setError(e.message));
  const refreshConfig = () => api('/v1/creator/factory-agents/config').then(setConfig).catch(e => setError(e.message));
  useEffect(() => { refresh(); refreshConfig(); return subscribeFactoryEvents({ onMessage: e => { const v = JSON.parse(e.data); if (['state', 'progress', 'files'].includes(v.type)) refresh(); }, onError: () => setError(t('workspaceConnectionLost')), onOpen: () => { setError(''); refresh(); refreshConfig(); } }); }, [t]);
  useEffect(() => { if (selected) sessionStorage.setItem(`factory-selection:${creatorId}:${role}`, selected); }, [role, selected]);
  const chooseRole = next => { setRole(next); setSelected(sessionStorage.getItem(`factory-selection:${creatorId}:${next}`) || sessions.find(s => s.role === next)?.id || null); };
  const create = async () => { try { const s = await api('/v1/creator/factory-agents/sessions', { method: 'POST', body: { role } }); await refresh(); setSelected(s.id); } catch (e) { setError(e.message); } };
  return <section className="factory-agents" aria-label="Factory">
    <nav className="roles" aria-label="Agent">{ROLES.map(([id, title]) => <button key={id} className={role === id ? 'role active' : 'role'} onClick={() => chooseRole(id)} aria-current={role === id ? 'page' : undefined}><span className="role-full">{t(title)}</span><span className="role-short">{t(id === 'generation' ? 'generationShort' : id === 'case-generation' ? 'caseShort' : title)}</span></button>)}</nav>
    <ErrorNotice error={error}/><main className="app-main"><aside className="sessions"><div className="section-heading"><span>{t('chats')}</span><Button size="compact" variant="ghost" onClick={create}>{t('newChat')}</Button></div><select className="session-picker" aria-label={t('currentChat')} value={selected || ''} onChange={e => setSelected(e.target.value || null)}><option value="">{t('selectChat')}</option>{sessions.filter(s => s.role === role).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>{sessions.filter(s => s.role === role).map(s => <button className={s.id === selected ? 'session selected' : 'session'} key={s.id} onClick={() => setSelected(s.id)}><strong>{s.title}</strong><small>{t(STATUS[s.status])} · {s.progress.status === 'ready' ? `${s.progress.percentage}%` : t('progressUnreported')}</small><time>{new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale === 'ja' ? 'ja-JP' : 'en', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s.updatedAt))}</time></button>)}</aside>
    {selected ? <Workspace key={selected} id={selected} sessions={sessions} config={config} onChanged={refresh} t={t}/> : <section className="welcome"><span className="eyebrow">{t(ROLES.find(r => r[0] === role)?.[1])}</span><h1>{t(ROLES.find(r => r[0] === role)?.[2])}</h1><Button onClick={create}>{t('startChat')}</Button></section>}
    </main></section>;
}
function Workspace({ id, sessions, config, onChanged, t }) {
  const [s, setSession] = useState(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState(() => sessionStorage.getItem(`factory-draft:${id}`) || '');
  const [stream, setStream] = useState('');
  const [activity, setActivity] = useState('');
  const [file, setFile] = useState(null);
  const [selectedOutputs, setSelectedOutputs] = useState([]);
  const [destination, setDestination] = useState('');
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
  const refresh = () => api(endpoint(id)).then(setSession);
  useEffect(() => { let live = true; const load = () => api(endpoint(id)).then(v => { if (live) { setSession(v); setError(''); } }).catch(e => { if (live) setError(e.message); }); load(); const unsubscribe = subscribeFactoryEvents({ onMessage: e => { const v = JSON.parse(e.data); if (v.sessionId !== id) return; if (v.type.startsWith('voice.')) voiceHandler.current(v); if (v.type === 'delta') setStream(value => value + v.text); if (v.type === 'message' || v.type === 'state') { setStream(''); load(); } if (v.type === 'tool') setActivity(t('callingTool', v.name)); if (v.type === 'thinking') setActivity(t('thinking')); if (v.type === 'compacting') setActivity(t('compacting')); if (v.type === 'tool_end') setActivity(v.isError ? t('toolErrorContinuing', v.name) : t('continuing')); if (['files', 'progress', 'comments'].includes(v.type)) load(); }, onError: () => { if (live) setActivity(t('reconnecting')); }, onOpen: () => { if (live) { setActivity(''); setStream(''); load(); } } }); return () => { live = false; unsubscribe(); }; }, [id, t]);
  useEffect(() => { sessionStorage.setItem(`factory-draft:${id}`, draft); }, [id, draft]);
  useEffect(() => { if (stick.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [stream, s?.messages.length]);
  const perform = async fn => { setError(''); setBusy(true); try { await fn(); await refresh(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const interruptVoice = () => voiceHandler.current({ type: 'voice.interrupt' });
  const submit = e => { e.preventDefault(); if (!draft.trim() || running) return; interruptVoice(); const content = draft; perform(async () => { await api(endpoint(id, 'message'), { method: 'POST', body: { content } }); setDraft(''); stick.current = true; setActivity(t('thinking')); }); };
  const upload = files => perform(async () => { for (const f of files) { if (f.size > 20 * 1024 * 1024) throw new Error(t('fileTooLarge', f.name)); const bytes = new Uint8Array(await f.arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(id, 'files'), { method: 'POST', body: { path: `input/${f.name}`, base64: btoa(text), mimeType: f.type || undefined } }); } });
  if (!s) return <section className="welcome">{t('loadingWorkspace')}<ErrorNotice error={error}/></section>;
  const running = s.status === 'running';
  return <><div className="workspace-switch" role="tablist" aria-label={t('workspacePanels')}><button role="tab" aria-selected={pane === 'chat'} onClick={() => setPane('chat')}>{t('chat')}</button><button role="tab" aria-selected={pane === 'files'} onClick={() => setPane('files')}>{t('files')} <span>{s.files.length}</span></button><span className="pane-state">{t(running ? 'working' : STATUS[s.status])}{s.progress.status === 'ready' ? ` · ${s.progress.percentage}%` : ''}</span></div><section className="chat-panel" data-active={pane === 'chat'}><div className="workspace-heading"><div><h1>{t(ROLES.find(r => r[0] === s.role)?.[1])}</h1><span className={running ? 'status running' : 'status'}>{t(STATUS[s.status])}</span></div><button className="text-button" onClick={() => perform(async () => setPrompt((await api(endpoint(id, 'prompt'))).content))}>{t('viewPrompt')}</button></div>
    <Binding s={s} config={config} perform={perform} t={t}/><div className="progress-row"><span>{t('taskProgress')}</span><strong>{s.progress.status === 'ready' ? `${s.progress.percentage}%` : t('awaitingReport')}</strong><progress max="100" value={s.progress.percentage ?? 0} aria-label={t('taskProgress')}/>{s.progress.status !== 'ready' && s.progress.percentage !== null && <small>{t('previousProgress', s.progress.percentage)}</small>}</div>
    <div className="chat-log" ref={chat} onScroll={() => { const e = chat.current; stick.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
    {!s.messages.length && <div className="chat-empty"><h2>{t('startChatHeading')}</h2></div>}
    {chatEntries(s.messages).map(entry => entry.type === 'tool' ? <ToolMessage key={entry.key} call={entry.call} result={entry.result} running={running && entry.isCurrentTurn} t={t}/> : <Message key={entry.key} message={entry.message} files={s.files} onOpenFile={openFile} speaking={speaking} t={t}/>)}{stream && <article className="message assistant"><span className="message-role">{t('agent')}</span><SpokenReply text={stream} speaking={speaking} files={s.files} onOpenFile={openFile} t={t}/></article>}{running && <p className="activity" role="status">{activity || (s.activeTool ? t('callingTool', s.activeTool) : t('working'))}</p>}
    </div><ErrorNotice error={error || s.error}/>{s.role === 'voice' && <VoiceControls id={id} enabled={config?.services.voice} handler={voiceHandler} onSpeaking={setSpeaking} onError={setError} t={t}/>}<form className="composer" onSubmit={submit}><textarea ref={composer} aria-label={t('messageLabel')} placeholder={t('messagePlaceholder')} value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(e); } }}/><div>{running ? <Button type="button" variant="secondary" onClick={() => { interruptVoice(); perform(() => api(endpoint(id, 'stop'), { method: 'POST', body: {} })); }}>{t('stop')}</Button> : <Button disabled={busy || !draft.trim() || !config?.services.model}>{t('send')}</Button>}</div></form></section>
    <section className="files-panel" data-active={pane === 'files'}><div className="section-heading"><h2>{t('files')}</h2><span className="muted">{t('fileCount', s.files.length)}</span></div><div className="file-trays"><div className="file-tray" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!running && e.dataTransfer.files.length) upload([...e.dataTransfer.files]); }}><div className="section-heading"><strong>{t('attachments')}</strong><label className={`upload ${running ? 'disabled' : ''}`}>{t('addFiles')}<input aria-label={t('uploadInputFiles')} type="file" multiple disabled={running || busy} onChange={e => { upload([...e.target.files]); e.target.value = ''; }}/></label></div>{s.files.filter(f => f.path.startsWith('input/')).map(f => <div className="file-row" key={f.path}><button className="file-link" onClick={() => { setFile(f.path); setPane('files'); }} title={f.path}>{f.path.slice(6)}</button><button className="remove" aria-label={t('removeFile', f.path)} disabled={running} onClick={() => perform(() => api(endpoint(id, 'files'), { method: 'DELETE', body: { path: f.path } }))}>×</button></div>)}{!s.files.some(f => f.path.startsWith('input/')) && <p className="empty-tray">{t('dropFiles')}</p>}</div><div className="file-tray"><div className="section-heading"><strong>{t('outputs')}</strong></div>{s.files.filter(f => f.path.startsWith('output/')).map(f => <div className="file-row" key={f.path}><input aria-label={t('selectFile', f.path)} type="checkbox" checked={selectedOutputs.includes(f.path)} onChange={e => setSelectedOutputs(v => e.target.checked ? [...v, f.path] : v.filter(p => p !== f.path))}/><button className="file-link" onClick={() => { setFile(f.path); setPane('files'); }} title={f.path}>{f.path.slice(7)}{f.readonly ? ' ◦' : ''}</button></div>)}{!s.files.some(f => f.path.startsWith('output/')) && <p className="empty-tray">{t('noFiles')}</p>}</div></div>
    <div className="handoff"><select aria-label={t('destinationWorkspace')} value={destination} onChange={e => setDestination(e.target.value)}><option value="">{t('sendToChat')}</option>{sessions.filter(v => v.id !== id && v.status !== 'running').map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select><Button variant="secondary" size="compact" disabled={busy || !destination || !selectedOutputs.length} onClick={() => perform(async () => { const files = s.files.filter(f => selectedOutputs.includes(f.path)).map(({ path }) => ({ path })); await api(endpoint(destination, 'transfer'), { method: 'POST', body: { fromSessionId: id, files } }); setSelectedOutputs([]); })}>{t('sendFiles', selectedOutputs.length)}</Button></div>
    {file && s.files.some(f => f.path === file) ? <FileViewer key={file} running={running} id={id} record={s.files.find(f => f.path === file)} comments={s.comments} perform={perform} files={s.files} onOpenFile={openFile} onAddToChat={addToChat} resultPath={s.hatch?.lastRunId ? `output/results/${s.hatch.lastRunId}.md` : undefined} t={t}/> : <div className="document-empty"><p>{t('chooseFile')}</p></div>}
    </section>{prompt !== null && <div className="modal-backdrop"><section className="prompt-modal" role="dialog" aria-modal="true" aria-label={t('systemPrompt')}><div className="section-heading"><h2>{t('systemPrompt')}</h2><Button variant="secondary" onClick={() => setPrompt(null)}>{t('close')}</Button></div><pre>{prompt}</pre></section></div>}</>;
}
function VoiceControls({ id, enabled, handler, onSpeaking, onError, t }) {
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
  const stop = async () => { player.current.stop(); const current = resources.current; resources.current = null; current?.processor.disconnect(); current?.source.disconnect(); current?.silence.disconnect(); current?.stream.getTracks().forEach(track => track.stop()); void current?.context.close(); setActive(false); setPartial(''); await api(endpoint(id, 'voice/stop'), { method: 'POST', body: {} }).catch(error => onError(error.message)); };
  const start = async () => { try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const context = new AudioContext({ sampleRate: 16000 }); await context.resume(); const source = context.createMediaStreamSource(stream); const processor = context.createScriptProcessor(4096, 1, 1); const silence = context.createGain(); silence.gain.value = 0;
    processor.onaudioprocess = event => { const input = event.inputBuffer.getChannelData(0); const bytes = new Uint8Array(input.length * 2); const view = new DataView(bytes.buffer); for (let i = 0; i < input.length; i++) { const value = Math.max(-1, Math.min(1, input[i])); view.setInt16(i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true); } let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); audioQueue.current = audioQueue.current.then(() => api(endpoint(id, 'voice/audio'), { method: 'POST', body: { base64: btoa(binary) } })).catch(error => onError(error.message)); };
    resources.current = { stream, context, source, processor, silence }; await api(endpoint(id, 'voice/start'), { method: 'POST', body: {} }); source.connect(processor); processor.connect(silence); silence.connect(context.destination); setActive(true);
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
function Binding({ s, config, perform, t }) {
  const [targets, setTargets] = useState([]);
  const [notice, setNotice] = useState('');
  const refresh = async () => { try { const value = await api('/v1/creator/factory-agents/evaluation-targets'); setTargets(value.targets); setNotice(value.unavailable || ''); } catch (e) { setNotice(e.message); } };
  useEffect(() => { if (s.role === 'evaluator' && config?.services.hatch) refresh(); }, [s.role, config?.services.hatch]);
  if (s.role === 'generation') return <div className="binding">{t(s.corpus ? 'agentPublished' : 'agentUnpublished')}</div>;
  if (s.role !== 'evaluator') return null;
  return <div className="binding"><select aria-label={t('selectAgent')} value={s.target?.productId || ''} disabled={s.status === 'running' || !!s.hatch} onChange={e => { const selected = targets.find(target => target.productId === e.target.value); if (selected) perform(() => api(endpoint(s.id, 'target'), { method: 'PUT', body: { entitlementId: selected.entitlementId, productId: selected.productId } })); }}><option value="">{t('selectAgentPlaceholder')}</option>{targets.map(target => <option key={target.productId} value={target.productId} disabled={!target.available}>{target.name}</option>)}</select><button className="text-button" onClick={refresh}>{t('refresh')}</button>{notice && <p className="muted">{notice}</p>}</div>;
}
function FileViewer({ running, id, record, comments, perform, files, onOpenFile, onAddToChat, resultPath, t }) {
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
  const load = async () => { const f = await api(`${endpoint(id, 'files')}?path=${encodeURIComponent(record.path)}`); setReadError(''); if (!dirtyRef.current) { setFile(f); setEdit(f.content || ''); setSelection(null); } };
  useEffect(() => { load().catch(e => setReadError(e.message)); }, [id, record]);
  const save = () => perform(async () => { const target = record.readonly || record.path.startsWith('input/') ? `output/${copyName}` : record.path; if (!target.endsWith('.md') || target.includes('..')) throw new Error(t('markdownFilenameRequired')); const bytes = new TextEncoder().encode(edit); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(id, 'files'), { method: 'POST', body: { path: target, base64: btoa(binary) } }); dirtyRef.current = false; sessionStorage.removeItem(draftKey); setEdit(file.content || ''); setMode('read'); if (target === record.path) await load(); });
  if (!file) return <div className="document-empty">{t('loadingFile')}<ErrorNotice error={readError}/><ErrorNotice error={error}/></div>;
  const commentPath = record.path === 'output/RESULT.md' ? (record.origin?.sessionId === id ? record.origin.path : resultPath || record.path) : record.path;
  const related = comments.filter(c => c.path === commentPath);
  const lines = file.content?.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  const rows = lines.map((text, i) => { const start = offset; offset += text.length; return { start, end: offset, text, number: i + 1 }; });
  return <div className="document"><div className="document-toolbar"><strong title={record.path}>{record.path.split('/').at(-1)}</strong><Button size="compact" variant="ghost" onClick={() => onAddToChat(record.path, mode === 'lines' && selection ? file.content.slice(selection.start, selection.end) : undefined)}>{t(mode === 'lines' && selection ? 'quoteInChat' : 'addToChat')}</Button><a href={`${endpoint(id, 'files')}?path=${encodeURIComponent(record.path)}&download=1`}>{t('download')}</a></div><div className="document-tabs">{[['read', t('read')], ['lines', t('annotateLines')], ['edit', t(record.readonly || record.path.startsWith('input/') ? 'writeRevision' : 'edit')]].map(([value, label]) => <button key={value} disabled={dirty && value !== 'edit'} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}</div><ErrorNotice error={readError}/><ErrorNotice error={error}/>
    <div className="document-content">{file.content === null ? <p>{t('downloadToView')}</p> : mode === 'read' ? <Markdown filePath={record.path} files={files} onOpenFile={onOpenFile} t={t}>{file.content}</Markdown> : mode === 'edit' ? <><textarea className="editor" aria-label={t('markdownEditor')} value={edit} onChange={e => setEdit(e.target.value)}/>{(record.readonly || record.path.startsWith('input/')) && <input aria-label={t('revisionFilename')} placeholder={t('revisionFilenamePlaceholder')} value={copyName} onChange={e => setCopyName(e.target.value)}/>}<div className="edit-actions"><Button size="compact" disabled={running} onClick={save}>{t(running ? 'stopBeforeSave' : 'save')}</Button><Button size="compact" variant="secondary" onClick={() => { setEdit(file.content); setMode('read'); }}>{t('discardEdits')}</Button></div></> : <><p className="muted">{t('lineSelectionHelp')}</p><div className="source-lines">{rows.map(r => <button key={r.number} className={selection && r.start >= selection.start && r.end <= selection.end ? 'line selected-line' : 'line'} onClick={e => setSelection(e.shiftKey && selection ? { start: Math.min(selection.start, r.start), end: Math.max(selection.end, r.end) } : { start: r.start, end: r.end })}><span className="line-number">{r.number}</span><span>{r.text.replace(/\n$/, '') || ' '}</span></button>)}</div>{selection && <form className="comment-form" onSubmit={e => { e.preventDefault(); perform(async () => { await api(endpoint(id, 'comments'), { method: 'POST', body: { path: record.path, ...selection, quote: file.content.slice(selection.start, selection.end), text: comment, ...(replacement ? { replacement } : {}) } }); setComment(''); setReplacement(''); setSelection(null); }); }}><blockquote>{file.content.slice(selection.start, selection.end)}</blockquote><textarea aria-label={t('commentLabel')} placeholder={t('commentPlaceholder')} value={comment} onChange={e => setComment(e.target.value)} required/><textarea aria-label={t('replacementLabel')} placeholder={t('replacementPlaceholder')} value={replacement} onChange={e => setReplacement(e.target.value)}/><Button size="compact" disabled={!comment.trim()}>{t('saveComment')}</Button></form>}</>}
    {related.length > 0 && <section className="comments"><div className="section-heading"><h3>{t('comments', related.length)}</h3><Button size="compact" variant="secondary" onClick={() => perform(() => api(endpoint(id, 'comments/export'), { method: 'POST', body: {} }))}>{t('exportReview')}</Button></div>{related.map(c => <article key={c.id}><blockquote>{c.quote}</blockquote><p>{c.text}</p>{c.replacement && <pre>{c.replacement}</pre>}</article>)}</section>}</div></div>;
}
