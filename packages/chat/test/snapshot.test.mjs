import assert from "node:assert/strict";
import test from "node:test";
import {
  bridgeConversationHistory,
  drainConversationJournal,
  includeActiveConversationRun,
  mergeConversationPage,
  reconcileConversationSnapshot,
  validateHistoryPage,
  validateSnapshotPage
} from "../src/domain/snapshot.js";

function message(overrides = {}) {
  return {
    id: "message-1",
    run_id: "run-1",
    role: "assistant",
    content: "answer",
    timestamp: "2026-10-03T00:00:00.000Z",
    parts: [{ type: "text", start: 0, end: 6 }],
    ...overrides
  };
}
const row = (id, extra = {}) => ({ id, run_id: `run-${id}`, role: "assistant", content: id, ...extra });
const event = cursor => ({ cursor, type: "run.state", run_id: "run_a", payload: { status: "completed" } });
const journal = (cursor, has_more, events = [event(cursor)]) => ({ cursor, has_more, through_cursor: 9, events, runs: [{ id: "run_a" }] });
const calls = (results) => {
  const fn = async options => { fn.calls.push(options); const next = results.shift(); if (next instanceof Error) throw next; return next; };
  fn.calls = [];
  return fn;
};

test("an unchanged page preserves the original array and message objects", () => {
  const current = mergeConversationPage([], [message()]);
  assert.equal(mergeConversationPage(current, [message()]), current);
  assert.equal(mergeConversationPage(current, [message()])[0], current[0]);
});

test("a canonical page promotes optimistic rows while retaining their render keys", () => {
  const optimisticUser = { id: "optimistic-message", renderKey: "run-1-user", run_id: "run-1", role: "user", content: "question", timestamp: "2026-10-03T00:00:00.000Z", optimistic: false, provisional: true };
  const streamedAssistant = { id: "stream-run-1", renderKey: "run-1-assistant", run_id: "run-1", role: "assistant", content: "", timestamp: "2026-10-03T00:00:01.000Z", transient: true, timeline: [] };
  const result = mergeConversationPage([optimisticUser, streamedAssistant], [
    message({ id: "server-user", role: "user", content: "question", parts: undefined }),
    message({ content: "answer", timestamp: "2026-10-03T00:00:02.000Z" })
  ]);
  assert.deepEqual(result.map(entry => entry.renderKey), ["run-1-user", "run-1-assistant"]);
  assert.equal(result[1].transient, undefined);
  assert.equal(result[1].content, "answer");
});

test("a latest page keeps the loaded history prefix before it and in-flight rows after it", () => {
  const old = row("old"), latest = row("latest"), live = row("live");
  const updated = row("latest", { content: "canonical" });
  assert.deepEqual(mergeConversationPage([old, latest, live], [updated, row("new")], { baseline: [old, latest] }).map(entry => [entry.id, entry.content]),
    [["old", "old"], ["latest", "canonical"], ["new", "new"], ["live", "live"]]);
  assert.deepEqual(mergeConversationPage([old, updated], [row("older"), row("old")], { older: true }).map(entry => entry.id), ["older", "old", "latest"]);
});

test("an unmatched placeholder stays after the refreshed page", () => {
  const server = row("server");
  const optimistic = { id: "optimistic-x", run_id: "run-2", role: "user", optimistic: true };
  const stream = { id: "stream-run-2", run_id: "run-2", role: "assistant", transient: true };
  assert.deepEqual(mergeConversationPage([server, optimistic, stream], [server]).map(entry => entry.id), ["server", "optimistic-x", "stream-run-2"]);
});

test("a streaming row changed since the request started wins over the page", () => {
  const partial = { id: "stream-run-a", run_id: "run-a", role: "assistant", transient: true, content: "" };
  const final = { id: "server-a", run_id: "run-a", role: "assistant", content: "final" };
  assert.equal(mergeConversationPage([partial], [final], { baseline: [partial] })[0].id, "server-a");
  const changed = { ...partial, content: "newer live text" };
  assert.deepEqual(mergeConversationPage([changed], [final], { baseline: [partial] }), [changed]);
  assert.deepEqual(mergeConversationPage([partial], [row("earlier", { run_id: "run-a" }), final]).map(entry => entry.id), ["earlier", "server-a"]);
});

test("changed tool state patches the existing message while preserving its render key", () => {
  const current = message({ renderKey: "run-1-assistant", parts: [{ type: "tool_call", tool_call_id: "call-1" }], tool_calls: [{ tool_call_id: "call-1", status: "requested" }] });
  const result = mergeConversationPage([current], [message({ parts: [{ type: "tool_call", tool_call_id: "call-1" }], tool_calls: [{ tool_call_id: "call-1", status: "completed", result: { matches: 2 } }] })]);
  assert.notEqual(result[0], current);
  assert.equal(result[0].renderKey, "run-1-assistant");
  assert.equal(result[0].tool_calls[0].status, "completed");
});

