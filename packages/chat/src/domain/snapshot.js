/**
 * Durable Conversation snapshot / page reconciliation (protocol 0.8).
 * Canonical rules come from Desktop: validate every page, drain the journal
 * to a fixed boundary, bridge the latest page to the loaded history prefix,
 * include the active run, and let rows changed by the live stream win.
 */
export class ConversationSnapshotError extends Error {
  constructor(message, code = "snapshot_invalid") {
    super(message);
    this.name = "ConversationSnapshotError";
    this.code = code;
  }
}

const invalid = (message = "The Conversation page is invalid.") => { throw new ConversationSnapshotError(message); };

export function assertConversationIdentity(actualConversationId, expectedConversationId, code = "snapshot_invalid") {
  if (typeof expectedConversationId !== "string" || !expectedConversationId || actualConversationId !== expectedConversationId) {
    throw new ConversationSnapshotError("The Conversation identity does not match the requested session.", code);
  }
}

export const TERMINAL_RUN_STATUSES = Object.freeze(["completed", "failed", "cancelled", "interrupted"]);
export const ACTIVE_RUN_STATUSES = Object.freeze(["queued", "running", "waiting_for_tool", "waiting_for_approval"]);
export const isTerminalRunStatus = value => TERMINAL_RUN_STATUSES.includes(String(value || "").trim().toLowerCase());
export const runId = run => String(run?.id ?? run?.run_id ?? "").trim();
export const activeSnapshotRun = snapshot => snapshot.runs?.find(run => ACTIVE_RUN_STATUSES.includes(run.status)) ?? null;

const SNAPSHOT_EVENT_TYPES = new Set(["conversation.created", "conversation.updated", "run.created", "run.state", "message.created"]);

// Runtime JSON key order is not semantic; canonical keys distinguish a true
// idempotent duplicate from a same-cursor event whose payload changed.
export function canonicalValue(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
}

const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Validate the journal portion of a snapshot and return the cursor it proves.
 * A malformed, out-of-order, or unknown event never advances the cursor.
 */
export function reconcileConversationSnapshot(snapshot, { afterCursor = 0 } = {}) {
  if (!isObject(snapshot)) invalid("The Conversation snapshot is invalid.");
  const priorCursor = Number(afterCursor);
  if (!Number.isSafeInteger(priorCursor) || priorCursor < 0) invalid("The Conversation cursor is invalid.");
  const reportedCursor = Number(snapshot.cursor);
  if (!Number.isSafeInteger(reportedCursor) || reportedCursor < priorCursor) invalid("The Conversation snapshot cursor is invalid.");
  if (!Array.isArray(snapshot.messages) || !Array.isArray(snapshot.runs) || !Array.isArray(snapshot.events)) invalid("The Conversation snapshot projection is invalid.");
  if (snapshot.messages.some(message => !isObject(message))) invalid("The Conversation message projection is invalid.");
  if (snapshot.runs.some(run => !isObject(run) || !runId(run))) invalid("The Conversation Run projection is invalid.");
  const runIds = new Set(snapshot.runs.map(runId));
  const fingerprints = new Map();
  const events = [];
  let previousCursor = priorCursor;
  for (const event of snapshot.events) {
    if (!isObject(event)) invalid("The Conversation journal is invalid.");
    const cursor = Number(event.cursor);
    if (!Number.isSafeInteger(cursor) || cursor <= 0) invalid("The Conversation journal cursor is invalid.");
    if (cursor <= priorCursor) continue; // already covered by a retried request
    const fingerprint = canonicalValue(event);
    if (fingerprints.has(cursor)) {
      if (fingerprints.get(cursor) !== fingerprint) invalid("The Conversation journal repeats a cursor with different data.");
      continue;
    }
    if (cursor < previousCursor) invalid("The Conversation journal is out of order.");
    if (!SNAPSHOT_EVENT_TYPES.has(String(event.type || ""))) invalid("The Conversation journal contains an unknown event.");
    const eventRunId = String(event.run_id ?? event.runId ?? "").trim();
    if (eventRunId && !runIds.has(eventRunId)) invalid("The Conversation journal references an unknown Run.");
    if (!isObject(event.payload)) invalid("The Conversation journal payload is invalid.");
    fingerprints.set(cursor, fingerprint);
    previousCursor = cursor;
    events.push(event);
  }
  if (events.length && previousCursor > reportedCursor) invalid("The Conversation journal exceeds its snapshot cursor.");
  return {
    messages: snapshot.messages,
    runs: snapshot.runs,
    events,
    cursor: reportedCursor,
    ...(snapshot.conversation?.brief_snapshot ? { brief_snapshot: snapshot.conversation.brief_snapshot } : {})
  };
}

export function validateHistoryPage(page) {
  if (!page || !Array.isArray(page.messages) || typeof page.has_more !== "boolean"
    || (page.before_cursor != null && typeof page.before_cursor !== "string")
    || (page.has_more && (!page.before_cursor || !page.messages.length))) invalid();
  const ids = new Set();
  for (const message of page.messages) {
    if (!message || typeof message.id !== "string" || !message.id.trim()
      || !["user", "assistant"].includes(message.role) || ids.has(message.id)) invalid();
    ids.add(message.id);
  }
  return page;
}

