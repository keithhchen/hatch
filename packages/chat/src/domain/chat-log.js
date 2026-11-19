import { skillEntry, skillEntryId, skillRunEntry, skillRunEntryId, toolEntry } from "./timeline.js";

/**
 * The one fold over a conversation's public event log. A page of the log (HTTP) and a live frame (socket) are the same
 * events, so opening, resuming and streaming are one code path: `foldLog` is pure, and folding the whole log in one go
 * equals folding it in any chunks. An event at or below `state.position` is ignored (replays and overlaps are free).
 * `projectLog` turns the state into what the thread renders.
 */
export const TERMINAL_RUN_STATUSES = Object.freeze(["completed", "failed", "cancelled", "interrupted"]);
export const ACTIVE_RUN_STATUSES = Object.freeze(["queued", "running", "waiting_for_tool", "waiting_for_approval", "compacting"]);
export const isTerminalRunStatus = status => TERMINAL_RUN_STATUSES.includes(status);

export const emptyLog = () => ({
  position: 0,
  /** Ordered user messages and assistant replies: `{ type: "user" | "reply", ... }`. */
  items: [],
  /** Status by Run id, and the order the Runs were first heard of. */
  runs: {},
  runOrder: [],
  retrying: {},
  superseded: {},
  /** Steered messages the Run has not claimed yet. */
  queued: [],
  openCompactions: [],
  compactions: [],
  /** How many reply segments each Run has so far. */
  segments: {}
});

const replace = (items, index, item) => items.map((entry, at) => at === index ? item : entry);

/** The reply the next part of this Run belongs to: the last item when it is this Run's reply, else a new one (the Run went on after a message). */
function replyFor(state, runId, at, id) {
  const last = state.items.at(-1);
  if (last?.type === "reply" && last.run_id === runId) return { state, index: state.items.length - 1, reply: last };
  const segment = state.segments[runId] ?? 0;
  const reply = { type: "reply", id: id ?? `${runId}-assistant${segment ? `-${segment + 1}` : ""}`, run_id: runId, segment, at, entries: [] };
  return {
    state: { ...state, items: [...state.items, reply], segments: { ...state.segments, [runId]: segment + 1 } },
    index: state.items.length,
    reply
  };
}

const withReply = (state, event, update, id) => {
  const target = replyFor(state, event.run_id, event.at, id);
  const reply = update(target.reply);
  return { ...target.state, items: replace(target.state.items, target.index, reply) };
};

/** Text after a step starts a new entry, set off from the text before it by a paragraph break, as one merged reply read. */
function addText(reply, content, position) {
  const last = reply.entries.at(-1);
  if (last?.kind === "text") return { ...reply, entries: [...reply.entries.slice(0, -1), { ...last, content: last.content + content }] };
  const paragraph = reply.entries.some(entry => entry.kind === "text") ? "\n\n" : "";
  return { ...reply, entries: [...reply.entries, { kind: "text", id: `text-${position}`, content: paragraph + content }] };
}

const openThinking = (reply, index) => reply.entries.findLastIndex(entry => entry.kind === "thinking" && entry.contentIndex === index && entry.streaming);

function addThinking(reply, event, position) {
  const { index, phase, delta = "", content } = event;
  const open = openThinking(reply, index);
  const entries = [...reply.entries];
  const fresh = (text, streaming) => ({ kind: "thinking", id: `thinking-${position}`, contentIndex: index, title: "thinking", content: text, streaming });
  if (phase === "start") {
    // A start heard again begins the step again; the one it replaces stops streaming, so none is left running for good.
    if (open >= 0) entries[open] = { ...entries[open], streaming: false };
    entries.push(fresh("", true));
  } else if (phase === "delta") {
    if (open >= 0) entries[open] = { ...entries[open], content: entries[open].content + delta };
    else entries.push(fresh(delta, true));
  } else if (phase === "end") {
    if (open >= 0) entries[open] = { ...entries[open], content: content ?? entries[open].content, streaming: false };
    else entries.push(fresh(content ?? "", false));
  }
  return { ...reply, entries };
}

/** Upsert a step by its id, in the reply that already holds it (a later one's update of an earlier step) or else the current reply. */
function upsertStep(state, event, id, build) {
  for (let index = state.items.length - 1; index >= 0; index -= 1) {
    const item = state.items[index];
    if (item.type !== "reply" || item.run_id !== event.run_id) continue;
    const at = item.entries.findIndex(entry => entry.id === id);
    if (at >= 0) return { ...state, items: replace(state.items, index, { ...item, entries: replace(item.entries, at, build(item.entries[at])) }) };
  }
  return withReply(state, event, reply => ({ ...reply, entries: [...reply.entries, build(undefined)] }));
}

const stopThinking = (reply) => reply.entries.some(entry => entry.kind === "thinking" && entry.streaming)
  ? { ...reply, entries: reply.entries.map(entry => entry.kind === "thinking" && entry.streaming ? { ...entry, streaming: false } : entry) } : reply;

const knownRun = (state, runId) => state.runs[runId] ? state : { ...state, runs: { ...state.runs, [runId]: {} }, runOrder: [...state.runOrder, runId] };

