import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { bridgeConversationHistory, drainConversationJournal, includeActiveConversationRun, mergeConversationPage, validateSnapshotPage } from "./conversation-pagination.js";

// Exercise the actual App recovery function with deferred HTTP responses.
// This intentionally cannot invoke a native tool or the WebSocket dispatcher.
const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const recovery = source.slice(source.indexOf("  async function reconcileLiveSnapshot("), source.indexOf("  async function loadOlderHistory("));
function setup() {
  const socket = {};
  const context = {
    connectionConfigRef: { current: { serverUrl: "ws://localhost", conversationId: "conv_a", entitlementId: "ent_a" } },
    socketRef: { current: socket }, connectionTokenRef: { current: 1 },
    conversationCursorRef: { current: 4 }, messagesRef: { current: [{ id: "older", role: "user" }] },
    connectedRef: { current: false }, buyerSession: { accessToken: "token" }, taskBriefRef: { current: null },
    bridgeConversationHistory, drainConversationJournal, includeActiveConversationRun, mergeConversationPage, validateSnapshotPage,
    activeRunRef: { current: null }, getConversationRun: vi.fn(),
    getConversationHistoryPage: vi.fn(async () => ({ messages: [{ id: "older", role: "user" }], has_more: false })),
    getConversationJournalPage: vi.fn(async () => ({ events: [], runs: [], cursor: 4, through_cursor: 4, has_more: false })),
    getConversationSnapshot: vi.fn(async () => ({ messages: [{ id: "latest", role: "user" }], runs: [], events: [], cursor: 5, has_more: true, before_cursor: "latest_boundary" })),
    historyMessageToThreadMessage: (message) => message,
    setTaskBrief: vi.fn(), projectDurableSnapshotRun: vi.fn(), patchWindowContext: vi.fn(),
    setConnected: vi.fn(), setChatLoading: vi.fn(), setRuntimeRetryExhausted: vi.fn(), setStatus: vi.fn()
  };
  context.setMessages = (update) => { context.messagesRef.current = update(context.messagesRef.current); };
  return { context, run: () => runInNewContext(`(${recovery.trim()})`, context)(socket, 1) };
}

describe("Desktop recovery integration", () => {
  it.each(["connectRuntime", "session.ready"])("bridges offline middle gaps through %s while keeping the oldest cursor", async (path) => {
    const { context, run } = setup();
    const turns = Array.from({ length: 55 }, (_, i) => ({ id: `turn_${i + 1}`, role: "user" }));
    context.messagesRef.current = turns.slice(0, 25);
    context.activeRunRef.current = { runId: "run_old", status: "running" };
    context.getConversationRun.mockResolvedValue({ id: "run_old", status: "completed" });
    Object.assign(context, {
      targetConversationId: "conv_a", targetServerUrl: "ws://localhost", targetEntitlementId: "ent_a", targetWorkspaceGrant: {}, requestToken: 1,
      historyPageRef: { current: { conversationId: "conv_a", has_more: true, before_cursor: "oldest_cursor" } },
      olderRequestRef: { current: null }, setOlderLoading: vi.fn(), setOlderError: vi.fn(), setHistoryPage: vi.fn()
    });
    context.getConversationSnapshot.mockResolvedValue({ messages: turns.slice(30), runs: [], events: [], cursor: 110, has_more: true, before_cursor: "before31" });
    context.getConversationHistoryPage.mockResolvedValue({ messages: turns.slice(5, 30), has_more: true, before_cursor: "before6" });
    if (path === "session.ready") await run();
    else {
      const start = source.indexOf('      const activeConversationId = targetConversationId.trim() || "desktop-chat";');
      const block = source.slice(start, source.indexOf('      setStatus("Connecting...");', start));
      await runInNewContext(`(async () => { ${block} })`, context)();
    }
    expect(context.messagesRef.current).toEqual(turns);
    expect(context.getConversationHistoryPage).toHaveBeenCalledTimes(1);
    expect(context.historyPageRef.current.before_cursor).toBe("oldest_cursor");
    expect(context.setHistoryPage).not.toHaveBeenCalled();
    expect(context.getConversationRun).toHaveBeenCalledWith("ws://localhost", "token", { entitlementId: "ent_a" }, "conv_a", "run_old");
    expect(context.projectDurableSnapshotRun.mock.calls[0][0].runs).toContainEqual({ id: "run_old", status: "completed" });
    expect(context.patchWindowContext).toHaveBeenCalledWith({ conversationCursor: 110 });
  });

  it("keeps live messages that arrive while the latest HTTP page is in flight", async () => {
    const { context, run } = setup();
    let resolve;
    context.getConversationSnapshot.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = run();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    context.messagesRef.current = [...context.messagesRef.current, { id: "live", role: "assistant" }];
    resolve({ messages: [{ id: "latest", role: "user" }], runs: [], events: [], cursor: 5, has_more: false });
    expect(await pending).toBe(true);
    expect(context.messagesRef.current.map((message) => message.id)).toEqual(["older", "latest", "live"]);
    expect(context.patchWindowContext).toHaveBeenCalledWith({ conversationCursor: 5 });
  });

  it("discards a late response after switching Conversation without persisting its cursor", async () => {
    const { context, run } = setup();
    let resolve;
    context.getConversationSnapshot.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = run();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    context.connectionTokenRef.current = 2;
    resolve({ messages: [{ id: "stale", role: "user" }], runs: [], events: [], cursor: 8, has_more: false });
    await pending;
    expect(context.messagesRef.current.map((message) => message.id)).toEqual(["older"]);
    expect(context.patchWindowContext).not.toHaveBeenCalled();
  });

  it("fails closed with a visible retry state when recovery HTTP fails", async () => {
    const { context, run } = setup();
    context.getConversationJournalPage.mockRejectedValue(new Error("Network unavailable"));
    expect(await run()).toBe(false);
    expect(context.setConnected).toHaveBeenCalledWith(false);
    expect(context.setChatLoading).toHaveBeenCalledWith(false);
    expect(context.setRuntimeRetryExhausted).toHaveBeenCalledWith(true);
    expect(context.patchWindowContext).not.toHaveBeenCalled();
    expect(context.getConversationSnapshot).not.toHaveBeenCalled();
  });

  it("does not advance recovery when the authoritative missing Run lookup fails", async () => {
    const { context, run } = setup();
    context.activeRunRef.current = { runId: "run_old" };
    context.getConversationRun.mockRejectedValue(new Error("Run unavailable"));
    expect(await run()).toBe(false);
    expect(context.projectDurableSnapshotRun).not.toHaveBeenCalled();
    expect(context.patchWindowContext).not.toHaveBeenCalled();
    expect(context.setRuntimeRetryExhausted).toHaveBeenCalledWith(true);
  });
});