/** A `view=page` snapshot carries the latest history page and no journal events. */
export function validateSnapshotPage(page, afterCursor = 0) {
  validateHistoryPage(page);
  if (!Array.isArray(page.events) || page.events.length) invalid();
  reconcileConversationSnapshot(page, { afterCursor });
  return page;
}

/**
 * Read a fixed journal boundary. Events are integrity evidence only: never
 * dispatch them to a tool executor. Commit the cursor with the snapshot.
 */
export async function drainConversationJournal(readPage, afterCursor, isCurrent = () => true) {
  let cursor = afterCursor;
  let throughCursor;
  do {
    const page = await readPage({ afterCursor: cursor, throughCursor });
    if (!isCurrent()) return null;
    if (!Number.isSafeInteger(page.through_cursor) || page.through_cursor < cursor
      || (throughCursor !== undefined && page.through_cursor !== throughCursor)
      || typeof page.has_more !== "boolean") invalid();
    throughCursor = page.through_cursor;
    const reconciled = reconcileConversationSnapshot({ ...page, messages: [] }, { afterCursor: cursor });
    if (reconciled.cursor > throughCursor || (page.has_more && reconciled.cursor <= cursor)
      || (!page.has_more && reconciled.cursor !== throughCursor)) invalid();
    cursor = reconciled.cursor;
    if (!page.has_more) return cursor;
  } while (isCurrent());
  return null;
}

/** Rows the client created before the Runtime confirmed them. */
export const isPlaceholderMessage = message => Boolean(message?.optimistic || message?.provisional || message?.transient);
const placeholderAlias = message => message?.run_id ? `${message.run_id}:${message.role}` : null;

/**
 * A latest-page refresh must meet the loaded prefix, or it would leave an
 * unreachable middle gap behind the prefix's existing oldest-page cursor.
 */
export async function bridgeConversationHistory(snapshot, baseline, readPage, isCurrent = () => true) {
  const boundary = baseline.findLast(message => !isPlaceholderMessage(message));
  if (!boundary) return snapshot;
  let page = snapshot;
  let messages = [...snapshot.messages];
  const seen = new Set(messages.map(message => message.id));
  const cursors = new Set();
  while (!seen.has(boundary.id) && page.has_more) {
    if (!page.before_cursor || cursors.has(page.before_cursor)) invalid();
    cursors.add(page.before_cursor);
    page = validateHistoryPage(await readPage({ beforeCursor: page.before_cursor }));
    if (!isCurrent()) return null;
    const older = page.messages.filter(message => !seen.has(message.id));
    older.forEach(message => seen.add(message.id));
    messages = [...older, ...messages];
  }
  return { ...snapshot, messages };
}

export async function includeActiveConversationRun(snapshot, activeRunId, readRun, isCurrent = () => true) {
  if (!activeRunId || snapshot.runs.some(run => runId(run) === activeRunId)) return snapshot;
  const run = await readRun(activeRunId);
  if (!isCurrent()) return null;
  if (!run || runId(run) !== activeRunId || typeof run.status !== "string") invalid();
  return { ...snapshot, runs: [run, ...snapshot.runs] };
}

const MESSAGE_FIELDS = ["run_id", "role", "content", "timestamp", "attachments", "finish_reason", "parts", "tool_calls", "skill_events", "skill_runs"];
const sameMessage = (left, right) => MESSAGE_FIELDS.every(field => canonicalValue(left[field] ?? null) === canonicalValue(right[field] ?? null));

/**
 * Merge a durable page into the current projection.
 * - Older pages always lose overlaps.
 * - Latest pages replace only rows unchanged since `baseline` (the request
 *   start); rows the live stream changed meanwhile belong to the stream.
 * - A server row replaces its placeholder (same run and role) and inherits
 *   its render key; an unchanged row keeps its object identity.
 * - Loaded history stays before the page; unmatched placeholders and rows
 *   that arrived while the request was in flight stay after it.
 */
export function mergeConversationPage(current, incoming, { older = false, baseline = current } = {}) {
  if (older) {
    const ids = new Set(current.map(message => message.id));
    return [...incoming.filter(message => !ids.has(message.id)), ...current];
  }
  const before = new Set(baseline);
  const byId = new Map(current.map(message => [message.id, message]));
  const placeholders = new Map(current.filter(isPlaceholderMessage).map(message => [placeholderAlias(message), message]));
  const aliasOwners = new Map(incoming.map(message => [placeholderAlias(message), message.id]));
  const consumed = new Set();
  const projected = incoming.map(message => {
    const alias = placeholderAlias(message);
    const existing = byId.get(message.id) ?? (aliasOwners.get(alias) === message.id ? placeholders.get(alias) : undefined);
    if (existing) consumed.add(existing);
    if (existing && !before.has(existing)) return existing;
    if (existing && !isPlaceholderMessage(existing) && sameMessage(existing, message)) return existing;
    return { ...message, renderKey: existing?.renderKey ?? `${message.run_id}:${message.role}` };
  });
  const remaining = current.filter(message => !consumed.has(message));
  const live = message => isPlaceholderMessage(message) || !before.has(message);
  const next = [...remaining.filter(message => !live(message)), ...projected, ...remaining.filter(live)];
  return next.length === current.length && next.every((message, index) => message === current[index]) ? current : next;
}
