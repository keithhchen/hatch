import { describe, expect, it, vi } from "vitest";
import { bridgeConversationHistory, drainConversationJournal, mergeConversationPage, validateHistoryPage, validateSnapshotPage } from "./conversation-pagination.js";
import { getConversationHistoryPage, getConversationJournalPage, getConversationSnapshot, getConversationToolDetail } from "./conversation-client.js";

const row = (id, extra = {}) => ({ id, role: "assistant", content: id, ...extra });
const projected = (id, runId, extra = {}) => row(id, { metadata: { custom: { runId } }, ...extra });
const event = (cursor) => ({ cursor, type: "run.state", run_id: "run_a", payload: { status: "completed" } });
const journal = (cursor, has_more, events = [event(cursor)]) => ({ cursor, has_more, through_cursor: 9, events, runs: [{ id: "run_a" }] });

describe("Conversation page protocol", () => {
  it("bridges local turns 1–25 to remote 26–55 before accepting the recovery boundary", async () => {
    const turns = Array.from({ length: 55 }, (_, i) => row(`turn_${i + 1}`));
    const baseline = turns.slice(0, 25);
    const snapshot = { messages: turns.slice(30), has_more: true, before_cursor: "before31", cursor: 110 };
    const read = vi.fn(async () => ({ messages: turns.slice(5, 30), has_more: true, before_cursor: "before6" }));
    const bridged = await bridgeConversationHistory(snapshot, baseline, read);
    expect(read).toHaveBeenCalledWith({ beforeCursor: "before31" });
    expect(mergeConversationPage(baseline, bridged.messages)).toEqual(turns);
    expect(bridged.cursor).toBe(110);
  });

  it("does not commit a partial bridge when a page fails or the Conversation changes", async () => {
    const snapshot = { messages: [row("latest")], has_more: true, before_cursor: "older" };
    await expect(bridgeConversationHistory(snapshot, [row("old")], async () => { throw new Error("Offline"); })).rejects.toThrow("Offline");
    expect(await bridgeConversationHistory(snapshot, [row("old")], async () => ({ messages: [row("old")], has_more: false }), () => false)).toBeNull();
  });

  it("replaces an unchanged running partial with its durable terminal message", () => {
    const partial = projected("run_a_assistant", "run_a", { status: { type: "running" }, content: "partial" });
    const final = projected("server_a", "run_a", { status: { type: "complete" }, content: "final" });
    expect(mergeConversationPage([partial], [final], { baseline: [partial] })).toEqual([final]);
    const changed = { ...partial, content: "newer live text" };
    expect(mergeConversationPage([changed], [final], { baseline: [partial] })).toEqual([changed]);
  });
  it("accepts an omitted terminal cursor, but requires IDs and an advancing history boundary", () => {
    expect(validateHistoryPage({ messages: [row("a")], has_more: false }).messages).toHaveLength(1);
    for (const page of [
      { messages: [row("a")], has_more: true },
      { messages: [row("a"), row("a")], has_more: false },
      { messages: [{ role: "assistant" }], has_more: false },
      { messages: [], has_more: true, before_cursor: "older" }
    ]) expect(() => validateHistoryPage(page)).toThrow();
    expect(() => validateSnapshotPage({ messages: [], events: [event(1)], runs: [], has_more: false, cursor: 1 })).toThrow();
  });

  it("keeps older pages and inserts refreshed records before live rows received in flight", () => {
    const old = row("old"), latest = row("latest"), live = row("live");
    const updated = row("latest", { content: "canonical" });
    expect(mergeConversationPage([old, latest, live], [updated, row("new")], { baseline: [old, latest] }))
      .toEqual([old, updated, row("new"), live]);
    expect(mergeConversationPage([old, updated], [row("older"), row("old")], { older: true }))
      .toEqual([row("older"), old, updated]);
  });

  it("preserves changed streaming rows, then replaces completed optimistic aliases without duplicates", () => {
    const optimistic = projected("run_a_assistant", "run_a");
    const streamed = { ...optimistic, content: "in flight" };
    const durable = projected("server_a", "run_a");
    expect(mergeConversationPage([streamed], [durable], { baseline: [optimistic] })).toEqual([streamed]);
    expect(mergeConversationPage([streamed], [durable])).toEqual([durable]);
    expect(mergeConversationPage([optimistic, durable], [durable])).toEqual([durable]);
    expect(mergeConversationPage([optimistic], [projected("earlier_a", "run_a"), durable]))
      .toEqual([projected("earlier_a", "run_a"), durable]);
  });

  it("drains sparse journal pages with one fixed watermark without executing events", async () => {
    const read = vi.fn().mockResolvedValueOnce(journal(4, true)).mockResolvedValueOnce(journal(9, false));
    expect(await drainConversationJournal(read, 1)).toBe(9);
    expect(read.mock.calls.map(([options]) => options)).toEqual([
      { afterCursor: 1, throughCursor: undefined }, { afterCursor: 4, throughCursor: 9 }
    ]);
  });

  it("rejects stalled, changed-boundary and incomplete journals; stale reads cannot advance", async () => {
    await expect(drainConversationJournal(async () => journal(1, true, []), 1)).rejects.toThrow();
    await expect(drainConversationJournal(async () => journal(4, false), 1)).rejects.toThrow();
    const changed = vi.fn().mockResolvedValueOnce(journal(4, true))
      .mockResolvedValueOnce({ ...journal(9, false), through_cursor: 10 });
    await expect(drainConversationJournal(changed, 1)).rejects.toThrow();
    expect(await drainConversationJournal(async () => journal(9, false), 1, () => false)).toBeNull();
  });

  it("sends scoped page requests, preserving opaque cursors and the fixed journal watermark", async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const args = ["ws://localhost:8787", "token", { entitlementId: "ent_1" }, "conv_a"];
    await getConversationSnapshot(...args, 99, fetch);
    await getConversationHistoryPage(...args, { beforeCursor: "opaque+/=?" }, fetch);
    await getConversationJournalPage(...args, { afterCursor: 4, throughCursor: 9 }, fetch);
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls[0].searchParams.get("view")).toBe("page");
    expect(urls[0].searchParams.has("after_cursor")).toBe(false);
    expect(urls[1].searchParams.get("before_cursor")).toBe("opaque+/=?");
    expect(urls[1].searchParams.get("limit")).toBe("50");
    expect(urls[2].searchParams.get("through_cursor")).toBe("9");
    expect(urls[2].searchParams.get("limit")).toBe("100");
    for (const [url, options] of fetch.mock.calls) {
      expect(new URL(url).searchParams.get("entitlement_id")).toBe("ent_1");
      expect(options.headers.authorization).toBe("Bearer token");
    }
  });

  it("reads authorized tool details, propagating failures for explicit retry", async () => {
    const tool = { tool_call_id: "call/1", arguments: { command: "pwd" }, result: { stdout: "/work" } };
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({ error: { message: "Denied" } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ tool }) });
    const args = ["ws://localhost:8787", "token", { entitlementId: "ent_1" }, "conv_a", { run_id: "run_a", tool_call_id: "call/1" }, fetch];
    await expect(getConversationToolDetail(...args)).rejects.toThrow("Denied");
    expect(await getConversationToolDetail(...args)).toEqual(tool);
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe("/v1/conversations/conv_a/tools/run_a/call%2F1");
  });
});
