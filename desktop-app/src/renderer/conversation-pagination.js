import { reconcileConversationSnapshot } from "./conversation-client.js";

function invalid() {
  throw Object.assign(new Error("The Conversation page is invalid."), { code: "snapshot_invalid" });
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

export function validateSnapshotPage(page, afterCursor = 0) {
  validateHistoryPage(page);
  if (!Array.isArray(page.events) || page.events.length) invalid();
  reconcileConversationSnapshot(page, { afterCursor });
  return page;
}

// Read a fixed journal boundary. Events are integrity evidence only: never
// dispatch them to the live tool executor. Commit the cursor with the snapshot.
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

function optimisticAlias(message) {
  const runId = message.metadata?.custom?.runId;
  return runId ? `${runId}_${message.role}` : null;
}

// Existing objects changed since request start belong to the live stream.
// Older pages always lose overlaps; latest pages replace only unchanged rows.
export function mergeConversationPage(current, incoming, { older = false, baseline = current } = {}) {
  const before = new Map(baseline.map((message) => [message.id, message]));
  if (older) {
    const ids = new Set(current.map((message) => message.id));
    return [...incoming.filter((message) => !ids.has(message.id)), ...current];
  }
  const rows = new Map(current.map((message) => [message.id, message]));
  const aliases = new Map(incoming.map((message) => [optimisticAlias(message), message.id]));
  const consumed = new Set();
  const projected = [];
  for (const message of incoming) {
    const alias = optimisticAlias(message);
    const optimistic = alias && aliases.get(alias) === message.id ? rows.get(alias) : null;
    const existing = optimistic || rows.get(message.id);
    consumed.add(message.id);
    if (optimistic) consumed.add(optimistic.id);
    projected.push(existing && before.get(existing.id) !== existing ? existing : message);
  }
  const remaining = current.filter((message) => !consumed.has(message.id));
  const lastBaselineIndex = current.findLastIndex((message) => before.has(message.id));
  return [...remaining.filter((message) => current.indexOf(message) <= lastBaselineIndex), ...projected,
    ...remaining.filter((message) => current.indexOf(message) > lastBaselineIndex)];
}

// A latest-page refresh must meet the loaded prefix, or it would leave an
// unreachable middle gap behind the prefix's existing oldest-page cursor.
export async function bridgeConversationHistory(snapshot, baseline, readPage, isCurrent = () => true) {
  const boundary = baseline.findLast((message) => message.id !== optimisticAlias(message));
  if (!boundary) return snapshot;
  let page = snapshot;
  let messages = [...snapshot.messages];
  const seen = new Set(messages.map((message) => message.id));
  const cursors = new Set();
  while (!seen.has(boundary.id) && page.has_more) {
    if (!page.before_cursor || cursors.has(page.before_cursor)) invalid();
    cursors.add(page.before_cursor);
    page = validateHistoryPage(await readPage({ beforeCursor: page.before_cursor }));
    if (!isCurrent()) return null;
    const older = page.messages.filter((message) => !seen.has(message.id));
    older.forEach((message) => seen.add(message.id));
    messages = [...older, ...messages];
  }
  return { ...snapshot, messages };
}

export async function includeActiveConversationRun(snapshot, runId, readRun, isCurrent = () => true) {
  if (!runId || snapshot.runs.some((run) => String(run.id ?? run.run_id) === runId)) return snapshot;
  const run = await readRun(runId);
  if (!isCurrent()) return null;
  if (!run || String(run.id ?? run.run_id) !== runId || typeof run.status !== "string") invalid();
  return { ...snapshot, runs: [run, ...snapshot.runs] };
}