test("bridges local turns 1-25 to remote 26-55 before accepting the recovery boundary", async () => {
  const turns = Array.from({ length: 55 }, (_, index) => row(`turn_${index + 1}`));
  const baseline = turns.slice(0, 25);
  const read = calls([{ messages: turns.slice(5, 30), has_more: true, before_cursor: "before6" }]);
  const bridged = await bridgeConversationHistory({ messages: turns.slice(30), has_more: true, before_cursor: "before31", cursor: 110 }, baseline, read);
  assert.deepEqual(read.calls, [{ beforeCursor: "before31" }]);
  assert.deepEqual(mergeConversationPage(baseline, bridged.messages).map(entry => entry.id), turns.map(entry => entry.id));
  assert.equal(bridged.cursor, 110);
});

test("a partial bridge is never committed when a page fails or the Conversation changes", async () => {
  const snapshot = { messages: [row("latest")], has_more: true, before_cursor: "older" };
  await assert.rejects(bridgeConversationHistory(snapshot, [row("old")], async () => { throw new Error("Offline"); }), /Offline/);
  assert.equal(await bridgeConversationHistory(snapshot, [row("old")], async () => ({ messages: [row("old")], has_more: false }), () => false), null);
});

test("history pages require IDs and an advancing boundary; page snapshots carry no events", () => {
  assert.equal(validateHistoryPage({ messages: [row("a")], has_more: false }).messages.length, 1);
  for (const page of [
    { messages: [row("a")], has_more: true },
    { messages: [row("a"), row("a")], has_more: false },
    { messages: [{ role: "assistant" }], has_more: false },
    { messages: [], has_more: true, before_cursor: "older" }
  ]) assert.throws(() => validateHistoryPage(page));
  assert.throws(() => validateSnapshotPage({ messages: [], events: [event(1)], runs: [], has_more: false, cursor: 1 }));
  assert.throws(() => validateSnapshotPage({ messages: [], events: [], runs: [], has_more: false, cursor: 3 }, 4), { code: "snapshot_invalid" });
});

test("drains sparse journal pages with one fixed watermark", async () => {
  const read = calls([journal(4, true), journal(9, false)]);
  assert.equal(await drainConversationJournal(read, 1), 9);
  assert.deepEqual(read.calls, [{ afterCursor: 1, throughCursor: undefined }, { afterCursor: 4, throughCursor: 9 }]);
});

test("rejects stalled, changed-boundary and incomplete journals; stale reads cannot advance", async () => {
  await assert.rejects(drainConversationJournal(async () => journal(1, true, []), 1));
  await assert.rejects(drainConversationJournal(async () => journal(4, false), 1));
  await assert.rejects(drainConversationJournal(calls([journal(4, true), { ...journal(9, false), through_cursor: 10 }]), 1));
  assert.equal(await drainConversationJournal(async () => journal(9, false), 1, () => false), null);
});

test("journal reconciliation de-duplicates retries and rejects corrupt events", () => {
  const runs = [{ id: "run_1", status: "completed" }];
  const created = { cursor: 2, type: "message.created", run_id: "run_1", payload: {} };
  assert.equal(reconcileConversationSnapshot({ messages: [], runs, events: [event(1), created, created], cursor: 2 }, { afterCursor: 1 }).events.length, 1);
  assert.throws(() => reconcileConversationSnapshot({ messages: [], runs, events: [created, { ...created, payload: { changed: true } }], cursor: 2 }));
  assert.throws(() => reconcileConversationSnapshot({ messages: [], runs, events: [{ ...created, run_id: "run_unknown" }], cursor: 2 }));
  assert.throws(() => reconcileConversationSnapshot({ messages: [], runs, events: [{ ...created, type: "mystery" }], cursor: 2 }));
  assert.throws(() => reconcileConversationSnapshot({ messages: [], runs, events: [{ ...created, cursor: 5 }], cursor: 2 }));
});

test("an active run missing from the page is read and included", async () => {
  const snapshot = { messages: [], runs: [{ id: "run_b", status: "completed" }] };
  assert.equal(await includeActiveConversationRun(snapshot, "run_b", async () => assert.fail()), snapshot);
  const included = await includeActiveConversationRun(snapshot, "run_a", async id => ({ id, status: "running" }));
  assert.deepEqual(included.runs.map(run => run.id), ["run_a", "run_b"]);
  await assert.rejects(includeActiveConversationRun(snapshot, "run_a", async () => ({ id: "run_c", status: "running" })));
});
