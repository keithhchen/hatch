import { dashboardRequest } from "./data.js";
import { chatEntries } from "./factoryMessages.js";
import { subscribeFactoryEvents } from "./factoryEvents.js";
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@hatch/ui';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './factoryAgents.css';

const ROLES = [
  ['research', 'Research', '追踪来源，理解判断', 'RESEARCH.md'],
  ['generation', 'Agent Generation', '把方法写成可执行定义', 'SYSTEM.md · CORPUS.md'],
  ['case-generation', 'Case Generation', '带来一个真实的客户情境', 'CASE.md · RUBRIC.md'],
  ['evaluator', 'Evaluator', '运行、检查、逐行改进', 'RESULT.md · EVALUATION.md'],
];
const STATUS = { idle: '等待输入', running: '工作中', completed: '本轮结束', failed: '运行失败', interrupted: '已停止' };
const api = (route, options = {}) => dashboardRequest(route, { ...options, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
const endpoint = (id, action = '') => `/v1/creator/factory-agents/sessions/${id}${action ? `/${action}` : ''}`;
function Markdown({ children, filePath = 'output/chat.md', files = [], onOpenFile }) {
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
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: link, img: ({ alt }) => <span className="muted">[图片：{alt || '外部图片'}]</span> }}>{children || ''}</ReactMarkdown></div>;
}
function ErrorNotice({ error }) { return error ? <p className="error" role="alert">{error}</p> : null; }
export function FactoryAgents({ creatorId }) {
  const [role, setRole] = useState('research');
  const [sessions, setSessions] = useState([]);
  const [selected, setSelected] = useState(() => sessionStorage.getItem(`factory-selection:${creatorId}:research`) || null);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const refresh = () => api('/v1/creator/factory-agents/sessions').then(v => setSessions(v.sessions)).catch(e => setError(e.message));
  const refreshConfig = () => api('/v1/creator/factory-agents/config').then(setConfig).catch(e => setError(e.message));
  useEffect(() => { refresh(); refreshConfig(); return subscribeFactoryEvents({ onMessage: e => { const v = JSON.parse(e.data); if (['state', 'progress', 'files'].includes(v.type)) refresh(); }, onError: () => setError('与工作区服务的连接中断，正在重新连接。'), onOpen: () => { setError(''); refresh(); refreshConfig(); } }); }, []);
  useEffect(() => { if (selected) sessionStorage.setItem(`factory-selection:${creatorId}:${role}`, selected); }, [role, selected]);
  const chooseRole = next => { setRole(next); setSelected(sessionStorage.getItem(`factory-selection:${creatorId}:${next}`) || sessions.find(s => s.role === next)?.id || null); };
  const create = async () => { try { const s = await api('/v1/creator/factory-agents/sessions', { method: 'POST', body: { role } }); await refresh(); setSelected(s.id); } catch (e) { setError(e.message); } };
  return <section className="factory-agents" aria-label="Factory">
    <nav className="roles" aria-label="Agent">{ROLES.map(([id, title, description], i) => <button key={id} className={role === id ? 'role active' : 'role'} onClick={() => chooseRole(id)} aria-current={role === id ? 'page' : undefined}><span className="role-full">{title}</span><span className="role-short">{['Research', 'Generation', 'Case', 'Evaluator'][i]}</span></button>)}</nav>
    <ErrorNotice error={error}/><main className="app-main"><aside className="sessions"><div className="section-heading"><span>聊天</span><Button size="compact" variant="ghost" onClick={create}>＋ 新建聊天</Button></div><select className="session-picker" aria-label="当前聊天" value={selected || ''} onChange={e => setSelected(e.target.value || null)}><option value="">选择聊天</option>{sessions.filter(s => s.role === role).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select>{sessions.filter(s => s.role === role).map(s => <button className={s.id === selected ? 'session selected' : 'session'} key={s.id} onClick={() => setSelected(s.id)}><strong>{s.title}</strong><small>{STATUS[s.status]} · {s.progress.status === 'ready' ? `${s.progress.percentage}%` : '完成度待报告'}</small><time>{new Date(s.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></button>)}</aside>
    {selected ? <Workspace key={selected} id={selected} sessions={sessions} config={config} onChanged={refresh}/> : <section className="welcome"><span className="eyebrow">{ROLES.find(r => r[0] === role)?.[1]}</span><h1>{ROLES.find(r => r[0] === role)?.[2]}</h1><Button onClick={create}>开始一个聊天</Button></section>}
    </main></section>;
}
function Workspace({ id, sessions, config, onChanged }) {
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
  const openFile = path => { setFile(path); setPane('files'); };
  const addToChat = (path, quote) => {
    const reference = `文件：${path}${quote ? `\n\n${quote.split('\n').map(line => `> ${line}`).join('\n')}` : ''}`;
    setDraft(previous => `${previous}${previous.trim() ? '\n\n' : ''}${reference}\n\n`);
    setPane('chat');
    requestAnimationFrame(() => composer.current?.focus());
  };
  const composer = useRef(null);
  const chat = useRef(null);
  const stick = useRef(true);
  const refresh = () => api(endpoint(id)).then(setSession);
  useEffect(() => { let live = true; const load = () => api(endpoint(id)).then(v => { if (live) { setSession(v); setError(''); } }).catch(e => { if (live) setError(e.message); }); load(); const unsubscribe = subscribeFactoryEvents({ onMessage: e => { const v = JSON.parse(e.data); if (v.sessionId !== id) return; if (v.type === 'delta') setStream(t => t + v.text); if (v.type === 'message' || v.type === 'state') { setStream(''); load(); } if (v.type === 'tool') setActivity(`正在调用 ${v.name}`); if (v.type === 'thinking') setActivity('正在思考'); if (v.type === 'compacting') setActivity('正在整理上下文'); if (v.type === 'tool_end') setActivity(v.isError ? `${v.name} 返回错误，Agent 正在处理` : '继续工作'); if (['files', 'progress', 'comments'].includes(v.type)) load(); }, onError: () => { if (live) setActivity('连接中断，正在重新连接'); }, onOpen: () => { if (live) { setActivity(''); setStream(''); load(); } } }); return () => { live = false; unsubscribe(); }; }, [id]);
  useEffect(() => { sessionStorage.setItem(`factory-draft:${id}`, draft); }, [id, draft]);
  useEffect(() => { if (stick.current && chat.current) chat.current.scrollTop = chat.current.scrollHeight; }, [stream, s?.messages.length]);
  const perform = async fn => { setError(''); setBusy(true); try { await fn(); await refresh(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); } };
  const submit = e => { e.preventDefault(); const content = draft; perform(async () => { await api(endpoint(id, 'message'), { method: 'POST', body: { content } }); setDraft(''); stick.current = true; setActivity('正在思考'); }); };
  const upload = files => perform(async () => { for (const f of files) { if (f.size > 20 * 1024 * 1024) throw new Error(`${f.name} 超过 20 MiB`); const bytes = new Uint8Array(await f.arrayBuffer()); let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(id, 'files'), { method: 'POST', body: { path: `input/${f.name}`, base64: btoa(text), mimeType: f.type || undefined } }); } });
  if (!s) return <section className="welcome">正在读取工作区…<ErrorNotice error={error}/></section>;
  const running = s.status === 'running';
  return <><div className="workspace-switch" role="tablist" aria-label="工作区面板"><button role="tab" aria-selected={pane === 'chat'} onClick={() => setPane('chat')}>聊天</button><button role="tab" aria-selected={pane === 'files'} onClick={() => setPane('files')}>文件 <span>{s.files.length}</span></button><span className="pane-state">{running ? '正在工作' : STATUS[s.status]}{s.progress.status === 'ready' ? ` · ${s.progress.percentage}%` : ''}</span></div><section className="chat-panel" data-active={pane === 'chat'}><div className="workspace-heading"><div><h1>{ROLES.find(r => r[0] === s.role)?.[1]}</h1><span className={running ? 'status running' : 'status'}>{STATUS[s.status]}</span></div><button className="text-button" onClick={() => perform(async () => setPrompt((await api(endpoint(id, 'prompt'))).content))}>查看 Prompt</button></div>
    <Binding s={s} config={config} perform={perform}/><div className="progress-row"><span>任务完成度</span><strong>{s.progress.status === 'ready' ? `${s.progress.percentage}%` : '待报告'}</strong><progress max="100" value={s.progress.percentage ?? 0} aria-label="任务完成度"/>{s.progress.status !== 'ready' && s.progress.percentage !== null && <small>上轮 {s.progress.percentage}%</small>}</div>
    <div className="chat-log" ref={chat} onScroll={() => { const e = chat.current; stick.current = e.scrollHeight - e.scrollTop - e.clientHeight < 80; }}>
    {!s.messages.length && <div className="chat-empty"><h2>开始聊天</h2></div>}
    {chatEntries(s.messages).map(entry => entry.type === 'tool' ? <ToolMessage key={entry.key} call={entry.call} result={entry.result} running={running}/> : <Message key={entry.key} message={entry.message} files={s.files} onOpenFile={openFile}/>)}{stream && <article className="message assistant"><span className="message-role">Agent</span><Markdown files={s.files} onOpenFile={openFile}>{stream}</Markdown></article>}{running && <p className="activity" role="status">{activity || (s.activeTool ? `正在调用 ${s.activeTool}` : '正在工作')}</p>}
    </div><ErrorNotice error={error || s.error}/><form className="composer" onSubmit={submit}><textarea ref={composer} aria-label="给 Agent 的消息" placeholder="说明目标，或继续提出修改意见…" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !running && draft.trim()) submit(e); }}/><div><small>⌘ / Ctrl + Enter 发送</small>{running ? <Button type="button" variant="secondary" onClick={() => perform(() => api(endpoint(id, 'stop'), { method: 'POST', body: {} }))}>停止</Button> : <Button disabled={busy || !draft.trim() || !config?.services.kimi}>发送</Button>}</div></form></section>
    <section className="files-panel" data-active={pane === 'files'}><div className="section-heading"><h2>文件</h2><span className="muted">{s.files.length} 份文件</span></div><div className="file-trays"><div className="file-tray" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!running && e.dataTransfer.files.length) upload([...e.dataTransfer.files]); }}><div className="section-heading"><strong>附件</strong><label className={`upload ${running ? 'disabled' : ''}`}>＋ 添加文件<input aria-label="上传输入文件" type="file" multiple disabled={running || busy} onChange={e => { upload([...e.target.files]); e.target.value = ''; }}/></label></div>{s.files.filter(f => f.path.startsWith('input/')).map(f => <div className="file-row" key={f.path}><button className="file-link" onClick={() => { setFile(f.path); setPane('files'); }} title={f.path}>{f.path.slice(6)}</button><button className="remove" aria-label={`移除 ${f.path}`} disabled={running} onClick={() => perform(() => api(endpoint(id, 'files'), { method: 'DELETE', body: { path: f.path } }))}>×</button></div>)}{!s.files.some(f => f.path.startsWith('input/')) && <p className="empty-tray">拖入文件</p>}</div><div className="file-tray"><div className="section-heading"><strong>输出</strong></div>{s.files.filter(f => f.path.startsWith('output/')).map(f => <div className="file-row" key={f.path}><input aria-label={`选择 ${f.path}`} type="checkbox" checked={selectedOutputs.includes(f.path)} onChange={e => setSelectedOutputs(v => e.target.checked ? [...v, f.path] : v.filter(p => p !== f.path))}/><button className="file-link" onClick={() => { setFile(f.path); setPane('files'); }} title={f.path}>{f.path.slice(7)}{f.readonly ? ' ◦' : ''}</button></div>)}{!s.files.some(f => f.path.startsWith('output/')) && <p className="empty-tray">暂无文件</p>}</div></div>
    <div className="handoff"><select aria-label="接收输出的工作区" value={destination} onChange={e => setDestination(e.target.value)}><option value="">发送到聊天…</option>{sessions.filter(v => v.id !== id && v.status !== 'running').map(v => <option key={v.id} value={v.id}>{v.title}</option>)}</select><Button variant="secondary" size="compact" disabled={busy || !destination || !selectedOutputs.length} onClick={() => perform(async () => { const files = s.files.filter(f => selectedOutputs.includes(f.path)).map(({ path }) => ({ path })); await api(endpoint(destination, 'transfer'), { method: 'POST', body: { fromSessionId: id, files } }); setSelectedOutputs([]); })}>发送 {selectedOutputs.length || ''} 份文件</Button></div>
    {file && s.files.some(f => f.path === file) ? <FileViewer key={file} id={id} record={s.files.find(f => f.path === file)} comments={s.comments} perform={perform} files={s.files} onOpenFile={openFile} onAddToChat={addToChat}/> : <div className="document-empty"><p>选择文件</p></div>}
    </section>{prompt !== null && <div className="modal-backdrop"><section className="prompt-modal" role="dialog" aria-modal="true" aria-label="System Prompt"><div className="section-heading"><h2>System Prompt</h2><Button variant="secondary" onClick={() => setPrompt(null)}>关闭</Button></div><pre>{prompt}</pre></section></div>}</>;
}
function Message({ message: m, files, onOpenFile }) {
  const text = typeof m.content === 'string' ? m.content : m.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (!text) return null;
  return <article className={`message ${m.role}`}><span className="message-role">{m.role === 'user' ? '你' : 'Agent'}</span><Markdown files={files} onOpenFile={onOpenFile}>{text}</Markdown></article>;
}
function ToolMessage({ call, result, running }) {
  const [open, setOpen] = useState(false);
  const status = result ? (result.isError ? '失败' : '已返回') : (running ? '调用中' : '未返回');
  return <details className={`tool-message ${result?.isError ? 'error' : ''}`} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{call?.name || result?.toolName} · {status}</summary>
    {open && <>{call && <><small>参数</small><pre>{JSON.stringify(call.arguments, null, 2)}</pre></>}{result && <><small>结果</small><pre>{typeof result.content === 'string' ? result.content : result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n')}</pre></>}</>}
  </details>;
}
function Binding({ s, config, perform }) {
  const [targets, setTargets] = useState([]);
  const [notice, setNotice] = useState('');
  const refresh = async () => { try { const value = await api('/v1/creator/factory-agents/evaluation-targets'); setTargets(value.targets); setNotice(value.unavailable || ''); } catch (e) { setNotice(e.message); } };
  useEffect(() => { if (s.role === 'evaluator' && config?.services.hatch) refresh(); }, [s.role, config?.services.hatch]);
  if (s.role === 'generation') return <div className="binding">{s.corpus ? 'Agent 已发布' : 'Agent 尚未发布'}</div>;
  if (s.role !== 'evaluator') return null;
  return <div className="binding"><select aria-label="选择要测的 Agent" value={s.target?.productId || ''} disabled={s.status === 'running' || !!s.hatch} onChange={e => { const selected = targets.find(t => t.productId === e.target.value); if (selected) perform(() => api(endpoint(s.id, 'target'), { method: 'PUT', body: { entitlementId: selected.entitlementId, productId: selected.productId } })); }}><option value="">选择要测的 Agent…</option>{targets.map(t => <option key={t.productId} value={t.productId} disabled={!t.available}>{t.name}</option>)}</select><button className="text-button" onClick={refresh}>刷新</button>{notice && <p className="muted">{notice}</p>}</div>;
}
function FileViewer({ id, record, comments, perform, files, onOpenFile, onAddToChat }) {
  const draftKey = `factory-file-draft:${id}:${record.path}`;
  const [savedDraft] = useState(() => { try { return JSON.parse(sessionStorage.getItem(draftKey) || 'null'); } catch { return null; } });
  const [file, setFile] = useState(savedDraft?.file || null);
  const [mode, setMode] = useState(savedDraft ? 'edit' : 'read');
  const [edit, setEdit] = useState(savedDraft?.edit || '');
  const [selection, setSelection] = useState(null);
  const [comment, setComment] = useState('');
  const [replacement, setReplacement] = useState('');
  const [error, setError] = useState('');
  const [copyName, setCopyName] = useState(savedDraft?.copyName || '');
  const dirty = mode === 'edit' && edit !== file?.content;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!file) return;
    try {
      if (dirty) sessionStorage.setItem(draftKey, JSON.stringify({ file, edit, copyName }));
      else sessionStorage.removeItem(draftKey);
    } catch { setError('无法保存本地草稿，请在离开前保存文件。'); }
  }, [draftKey, file, edit, copyName, dirty]);
  useEffect(() => {
    const warn = e => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const load = async () => { const f = await api(`${endpoint(id, 'files')}?path=${encodeURIComponent(record.path)}`); if (!dirtyRef.current) { setFile(f); setEdit(f.content || ''); setSelection(null); } };
  useEffect(() => { load().catch(e => setError(e.message)); }, [id, record]);
  const save = () => perform(async () => { const target = record.readonly || record.path.startsWith('input/') ? `output/${copyName}` : record.path; if (!target.endsWith('.md') || target.includes('..')) throw new Error('请填写 .md 文件名'); const bytes = new TextEncoder().encode(edit); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await api(endpoint(id, 'files'), { method: 'POST', body: { path: target, base64: btoa(binary) } }); dirtyRef.current = false; sessionStorage.removeItem(draftKey); setEdit(file.content || ''); setMode('read'); if (target === record.path) await load(); });
  if (!file) return <div className="document-empty">读取文件…<ErrorNotice error={error}/></div>;
  const related = comments.filter(c => c.path === record.path);
  const lines = file.content?.match(/[^\n]*\n|[^\n]+$/g) || [];
  let offset = 0;
  const rows = lines.map((text, i) => { const start = offset; offset += text.length; return { start, end: offset, text, number: i + 1 }; });
  return <div className="document"><div className="document-toolbar"><strong title={record.path}>{record.path.split('/').at(-1)}</strong><Button size="compact" variant="ghost" onClick={() => onAddToChat(record.path, mode === 'lines' && selection ? file.content.slice(selection.start, selection.end) : undefined)}>{mode === 'lines' && selection ? '引用到聊天' : '加入聊天'}</Button><a href={`${endpoint(id, 'files')}?path=${encodeURIComponent(record.path)}&download=1`}>下载</a></div><div className="document-tabs">{[['read', '阅读'], ['lines', '逐行批注'], ['edit', record.readonly || record.path.startsWith('input/') ? '编写修订副本' : '编辑']].map(([value, label]) => <button key={value} disabled={dirty && value !== 'edit'} className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{label}</button>)}</div><ErrorNotice error={error}/>
    <div className="document-content">{file.content === null ? <p>请下载查看此文件。</p> : mode === 'read' ? <Markdown filePath={record.path} files={files} onOpenFile={onOpenFile}>{file.content}</Markdown> : mode === 'edit' ? <><textarea className="editor" aria-label="Markdown 编辑器" value={edit} onChange={e => setEdit(e.target.value)}/>{(record.readonly || record.path.startsWith('input/')) && <input aria-label="修订副本文件名" placeholder="建议修订.md" value={copyName} onChange={e => setCopyName(e.target.value)}/>}<div className="edit-actions"><Button size="compact" onClick={save}>保存</Button><Button size="compact" variant="secondary" onClick={() => { setEdit(file.content); setMode('read'); }}>放弃编辑</Button></div></> : <><p className="muted">点击一行选择；按住 Shift 点击另一行，选择多行。</p><div className="source-lines">{rows.map(r => <button key={r.number} className={selection && r.start >= selection.start && r.end <= selection.end ? 'line selected-line' : 'line'} onClick={e => setSelection(e.shiftKey && selection ? { start: Math.min(selection.start, r.start), end: Math.max(selection.end, r.end) } : { start: r.start, end: r.end })}><span className="line-number">{r.number}</span><span>{r.text.replace(/\n$/, '') || ' '}</span></button>)}</div>{selection && <form className="comment-form" onSubmit={e => { e.preventDefault(); perform(async () => { await api(endpoint(id, 'comments'), { method: 'POST', body: { path: record.path, ...selection, quote: file.content.slice(selection.start, selection.end), text: comment, ...(replacement ? { replacement } : {}) } }); setComment(''); setReplacement(''); setSelection(null); }); }}><blockquote>{file.content.slice(selection.start, selection.end)}</blockquote><textarea aria-label="批注意见" placeholder="这几行哪里需要改进？" value={comment} onChange={e => setComment(e.target.value)} required/><textarea aria-label="建议替换文本" placeholder="建议替换文本（可选）" value={replacement} onChange={e => setReplacement(e.target.value)}/><Button size="compact" disabled={!comment.trim()}>保存批注</Button></form>}</>}
    {related.length > 0 && <section className="comments"><div className="section-heading"><h3>批注 · {related.length}</h3><Button size="compact" variant="secondary" onClick={() => perform(() => api(endpoint(id, 'comments/export'), { method: 'POST', body: {} }))}>导出 REVIEW.md</Button></div>{related.map(c => <article key={c.id}><blockquote>{c.quote}</blockquote><p>{c.text}</p>{c.replacement && <pre>{c.replacement}</pre>}</article>)}</section>}</div></div>;
}