const attachmentsOf = event => event.attachments?.length ? { attachments: event.attachments } : {};

const HANDLERS = {
  "user.message": (state, event) => {
    if (state.items.some(item => item.type === "user" && item.id === event.id)) return state;
    const item = { type: "user", id: event.id, run_id: event.run_id, content: event.content ?? "", at: event.at, ...attachmentsOf(event) };
    return knownRun({ ...state, items: [...state.items, item], queued: state.queued.filter(entry => entry.id !== event.id) }, event.run_id);
  },
  "message.queued": (state, event) => state.queued.some(entry => entry.id === event.id) || state.items.some(item => item.type === "user" && item.id === event.id)
    ? state : { ...state, queued: [...state.queued, { id: event.id, run_id: event.run_id, content: event.content ?? "", at: event.at, ...attachmentsOf(event) }] },
  "run.state": (state, event) => {
    const known = knownRun(state, event.run_id);
    const run = { ...known.runs[event.run_id], status: event.status, failure: event.failure, finishReason: event.finish_reason, order: event.position };
    const runs = { ...known.runs, [event.run_id]: run };
    if (!isTerminalRunStatus(event.status)) return { ...known, runs };
    return { ...known, runs, items: known.items.map(item => item.type === "reply" && item.run_id === event.run_id ? stopThinking(item) : item) };
  },
  "run.retrying": (state, event) => ({ ...knownRun(state, event.run_id), retrying: { ...state.retrying, [event.run_id]: event.until } }),
  "run.superseded": (state, event) => ({ ...state, superseded: { ...state.superseded, [event.run_id]: event.by } }),
  "assistant.text": (state, event) => event.content ? withReply(knownRun(state, event.run_id), event, reply => addText(reply, event.content, event.position)) : state,
  "assistant.thinking": (state, event) => withReply(knownRun(state, event.run_id), event, reply => addThinking(reply, event, event.position)),
  "tool.call": (state, event) => upsertStep(knownRun(state, event.run_id), event, `tool-${event.tool_call_id}`, previous => toolEntry(event, previous)),
  "skill.activated": (state, event) => upsertStep(state, event, skillEntryId({ ...event, status: "activated" }), () => skillEntry({ ...event, status: event.status ?? "activated" })),
  "skill.invoked": (state, event) => upsertStep(state, event, skillEntryId({ ...event, status: "invoked" }), () => skillEntry({ ...event, status: event.status ?? "invoked" })),
  "skill.run": (state, event) => upsertStep(state, event, skillRunEntryId(event), previous => skillRunEntry(event, previous)),
  // The output guard blocked the reply: none of its words are shown.
  "reply.blocked": (state, event) => ({
    ...state,
    items: state.items.map(item => item.type === "reply" && item.run_id === event.run_id ? { ...item, entries: item.entries.filter(entry => entry.kind !== "text") } : item)
  }),
  "compaction.started": (state, event) => state.openCompactions.includes(event.compaction_id) ? state : { ...state, openCompactions: [...state.openCompactions, event.compaction_id] },
  "compaction.ended": (state, event) => ({
    ...state,
    openCompactions: state.openCompactions.filter(id => id !== event.compaction_id),
    compactions: event.aborted || event.degraded || state.compactions.some(entry => entry.id === `compaction-${event.compaction_id}`)
      ? state.compactions : [...state.compactions, { id: `compaction-${event.compaction_id}`, runId: event.run_id ?? null }]
  }),
  // A reply written before the log carried its parts: it is whole, and read-time only.
  "assistant.reply": (state, event) => {
    let reply = { type: "reply", id: event.id, run_id: event.run_id, segment: state.segments[event.run_id] ?? 0, at: event.at, entries: [], finishReason: event.finish_reason };
    (event.entries ?? []).forEach((entry, index) => {
      const part = `${event.position}-${index}`;
      if (entry.kind === "text") reply = addText(reply, entry.content ?? "", part);
      else if (entry.kind === "thinking") reply = { ...reply, entries: [...reply.entries, { kind: "thinking", id: `thinking-${part}`, contentIndex: index, title: "thinking", content: entry.content ?? "", streaming: false }] };
      else if (entry.kind === "tool") reply = { ...reply, entries: [...reply.entries, toolEntry({ run_id: event.run_id, ...entry.tool }, undefined)] };
      else if (entry.kind === "skill") reply = { ...reply, entries: [...reply.entries, skillEntry({ run_id: event.run_id, ...entry })] };
      else if (entry.kind === "skill_run") reply = { ...reply, entries: [...reply.entries, skillRunEntry({ run_id: event.run_id, ...entry })] };
    });
    return knownRun({ ...state, items: [...state.items, reply], segments: { ...state.segments, [event.run_id]: reply.segment + 1 } }, event.run_id);
  }
};

/** One public event into the log. An event the log already holds (its position at or below the log's) changes nothing. */
export function foldLog(state, event) {
  if (!Number.isFinite(event?.position) || event.position <= state.position) return state;
  const handler = HANDLERS[event.type];
  const next = { ...state, position: event.position };
  return handler ? handler(next, event) : next;
}

