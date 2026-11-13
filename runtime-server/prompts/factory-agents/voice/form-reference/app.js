/*
  REFERENCE SCRIPT. The published page must be ONE self-contained html file:
  paste this whole file into the <script> tag of index.html (no src, no external requests).
  Only use window.hatch: schema, answers, status, save(id, value), clear(id), submit().
  Replace the EXAMPLE data below with the real content; delete a block you do not need.
  Questions are rendered entirely from hatch.schema, never hard-code them here.
*/

// EXAMPLE placeholder for the "Agent 介绍" section. Replace with the real content, or set INTRO = [] to drop the section.
// Each block: { h: 小标题, items?: [要点], say?: [Agent 原话], compare?: { bad, good } }
const INTRO = [
  { h: '它做什么', items: ['（示例）一两句话说明这个 Agent 替专家做什么'] },
  { h: '怎么说话', say: ['（示例）Agent 会这么说'], compare: { bad: '（示例）不好的说法', good: '（示例）好的说法' } },
];

// EXAMPLE placeholder for the "知识缺口" section: facts the expert should supply. Replace, or set GAPS = [] to drop it.
const GAPS = [
  { h: '（示例）缺口标题', items: ['（示例）需要专家补充的事实'] },
];

const hatch = window.hatch;
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const NOTE = id => id + '__note';
const questions = hatch.schema.questions;
const sections = [
  INTRO.length && { id: 'intro', title: 'Agent 介绍', blocks: INTRO },
  GAPS.length && { id: 'gaps', title: '知识缺口', blocks: GAPS, count: GAPS.length },
  questions.length && { id: 'questions', title: '待回答问题', count: questions.length },
].filter(Boolean);

// One field per stored answer id: { id, read(), write(value), base }. base = last value known to be stored.
const fields = [];
let saving = false, timer = 0, submitted = hatch.status === 'submitted';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = v => v == null || v === '' || (Array.isArray(v) && !v.length);
const pending = () => fields.filter(f => !same(f.read(), f.base));

function showError(message) { $('error').textContent = message || ''; $('error').hidden = !message; }

function refresh() {
  const n = pending().length;
  $('save').disabled = submitted || saving || !n;
  $('save').textContent = saving ? '保存中…' : n ? `保存（${n} 题有修改）` : '已保存';
  $('submit').disabled = submitted || saving;
}

// Saves only the changed fields; stops at the first failure and keeps what was typed.
async function saveChanged() {
  clearTimeout(timer);
  if (saving) return false;
  saving = true; showError(''); refresh();
  try {
    for (const f of pending()) {
      const value = f.read();
      if (isEmpty(value)) await hatch.clear(f.id); else await hatch.save(f.id, value);
      f.base = value;
    }
    return true;
  } catch (e) {
    showError(e && e.message ? e.message : '保存失败，请再试一次');
    return false;
  } finally { saving = false; refresh(); }
}

const changed = () => { clearTimeout(timer); timer = setTimeout(saveChanged, 1500); refresh(); };

function textField(id, placeholder) {
  const box = el('textarea');
  box.placeholder = placeholder;
  box.maxLength = 12000;
  box.setAttribute('aria-label', placeholder);
  box.addEventListener('input', changed);
  const f = { id, node: box, read: () => box.value, write: v => { box.value = v || ''; }, base: '' };
  f.write(hatch.answers[id]); f.base = f.read();
  fields.push(f);
  return f;
}

function optionsField(q) {
  const multi = q.type === 'multi';
  const set = el('fieldset', 'options');
  const inputs = (q.options || []).map(opt => {
    const label = el('label', 'option');
    const input = el('input');
    input.type = multi ? 'checkbox' : 'radio';
    input.name = 'q-' + q.id;
    input.value = opt;
    input.addEventListener('change', changed);
    label.append(input, el('span', '', opt));
    set.append(label);
    return input;
  });
  const read = () => multi ? inputs.filter(i => i.checked).map(i => i.value) : (inputs.find(i => i.checked) || {}).value || '';
  const write = v => inputs.forEach(i => { i.checked = multi ? (v || []).includes(i.value) : i.value === v; });
  const f = { id: q.id, node: set, read, write, base: null };
  write(hatch.answers[q.id]); f.base = read();
  fields.push(f);
  return f;
}