/** Events in order (a page of the log). */
export const foldLogEvents = (state, events) => events.reduce(foldLog, state);

/**
 * Earlier turns (folded on their own, from an empty log) join the front of the log. A turn holds its Runs whole, so the
 * two never share a Run; what the later part knows of the earlier Runs (a retry that supersedes one) is kept.
 */
export function mergeOlderLog(state, older) {
  const held = new Set(state.items.filter(item => item.type === "user").map(item => item.id));
  return {
    ...state,
    items: [...older.items.filter(item => item.type !== "user" || !held.has(item.id)), ...state.items],
    runs: { ...older.runs, ...state.runs },
    runOrder: [...older.runOrder.filter(id => !state.runs[id]), ...state.runOrder],
    retrying: { ...older.retrying, ...state.retrying },
    superseded: { ...older.superseded, ...state.superseded },
    segments: { ...older.segments, ...state.segments },
    compactions: [...older.compactions.filter(entry => !state.compactions.some(held => held.id === entry.id)), ...state.compactions]
  };
}

/** A Run the buyer sees as working: it is going, or a restart interrupted it and the server is answering again (not expired). */
const isWorking = (state, runId, now) => {
  const run = state.runs[runId];
  if (!run) return false;
  if (ACTIVE_RUN_STATUSES.includes(run.status)) return true;
  const until = state.retrying[runId] && Date.parse(state.retrying[runId]);
  return run.status === "interrupted" && !state.superseded[runId] && Number.isFinite(until) && until > now;
};

/** Messages rendered from the same item keep their identity, so a view re-renders only what changed. */
const rendered = new WeakMap();
const render = (item, transient) => {
  const cached = rendered.get(item);
  if (cached?.transient === transient) return cached.message;
  const message = item.type === "user"
    ? { id: item.id, renderKey: item.id, run_id: item.run_id, role: "user", content: item.content, timestamp: item.at, ...attachmentsOf(item) }
    : {
      id: item.id, renderKey: item.id, run_id: item.run_id, role: "assistant", segment: item.segment, timestamp: item.at,
      content: item.entries.filter(entry => entry.kind === "text").map(entry => entry.content).join(""),
      timeline: item.entries, ...(item.finishReason ? { finish_reason: item.finishReason } : {}), ...(transient ? { transient: true } : {})
    };
  rendered.set(item, { transient, message });
  return message;
};

/**
 * What the thread shows: user messages and replies in log order (a steered message where its Run took it up), the Run's
 * reply in progress marked `transient`, steered messages not yet taken up last as `queued`, and the state around them.
 */
export function projectLog(state, { now = Date.now() } = {}) {
  const working = state.runOrder.filter(id => isWorking(state, id, now));
  const activeRun = working.reduce((latest, id) => !latest || state.runs[id].order > state.runs[latest].order ? id : latest, null);
  const hidden = id => state.runs[id]?.status === "interrupted" && state.superseded[id];
  const items = state.items.filter(item => item.type !== "reply" || !hidden(item.run_id));
  const last = items.at(-1);
  const messages = items.map((item, index) => render(item, item.type === "reply" && item.run_id === activeRun && index === items.length - 1));
  // The Run is working and has shown nothing since its last message (or the thread holds nothing): the reply that is coming.
  if (activeRun && !(last?.type === "reply" && last.run_id === activeRun)) {
    const segment = state.segments[activeRun] ?? 0;
    messages.push({ id: `${activeRun}-assistant${segment ? `-${segment + 1}` : ""}`, renderKey: `${activeRun}-assistant${segment ? `-${segment + 1}` : ""}`, run_id: activeRun, role: "assistant", segment, content: "", timestamp: new Date(now).toISOString(), transient: true, timeline: [] });
  }
  for (const entry of state.queued) messages.push({ id: entry.id, renderKey: entry.id, run_id: entry.run_id, role: "user", content: entry.content, timestamp: entry.at, state: "queued", ...attachmentsOf(entry) });
  const latest = state.runOrder.at(-1);
  const untils = Object.entries(state.retrying).filter(([id, until]) => state.runs[id]?.status === "interrupted" && !state.superseded[id] && Date.parse(until) > now).map(([, until]) => Date.parse(until));
  return {
    messages,
    activeRun,
    runState: activeRun ? state.runs[activeRun].status : null,
    /** The latest Run ended failed (not answered again): its failure. */
    failed: latest && state.runs[latest].status === "failed" ? { runId: latest, failure: state.runs[latest].failure } : null,
    compacting: state.openCompactions.length > 0 || (activeRun !== null && state.runs[activeRun].status === "compacting"),
    compactions: state.compactions,
    /** Ids of the user messages the log holds, claimed or queued. */
    known: new Set([...items.filter(item => item.type === "user").map(item => item.id), ...state.queued.map(entry => entry.id)]),
    /** When the buyer-visible "working" of an interrupted Run lapses, if one is waiting on it. */
    retryingUntil: untils.length ? Math.min(...untils) : null
  };
}