function renderQuestion(q) {
  const card = el('article', 'q');
  card.id = q.id;
  const head = el('div', 'q-head');
  head.append(el('span', 'q-id', q.id), el('h3', '', q.title));
  card.append(head);
  if (q.scenario) card.append(el('p', 'scenario', '背景：' + q.scenario));
  card.append(el('p', 'prompt', q.prompt));
  const mine = q.type === 'open'
    ? [textField(q.id, '在这里填写')]
    : [optionsField(q), textField(NOTE(q.id), '补充说明（可不填）')];
  mine.forEach(f => card.append(f.node));
  const clear = el('button', 'clear', '清除这题');
  clear.type = 'button';
  clear.addEventListener('click', () => { mine.forEach(f => f.write(Array.isArray(f.base) ? [] : '')); changed(); });
  card.append(clear);
  return card;
}

function renderBlocks(blocks) {
  const frag = document.createDocumentFragment();
  for (const b of blocks) {
    const card = el('section', 'paper');
    card.append(el('h3', '', b.h));
    if (b.items) { const ul = el('ul'); b.items.forEach(t => ul.append(el('li', '', t))); card.append(ul); }
    if (b.say) { const p = el('p'); b.say.forEach(t => p.append(el('span', 'say', '「' + t + '」'))); card.append(p); }
    if (b.compare) {
      const row = el('div', 'example');
      const bad = el('div'); bad.append(el('b', '', '不好的说法'), document.createTextNode(b.compare.bad));
      const good = el('div', 'good'); good.append(el('b', '', '好的说法'), document.createTextNode(b.compare.good));
      row.append(bad, good); card.append(row);
    }
    frag.append(card);
  }
  return frag;
}

function renderSection(s) {
  const page = el('section'); page.id = s.id; page.hidden = true;
  page.append(el('h1', '', s.title));
  if (s.blocks) { page.append(renderBlocks(s.blocks)); return page; }
  let group = null;
  for (const q of questions) {
    if (q.group && q.group !== group) { group = q.group; page.append(el('h2', '', group)); }
    page.append(renderQuestion(q));
  }
  return page;
}

function show(id) {
  sections.forEach(s => { $(s.id).hidden = s.id !== id; $('tab-' + s.id).classList.toggle('active', s.id === id); });
  $('btns').hidden = submitted || id !== 'questions';
  window.scrollTo(0, 0);
}

function lock() {
  submitted = true;
  document.querySelectorAll('textarea,input').forEach(n => { n.disabled = true; });
  document.querySelectorAll('.clear').forEach(n => n.remove());
  $('btns').hidden = true; showError(''); $('done').hidden = false;
}

async function submit() {
  if (!(await saveChanged())) return;
  $('submit').disabled = true;
  try { await hatch.submit(); lock(); }
  catch (e) { showError(e && e.message ? e.message : '提交失败，请再试一次'); refresh(); }
}

sections.forEach(s => {
  const tab = el('button', 'nav-link'); tab.type = 'button'; tab.id = 'tab-' + s.id;
  tab.append(el('span', '', s.title));
  if (s.count) tab.append(el('span', 'badge', String(s.count)));
  tab.addEventListener('click', () => show(s.id));
  $('toc').append(tab);
  $('main').append(renderSection(s));
});
$('side').hidden = sections.length < 2;
$('save').addEventListener('click', saveChanged);
$('submit').addEventListener('click', submit);
refresh();
show(sections.length ? sections[0].id : '');
if (submitted) lock();
