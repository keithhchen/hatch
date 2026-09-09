import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConversationSessionManager } from "./conversation-session.js";
import * as client from "./conversation-client.js";
import * as pagination from "./conversation-pagination.js";
import * as policy from "./product-policy.js";
import * as workspace from "./workspace-restore.js";
import * as stream from "./stream-projection.js";
import * as timeline from "./activity-ui.js";
import * as localTools from "./local-tool-lifecycle.js";
import { textRevealBoundary } from "./text-reveal.js";
import { createTurnAccessSnapshot } from "./turn-access-snapshot.js";

// Execute the production App orchestration, not a replacement send/receive
// implementation. The boundaries are test-only HTTP/socket/native fixtures.
// This is renderer integration coverage, never installed-product/OS UAT.
const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
function appFunction(name) {
  const match = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(source);
  if (!match) throw new Error(`Missing App function ${name}`);
  return source.slice(match.index, source.indexOf("\n  }", match.index) + 4);
}
function helper(name) {
  const match = new RegExp(`^function ${name}\\(`, "m").exec(source);
  return source.slice(match.index, source.indexOf("\n}", match.index) + 2);
}
const methods = ["connectRuntime", "disconnectRuntime", "isCurrentRuntimeTransport", "sendRuntimeMessage",
  "scheduleRuntimeReconnect", "reconcileLiveSnapshot", "projectDurableSnapshotRun", "handleRuntimeMessage",
  "sendTaskStartIfNeeded", "synchronizeNativeToolContext", "clearSessionNativeToolContexts", "invokeLocalToolCall",
  "handleToolRequest", "cancelPendingLocalTools", "requestToolApproval", "rejectPendingApprovals",
  "appendAssistantText", "finishAssistant", "saveAssistantTiming", "updateAssistantMessage", "updateAssistantMetadataForRun",
  "upsertToolEvent", "publishDraftSession", "reconcilePendingSubmission", "restoreComposerDraft", "setComposerDraftValue",
  "sessionForConversation", "restoreTaskLocalSettings", "activateConversation", "selectConversation", "patchWindowContext",
  "setConversationIdForEntitlement", "persistWorkspaceGrant", "beginWorkspaceRestore", "switchWorkspace"];
const helpers = ["makeUserMessage", "attachmentPresentationMetadata", "assistantUiAttachments", "makeAssistantPlaceholder",
  "assistantParts", "textFromAppendMessage", "toolPartFromEvent", "approvalForToolEvent"];
const sendStart = source.indexOf("async (appendMessage) => {", source.indexOf("const sendUserMessage ="));
const sendBody = source.slice(sendStart, source.indexOf("\n  }, [conversationSession", sendStart) + 4);
const sessionsToClose = [];
afterEach(async () => {
  for (const manager of sessionsToClose.splice(0)) await manager.closeAll();
  vi.useRealTimers();
});
class Socket extends EventTarget {
  static OPEN = 1;
  static instances = [];
  readyState = 1;
  sent = [];
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event("close")); });
  constructor(url) { super(); this.url = url; Socket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  frame(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
}
function world() {
  Socket.instances = [];
  const manager = createConversationSessionManager();
  sessionsToClose.push(manager);
  const drafts = new Map();
  const tools = new Map();
  const native = vi.fn(async (command, args) => {
    const key = JSON.stringify([args?.accountId, args?.conversationId]);
    if (command === "open_conversation_draft") return { lease: key, draft: drafts.get(key) ?? { text: "", attachments: [] } };
    if (command === "save_conversation_draft") { drafts.set(key, structuredClone(args.draft)); return; }
    if (command === "ensure_workspace") return { grant_id: "grant", display_path: "/workspace" };
    if (command === "set_window_tool_context") return { context_id: `opaque:${args.conversationId}:${args.runId}` };
    if (command === "clear_window_tool_context") return { status: "cleared", context_id: args.contextId, run_id: args.runId };
    if (command === "execute_tool_call") { tools.set(args.toolCallId ?? args.request.tool_call_id, args); return { status: "approval_required" }; }
    if (command === "poll_tool_call") return tools.get(args.toolCallId)?.result ?? null;
    if (command === "cancel_tool_call") return true;
  });
  return { manager, native, drafts, tools, sequence: 0, navigationRequestRef: { current: 0 },
    selectedEntitlementIdRef: { current: "agent-a" }, windowContextRef: { current: {} },
    selectedId: null, viewport: { scrollTop: 120, scrollHeight: 1000, clientHeight: 300 } };
}
function bind(w, id, entitlementId = "agent-a") {
  const session = w.manager.get({ accountId: "account", entitlementId, conversationId: id });
  const c = {
    ...client, ...pagination, ...policy, ...workspace, ...stream, ...timeline, ...localTools,
    textRevealBoundary, createTurnAccessSnapshot, conversationSession: session, sessionManager: w.manager,
    console, Date, JSON, Promise, Map, Set, Object, Boolean, Number, String, Error, WebSocket: Socket,
    window: { setTimeout, clearTimeout, __TAURI_INTERNALS__: false }, document: { visibilityState: "visible" },
    DEFAULT_PERMISSION_MODE: policy.DEFAULT_PERMISSION_POLICY, MAX_AUTOMATIC_RUNTIME_RETRIES: 4, PROTOCOL_VERSION: "0.7",
    OUTPUT_FILTERED_COPY: "Filtered", creatorAgent: { name: "Same title" },
    creatorAgentEntitlements: ["agent-a", "agent-b"].map((entitlement_id) => ({ entitlement_id, product_id: entitlement_id, creator_id: "creator", name: "Same title" })),
    selectedEntitlementId: entitlementId, conversationId: id, serverUrl: "ws://fixture.invalid/runtime",
    buyerSession: { accessToken: "test-token", profile: { id: "account" } }, buyerProfile: { id: "account" },
    buyerSessionRef: { current: { accessToken: "test-token" } }, conversationLibraryStatus: "ready",
    draftKey: JSON.stringify(["account", id]), ...Object.fromEntries(["navigationRequestRef", "selectedEntitlementIdRef", "windowContextRef"].map((name) => [name, w[name]])),
    viewportRef: { current: w.viewport }, invokeTauri: w.native, errorMessage: (error) => error.message,
    conversationOwnerRef: { current: null },
    stableRandomId: () => `identity_${++w.sequence}`,
    setBriefTask: vi.fn(), setConversationId: (value) => { w.selectedId = value; },
    settingsStoreRef: { current: { clearProfileKey: vi.fn() } },
    getConversationSnapshot: vi.fn(async () => ({ messages: [], runs: [], events: [], cursor: 0, has_more: false })),
    getConversationJournalPage: vi.fn(async () => ({ events: [], runs: [], cursor: 0, through_cursor: 0, has_more: false })),
    historyMessageToThreadMessage: (message) => message, reportTurnTiming: vi.fn(),
    conversationBindingFor: () => ({ entitlementId }), t: (key) => key
  };
  for (const match of source.matchAll(/  const (\w+) = conversationSession\.ref\("\w+", (.*)\);/g)) {
    const initial = runInContext(match[2], createContext({ ...c, draftKey: c.draftKey }));
    c[match[1]] = session.ref(match[1], initial);
  }
  for (const match of source.matchAll(/  const \[(\w+), (\w+)\] = sessionStateField\("\w+"\);/g)) {
    Object.defineProperty(c, match[1], { get: () => session.snapshot()[match[1]], configurable: true });
    c[match[2]] = (update) => session.set(match[1], update);
  }
  c.setMessages = (update) => {
    const next = typeof update === "function" ? update(c.messagesRef.current) : update;
    c.messagesRef.current = next; session.set("messages", next);
  };
  c.send = (message) => session.send(message);
  Object.defineProperty(c, "draftEditable", { get: () => Boolean(c.draftSessionRef.current) });
  Object.defineProperty(c, "conversationReady", { get: () => session.snapshot().connected });
  const vm = createContext(c);
  runInContext([...methods.map(appFunction), ...helpers.map(helper), `const sendUserMessage = ${sendBody};`,
    `globalThis.operations = { ${methods.join(",")}, sendUserMessage };`].join("\n"), vm);
  c.textRevealRef.current = { discard: vi.fn(), flush: vi.fn(),
    enqueue: ({ assistantId, content }) => c.operations.appendAssistantText(assistantId, content),
    complete: (_id, finish) => finish() };
  session.clearContexts = c.operations.clearSessionNativeToolContexts;
  if (!session.localSettingsInitialized) {
    session.localSettingsInitialized = true;
    session.set("workspaceGrant", { grant_id: "grant", display_path: "/workspace" });
    session.set("workspace", "/workspace"); session.set("workspaceGranted", true);
  }
  return { session, c, ...c.operations };
}
async function ready(owner) {
  await owner.session.openDraft(owner.c.invokeTauri);
  await owner.connectRuntime();
  const socket = owner.c.socketRef.current;
  expect(socket, owner.session.snapshot().status).toBeTruthy();
  socket.dispatchEvent(new Event("open"));
  socket.frame({ type: "session.ready", runtime_capabilities: { message_acceptance: true, local_file_references: true } });
  await vi.waitFor(() => expect(owner.session.snapshot().connected).toBe(true));
  return socket;
}
async function sendText(owner, text) {
  owner.c.draftSessionRef.current.session.update({ text });
  await owner.sendUserMessage({ content: [{ type: "text", text }] });
  const run = owner.c.activeRunRef.current;
  expect(run, owner.session.snapshot().status).toBeTruthy();
  return run;
}

function runEffect(owner, firstLine) {
  const start = source.indexOf(firstLine);
  const end = source.indexOf("\n  }, [", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return runInContext(`(() => { ${source.slice(start, end)} })()`, createContext(owner.c));
}

function startup(w, owner, grant) {
  w.windowContextRef.current = { workspaceGrant: grant };
  Object.assign(owner.c, {
    settingsReady: true, windowContextReady: true, signedIn: true,
    workspaceRestoredAccountRef: { current: "" }, requestedConversationIdRef: { current: "" },
    getProfileSetting: (_key, fallback) => fallback, getConversationId: () => "conv_a",
    parseStoredJson: (value) => value, setProfileSetting: vi.fn(),
    setWindowStateRestored: (value) => { owner.c.windowStateRestored = value; }
  });
  Object.defineProperty(owner.c, "workspaceSettingsReady", { get: () => owner.session.snapshot().workspaceSettingsReady });
  return runEffect(owner, "    if (!settingsReady || !windowContextReady || !signedIn || !buyerSession?.profile?.id) return;");
}

describe("cloud startup without local workspace authority", () => {
  it("handshake leaves a pending Brief untouched without a validated workspace", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    a.session.set("workspaceGrant", null);
    a.session.set("workspaceGranted", false);
    a.c.workspaceGrantRef.current = null;
    a.c.pendingTaskStartRef.current = "conv_a";
    a.c.taskBriefRef.current = { title: "Waiting for local access" };
    a.c.createTurnAccessSnapshot = vi.fn(() => { throw new Error("Must not construct access yet"); });
    const socket = await ready(a);
    expect(await a.sendTaskStartIfNeeded()).toBe(false);
    expect(a.c.createTurnAccessSnapshot).not.toHaveBeenCalled();
    expect(a.session.snapshot().status).toBe("Connected");
    expect(a.c.pendingTaskStartRef.current).toBe("conv_a");
    expect(a.c.activeRunRef.current).toBeNull();
    expect(w.native.mock.calls.some(([cmd]) => cmd === "set_window_tool_context")).toBe(false);
    expect(socket.sent.some((frame) => frame.type === "client.message")).toBe(false);
  });

  it("snapshot construction failure resolves false, reports the error and releases the Brief preparation guard", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    const socket = await ready(a);
    a.c.workspaceGrantRef.current = a.session.snapshot().workspaceGrant;
    a.c.pendingTaskStartRef.current = "conv_a";
    a.c.taskBriefRef.current = { title: "Brief" };
    a.c.createTurnAccessSnapshot = () => { throw new Error("snapshot construction failed"); };
    await expect(a.sendTaskStartIfNeeded()).resolves.toBe(false);
    expect(a.session.snapshot().status).toContain("snapshot construction failed");
    expect(a.session.ref("taskStartPreparingRef").current).toBe(false);
    expect(a.c.pendingTaskStartRef.current).toBe("conv_a");
    expect(socket.sent.some((frame) => frame.type === "client.message")).toBe(false);
  });

  it.each(["current", "superseded", "disposed"])("handles unexpected task restore rejection only for its live revision (%s)", async (state) => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session); a.c.window.__TAURI_INTERNALS__ = true;
    const native = w.native.getMockImplementation();
    w.native.mockImplementation((command, args) => command === "read_task_settings"
      ? Promise.resolve({ workspaceGrant: { grant_id: "saved", display_path: "/saved" } }) : native(command, args));
    let rejectRestore;
    a.c.validateRestoredWorkspace = () => new Promise((_resolve, reject) => { rejectRestore = reject; });
    await a.selectConversation({ id: "conv_b" });
    expect(w.selectedId).toBe("conv_b");
    const b = bind(w, "conv_b");
    expect(rejectRestore).toBeTypeOf("function");
    if (state === "superseded") b.persistWorkspaceGrant({ grant_id: "new", display_path: "/new" });
    if (state === "disposed") await b.session.close();
    rejectRestore(new Error("unexpected restore failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.session.snapshot().status.includes("unexpected restore failure")).toBe(state === "current");
    expect(a.session.snapshot().status).not.toContain("unexpected restore failure");
    expect(b.session.snapshot().workspaceGrant).toBeNull();
  });

  it("loads the authenticated snapshot and connects while folder validation is still pending; sending remains denied", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    let finishFolder;
    const native = w.native.getMockImplementation();
    w.native.mockImplementation((command, args) => command === "ensure_workspace"
      ? new Promise((resolve) => { finishFolder = resolve; }) : native(command, args));
    const saved = { grant_id: "saved", display_path: "/unverified" };
    const cleanup = startup(w, a, saved);
    expect(finishFolder).toBeTypeOf("function");
    expect(a.c.windowStateRestored).toBe(true);
    expect(a.session.snapshot().workspaceGrant).toBeNull();
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      messages: [{ id: "cloud-message", role: "user", content: "Saved in cloud" }],
      runs: [], events: [], cursor: 0, has_more: false
    }), { status: 200 }));
    a.c.getConversationSnapshot.mockImplementation((url, token, binding, id, cursor = 0) =>
      client.getConversationSnapshot(url, token, binding, id, cursor, fetch));
    const socket = await ready(a);
    expect(a.session.snapshot().messages[0].content).toBe("Saved in cloud");
    const [url, options] = fetch.mock.calls[0];
    expect(String(url)).toContain("/v1/conversations/conv_a/snapshot");
    expect(String(url)).toContain("entitlement_id=agent-a");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer test-token");
    expect(socket.sent[0].type).toBe("client.hello");
    expect(w.native.mock.calls.filter(([cmd]) => cmd === "ensure_workspace")).toHaveLength(1);
    await a.sendUserMessage({ content: [{ type: "text", text: "Do work" }] });
    expect(socket.sent.some((frame) => frame.type === "client.message")).toBe(false);
    expect(w.native.mock.calls.some(([cmd]) => cmd === "set_window_tool_context")).toBe(false);
    runEffect(a, "    if (!windowContextReady || !windowStateRestored || !signedIn) return;");
    expect(w.windowContextRef.current.workspaceGrant).toEqual(saved);
    cleanup();
    finishFolder(saved);
  });

  it("connects with no saved folder and does not bypass cloud authentication errors", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    startup(w, a, null);
    await vi.waitFor(() => expect(a.session.snapshot().workspaceSettingsReady).toBe(true));
    const socket = await ready(a);
    expect(socket.sent[0].type).toBe("client.hello");
    expect(w.native.mock.calls.some(([cmd]) => cmd === "ensure_workspace")).toBe(false);
    const b = bind(w, "conv_b");
    b.session.set("workspaceGrant", null);
    b.c.getConversationSnapshot.mockImplementation((...args) => client.getConversationSnapshot(...args, 0,
      async () => new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 })));
    await b.connectRuntime();
    expect(b.c.socketRef.current).toBeNull();
    expect(b.session.snapshot().messages).toEqual([]);
  });

  it.each(["valid", "stale"])("late %s startup restore cannot replace a newly validated selection", async (result) => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    let resolve, reject;
    const native = w.native.getMockImplementation();
    const old = { grant_id: "old", display_path: "/old" };
    const chosen = { grant_id: "new", display_path: "/new" };
    w.native.mockImplementation((command, args) => command !== "ensure_workspace" ? native(command, args)
      : args.workspaceGrantId === "old" ? new Promise((yes, no) => { resolve = yes; reject = no; }) : Promise.resolve(chosen));
    startup(w, a, old);
    await a.switchWorkspace(chosen);
    if (result === "valid") resolve(old); else reject(new Error("workspace_grant_stale"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(a.session.snapshot().workspaceGrant).toEqual(chosen);
    expect(w.windowContextRef.current.workspaceGrant).toEqual(chosen);
    expect(a.c.settingsStoreRef.current.clearProfileKey).not.toHaveBeenCalled();
  });

  it("failed folder validation retains saved settings without granting execution access", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    const saved = { grant_id: "old", display_path: "/old" };
    w.native.mockRejectedValue(new Error("workspace_grant_unavailable"));
    startup(w, a, saved);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runEffect(a, "    if (!windowContextReady || !windowStateRestored || !signedIn) return;");
    expect(a.session.snapshot().workspaceGranted).toBe(false);
    expect(a.session.snapshot().workspaceGrant).toBeNull();
    expect(w.windowContextRef.current.workspaceGrant).toEqual(saved);
    expect(a.c.settingsStoreRef.current.clearProfileKey).not.toHaveBeenCalled();
  });

  it("handshake and newly granted workspace cannot start the same Brief twice", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    const socket = await ready(a);
    a.c.pendingTaskStartRef.current = "conv_a";
    a.c.taskBriefRef.current = { title: "Saved Brief" };
    a.c.workspaceGrantRef.current = a.session.snapshot().workspaceGrant;
    a.c.workspaceRef.current = "/workspace";
    let finish;
    const native = w.native.getMockImplementation();
    w.native.mockImplementation((command, args) => command === "set_window_tool_context"
      ? new Promise((resolve) => { finish = resolve; }) : native(command, args));
    const first = a.sendTaskStartIfNeeded();
    expect(await a.sendTaskStartIfNeeded()).toBe(false);
    finish({ context_id: "opaque-brief" });
    expect(await first).toBe(true);
    expect(socket.sent.filter((frame) => frame.type === "client.message")).toHaveLength(1);
  });

  it("selects immediately during task folder validation and ignores a late result after a new selection", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session); a.c.window.__TAURI_INTERNALS__ = true;
    const old = { grant_id: "old", display_path: "/old" };
    const chosen = { grant_id: "new", display_path: "/new" };
    let finish;
    const native = w.native.getMockImplementation();
    w.native.mockImplementation((command, args) => command === "read_task_settings" ? Promise.resolve({ workspaceGrant: old })
      : command !== "ensure_workspace" ? native(command, args)
      : args.workspaceGrantId === "old" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve(chosen));
    await a.selectConversation({ id: "conv_b" });
    expect(w.selectedId).toBe("conv_b");
    const b = bind(w, "conv_b");
    expect(b.session.snapshot().workspaceGrant).toBeNull();
    await ready(b);
    expect(finish).toBeTypeOf("function");
    await b.switchWorkspace(chosen);
    finish(old);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.session.snapshot().workspaceGrant).toEqual(chosen);
    expect(w.windowContextRef.current.workspaceGrant).toEqual(chosen);
  });

  it("does not hide the thread or recovery button behind workspaceGranted", () => {
    const shell = source.slice(source.indexOf('<section className="chat-shell desktop-chat-shell">'), source.indexOf("<TaskBriefForm"));
    expect(shell).not.toContain("!workspaceGranted");
    expect(shell).not.toContain("<WorkspaceOnboarding");
    expect(source).toContain("const showRetry = Boolean(conversationLibraryReady && !connected && retryExhausted)");
  });
});

describe("production renderer with per-Conversation sessions", () => {
  it("retains each session's Agent presentation across navigation without another handshake", async () => {
    const w = world();
    const a = bind(w, "conv_a");
    a.c.creatorAgent = { name: "Agent", creator: "A creator" };
    w.manager.select(a.session);
    const socketA = await ready(a);
    const b = bind(w, "conv_b");
    b.c.creatorAgent = { name: "Agent", creator: "B creator" };
    w.manager.select(b.session);
    await ready(b);
    expect(a.session.snapshot().creatorAgent.creator).toBe("A creator");
    expect(b.session.snapshot().creatorAgent.creator).toBe("B creator");
    w.manager.select(a.session);
    expect(a.session.snapshot().creatorAgent.creator).toBe("A creator");
    expect(a.c.socketRef.current).toBe(socketA);
    expect(socketA.close).not.toHaveBeenCalled();
  });
  it("A→B→A retains exact sockets and runs, routes same-title messages/drafts by immutable identity, and stops only B", async () => {
    const w = world();
    const a = bind(w, "conv_a");
    w.manager.select(a.session);
    const socketA = await ready(a);
    const runA = await sendText(a, "Analysis and PPT");
    a.c.draftSessionRef.current.session.update({ text: "Later A draft", attachments: [{ contextId: "later-a-file" }] });
    a.session.setUi("tool:analysis:open", true);
    a.session.saveReadingPosition(w.viewport);
    await a.selectConversation({ id: "conv_b", title: "Same title" });
    const b = bind(w, w.selectedId);
    const socketB = await ready(b);
    const runB = await sendText(b, "Screenshot question");
    const bBefore = structuredClone(b.session.snapshot().messages);
    socketA.frame({ type: "assistant.delta", run_id: runA.runId, delta: { kind: "text", content: "A background answer" } });
    socketA.frame({ type: "message.accepted", run_id: runA.runId, client_message_id: runA.clientMessageId });
    await vi.waitFor(() => expect(a.c.draftSessionRef.current.session.snapshot().pending).toBeNull());
    expect(a.session.snapshot().composerDraft).toBe("Later A draft");
    expect(a.session.snapshot().droppedFiles[0].contextId).toBe("later-a-file");
    expect(a.session.snapshot().messages.at(-1).content).toContainEqual({ type: "text", text: "A background answer" });
    expect(b.session.snapshot().messages).toEqual(bBefore);
    expect(b.c.draftSessionRef.current.session.snapshot().pending.runId).toBe(runB.runId);
    await b.session.cancel();
    expect(socketB.sent.filter((m) => m.type === "turn.cancel")).toEqual([{ type: "turn.cancel", run_id: runB.runId, reason: "user_requested" }]);
    expect(socketA.sent.some((m) => m.type === "turn.cancel")).toBe(false);
    const loads = a.c.getConversationSnapshot.mock.calls.length;
    await b.selectConversation({ id: a.session.scope.conversationId, title: "Same title" });
    await a.connectRuntime();
    expect(w.manager.get(a.session.scope)).toBe(a.session);
    expect(a.c.socketRef.current).toBe(socketA);
    expect(b.c.socketRef.current).toBe(socketB);
    expect(Socket.instances).toHaveLength(2);
    expect(socketA.close).not.toHaveBeenCalled(); expect(socketB.close).not.toHaveBeenCalled();
    expect(a.c.getConversationSnapshot).toHaveBeenCalledTimes(loads);
    expect(a.c.activeRunRef.current.runId).toBe(runA.runId);
    expect(socketA.sent.filter((m) => m.type === "client.message")).toHaveLength(1);
    expect(socketA.sent.find((m) => m.type === "client.message").conversation_id).toBe(a.session.scope.conversationId);
    expect(socketB.sent.find((m) => m.type === "client.message").conversation_id).toBe(b.session.scope.conversationId);
    w.viewport.scrollHeight = 5000;
    a.session.restoreReadingPosition(w.viewport);
    expect(w.viewport.scrollTop).toBe(120);
    expect(a.session.snapshot().ui["tool:analysis:open"]).toBe(true);
  });

  it("slow B settings while A connect finishes never leaves selected B showing A history or sending through A", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session);
    await a.session.openDraft(w.native);
    let releaseHistory, releaseSettings;
    a.c.getConversationSnapshot.mockImplementationOnce(() => new Promise((resolve) => { releaseHistory = resolve; }));
    const connectingA = a.connectRuntime();
    await vi.waitFor(() => expect(releaseHistory).toBeTypeOf("function"));
    a.c.window.__TAURI_INTERNALS__ = true;
    const original = w.native.getMockImplementation();
    w.native.mockImplementation(async (command, args) => {
      if (command === "read_task_settings" && args.taskId === "conv_b") {
        await new Promise((resolve) => { releaseSettings = resolve; });
        return { workspaceGrant: { grant_id: "grant", display_path: "/workspace" }, permissionMode: "ask-before-changes" };
      }
      return original(command, args);
    });
    const navigation = a.selectConversation({ id: "conv_b", title: "Same title" });
    await vi.waitFor(() => expect(releaseSettings).toBeTypeOf("function"));
    releaseHistory({ messages: [{ id: "history-a", role: "user", content: "Only A history" }], runs: [], events: [], cursor: 0, has_more: false });
    await connectingA;
    const socketA = a.c.socketRef.current;
    expect(a.session.snapshot().messages[0].id).toBe("history-a");
    expect(w.selectedId).toBe("conv_b");
    expect(w.manager.isSelected(a.session)).toBe(false);
    releaseSettings(); await navigation;
    const b = bind(w, "conv_b");
    const socketB = await ready(b);
    expect(w.manager.isSelected(b.session)).toBe(true);
    const visible = vi.fn();
    const unsubscribe = b.session.subscribe(visible);
    // A's connection handshake/recovery completes AFTER B becomes selected.
    socketA.frame({ type: "session.ready", runtime_capabilities: { message_acceptance: true } });
    await vi.waitFor(() => expect(a.session.snapshot().connected).toBe(true));
    expect(visible).not.toHaveBeenCalled();
    expect(b.session.snapshot().messages).toEqual([]);
    expect(a.session.snapshot().creatorAgent.name).toBe("Same title");
    expect(b.session.snapshot().creatorAgent.name).toBe("Same title");
    await sendText(b, "B new question");
    expect(socketB.sent.find((m) => m.type === "client.message").conversation_id).toBe("conv_b");
    expect(socketA.sent.filter((m) => m.type === "client.message")).toHaveLength(0);
    expect(socketA.close).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("a send preparing in A survives selection of another Agent and cannot borrow its conversation/socket", async () => {
    const w = world(), a = bind(w, "conv_a"), b = bind(w, "conv_b", "agent-b");
    w.manager.select(a.session);
    const socketA = await ready(a); const socketB = await ready(b);
    let release;
    const original = w.native.getMockImplementation();
    w.native.mockImplementation(async (command, args) => {
      if (command === "set_window_tool_context" && args.conversationId === "conv_a") await new Promise((resolve) => { release = resolve; });
      return original(command, args);
    });
    const sending = sendText(a, "A immutable submission");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    w.manager.select(b.session); w.selectedEntitlementIdRef.current = "agent-b";
    a.c.conversationId = "conv_b"; // Deliberately poison the legacy render variable.
    release();
    const run = await sending;
    expect(socketA.sent.find((m) => m.type === "client.message")).toMatchObject({ conversation_id: "conv_a", run_id: run.runId });
    expect(socketB.sent.filter((m) => m.type === "client.message")).toHaveLength(0);
    expect(a.session.snapshot().messages[0].content[0].text).toBe("A immutable submission");
    expect(b.session.snapshot().messages).toEqual([]);
  });

  it.each([true, false])("pending native approval=%s/polling carries A context while B runs; close consumes results before scoped clear", async (approved) => {
    const w = world(), a = bind(w, "conv_a"), b = bind(w, "conv_b");
    w.manager.select(a.session); await ready(a); const run = await sendText(a, "Tool A");
    const request = { type: "tool_call.request", run_id: run.runId, tool_call_id: "tool-a", name: "file_write", arguments: { path: "a.txt", content: "A" } };
    const task = a.invokeLocalToolCall(request, () => a.session.isTransport(a.c.socketRef.current, a.c.connectionTokenRef.current));
    const outcome = task.catch((error) => error);
    await vi.waitFor(() => expect(a.c.approvalResolversRef.current.has("tool-a")).toBe(true));
    w.manager.select(b.session); await ready(b); const runB = await sendText(b, "B continues");
    const requestB = { ...request, run_id: runB.runId, tool_call_id: "tool-b" };
    const outcomeB = b.invokeLocalToolCall(requestB, () => b.session.isTransport(b.c.socketRef.current, b.c.connectionTokenRef.current)).catch((error) => error);
    await vi.waitFor(() => expect(b.c.approvalResolversRef.current.has("tool-b")).toBe(true));
    await b.session.cancel(); await outcomeB;
    expect(w.native.mock.calls.filter(([cmd]) => cmd === "cancel_tool_call").map(([, args]) => args)).toEqual([
      { contextId: `opaque:conv_b:${runB.runId}`, runId: runB.runId, toolCallId: "tool-b" }
    ]);
    expect(a.c.pendingLocalToolsRef.current.has("tool-a")).toBe(true);
    a.c.approvalResolversRef.current.get("tool-a")(approved);
    await vi.waitFor(() => expect(w.native.mock.calls.some(([cmd]) => cmd === (approved ? "approve_pending_tool_call" : "deny_pending_tool_call"))).toBe(true));
    const closed = w.manager.closeAll();
    expect(() => w.manager.get({ accountId: "", entitlementId: "", conversationId: "desktop-chat" })).not.toThrow();
    await closed; await outcome;
    const context = { contextId: `opaque:conv_a:${run.runId}`, runId: run.runId };
    for (const [cmd, args] of w.native.mock.calls.filter(([cmd, args]) => args?.toolCallId === "tool-a" || (cmd === "execute_tool_call" && args.request.tool_call_id === "tool-a"))) {
      expect(args, cmd).toMatchObject(context);
    }
    const calls = w.native.mock.calls;
    const clear = calls.findIndex(([cmd, args]) => cmd === "clear_window_tool_context" && args.contextId === context.contextId);
    const lastPoll = calls.findLastIndex(([cmd, args]) => cmd === "poll_tool_call" && args.contextId === context.contextId);
    expect(clear).toBeGreaterThan(lastPoll);
    expect(calls.filter(([cmd]) => cmd === "clear_window_tool_context").every(([, args]) => args.contextId && args.runId)).toBe(true);
    expect(a.c.socketRef.current).toBeNull(); expect(b.c.socketRef.current).toBeNull();
  });

  it.each([false, true])("auth teardown stays sealed while saved-token clear is pending (failure=%s)", async (failure) => {
    const manager = createConversationSessionManager();
    let finishClear;
    const localClear = new Promise((resolve, reject) => { finishClear = () => failure ? reject(new Error("keychain failed")) : resolve(); });
    const c = { sessionManager: manager, authEpochRef: { current: 0 }, authTeardownRef: { current: false },
      buyerSession: { accessToken: "token-a" }, buyerSessionRef: { current: { accessToken: "token-a" } },
      authStorageRef: { current: {} }, DEFAULT_AUTH_URL: "https://fixture.invalid", errorMessage: (e) => e.message,
      setSessionCloseError: vi.fn(), setSignInError: vi.fn(),
      startAuthSessionSignOut: vi.fn(() => ({ serverRevoke: Promise.resolve(), localClear })),
      authState: "signed-in",
      setAuthState: (state) => { c.authState = state; }, setBuyerSession: (value) => { c.buyerSession = value; } };
    const reset = appFunction("resetToSignedOut");
    for (const [, name] of reset.matchAll(/\b(\w+Ref)\.current/g)) c[name] ??= { current: null };
    for (const [, name] of reset.matchAll(/\b(set\w+)\(/g)) c[name] ??= vi.fn();
    const vm = createContext(c);
    runInContext(`${reset}\n${appFunction("clearSavedSession")}\n${appFunction("signOut")}`, vm);
    const logout = c.signOut();
    await vi.waitFor(() => expect(c.startAuthSessionSignOut).toHaveBeenCalledOnce());
    expect(c.authTeardownRef.current).toBe(true);
    expect(manager.get({ accountId: "account-a", entitlementId: "agent", conversationId: "conv_b" }).disposed).toBe(true);
    finishClear(); await logout;
    expect(c.authState).toBe("signed-out");
    expect(c.buyerSessionRef.current).toBeNull();
    expect(manager.get({ accountId: "account-a", entitlementId: "agent", conversationId: "conv_a" }).disposed).toBe(true);
    if (failure) expect(c.setSignInError).toHaveBeenCalledWith(expect.stringContaining("couldn't clear"));
    await manager.closeAll();
  });

  it.each([false, true])("ignores old account entitlement response after logout/login (401=%s)", async (failure) => {
    let respond;
    const request = new Promise((resolve, reject) => { respond = () => failure ? reject(new Error("401")) : resolve([]); });
    const c = { authEpochRef: { current: 1 }, authTeardownRef: { current: false },
      buyerSession: { accessToken: "token-a" }, buyerSessionRef: { current: { accessToken: "token-a" } },
      entitlementRefreshRef: { current: false }, lastEntitlementRefreshRef: { current: 0 },
      setEntitlementRefreshing: vi.fn(), fetchPurchasedCreatorAgents: () => request,
      DEFAULT_AUTH_URL: "https://fixture.invalid", applySignedInSession: vi.fn(), signOut: vi.fn(),
      isAuthInvalidError: () => true };
    runInContext(appFunction("refreshEntitlements"), createContext(c));
    const refresh = c.refreshEntitlements();
    c.authEpochRef.current++;
    c.buyerSessionRef.current = { accessToken: "token-b" };
    respond(); await refresh;
    expect(c.applySignedInSession).not.toHaveBeenCalled();
    expect(c.signOut).not.toHaveBeenCalled();
    expect(c.buyerSessionRef.current.accessToken).toBe("token-b");
  });

  it("keeps navigation sealed after closeAll until auth teardown ends", async () => {
    const manager = createConversationSessionManager();
    manager.beginTeardown();
    await manager.closeAll();
    const scope = { accountId: "account", entitlementId: "agent", conversationId: "conv_b" };
    expect(manager.get(scope).disposed).toBe(true);
    manager.endTeardown();
    expect(manager.get(scope).disposed).toBe(false);
    await manager.closeAll();
  });

  it.each(["run_tool_context_revoked", "run_tool_context_missing", "run_tool_context_mismatch"])("teardown handles native %s without manufacturing an OS-stop result", async (code) => {
    const manager = createConversationSessionManager();
    const session = manager.get({ accountId: "account", entitlementId: "agent", conversationId: "conv_a" });
    const invoke = vi.fn(async (command) => {
      if (command === "set_window_tool_context") return { context_id: "ctx" };
      if (command === "execute_tool_call") return { status: "running" };
      if (command === "poll_tool_call") return null;
      if (command === "cancel_tool_call") throw new Error(`${code}: denied`);
      if (command === "clear_window_tool_context") return { status: "already_revoked", context_id: "ctx", run_id: "run" };
    });
    await session.registerNativeContext(invoke, { conversationId: "conv_a", runId: "run" });
    session.clearContexts = () => session.clearNativeContexts(invoke);
    const execution = session.executeTool({ run_id: "run", tool_call_id: "tool", tool: "shell", args: {} }, { invoke }).catch((error) => error);
    if (code === "run_tool_context_revoked") {
      await manager.closeAll();
      expect(manager.values()).toEqual([]);
      expect(invoke).toHaveBeenCalledWith("clear_window_tool_context", { contextId: "ctx", runId: "run" });
    } else {
      await expect(manager.closeAll()).rejects.toThrow("Could not close");
      expect(invoke.mock.calls.some(([command]) => command === "clear_window_tool_context")).toBe(false);
    }
    expect((await execution).message).toContain(code);
  });

  it("deduplicates concurrent native clears and preserves actual failures", async () => {
    const manager = createConversationSessionManager();
    const session = manager.get({ accountId: "account", entitlementId: "agent", conversationId: "conv_a" });
    await session.registerNativeContext(async () => ({ context_id: "ctx" }), { conversationId: "conv_a", runId: "run" });
    const failed = vi.fn(async () => { throw new Error("run_tool_context_missing: unknown"); });
    await expect(session.clearNativeContext(failed, "run")).rejects.toThrow("missing");
    expect(session.nativeContext("run").contextId).toBe("ctx");
    const clear = vi.fn(async () => ({ status: "already_revoked", context_id: "ctx", run_id: "run" }));
    await Promise.all([session.clearNativeContext(clear, "run"), session.clearNativeContext(clear, "run")]);
    expect(clear).toHaveBeenCalledOnce();
    expect(() => session.nativeContext("run")).toThrow();
    await manager.closeAll();
  });

  it("late cleanup for a revoked handle cannot delete a newly registered handle for the same run", async () => {
    const manager = createConversationSessionManager();
    const session = manager.get({ accountId: "account", entitlementId: "agent", conversationId: "conv_a" });
    const input = { conversationId: "conv_a", runId: "run" };
    await session.registerNativeContext(async () => ({ context_id: "old" }), input);
    let finish;
    const oldClear = session.clearNativeContext(() => new Promise((resolve) => { finish = resolve; }), "run");
    await session.registerNativeContext(async () => ({ context_id: "new" }), input);
    finish({ status: "already_revoked", context_id: "old", run_id: "run" });
    await oldClear;
    expect(session.nativeContext("run").contextId).toBe("new");
    const clear = vi.fn(async () => ({ status: "cleared", context_id: "new", run_id: "run" }));
    await session.clearNativeContext(clear, "run");
    expect(clear).toHaveBeenCalledWith("clear_window_tool_context", { contextId: "new", runId: "run" });
    await manager.closeAll();
  });

  it("cleans tools and contexts when draft opening rejects during close", async () => {
    const manager = createConversationSessionManager();
    const session = manager.get({ accountId: "account", entitlementId: "agent", conversationId: "conv_a" });
    let rejectOpening;
    const opening = session.openDraft(() => new Promise((resolve, reject) => { rejectOpening = reject; })).catch((error) => error);
    const cancel = vi.fn(async () => true);
    session.ref("pendingLocalToolsRef", new Map()).current.set("tool", { cancel });
    session.clearContexts = vi.fn(async () => {});
    const closed = manager.closeAll();
    rejectOpening(new Error("draft unavailable"));
    await closed;
    expect((await opening).message).toBe("draft unavailable");
    expect(cancel).toHaveBeenCalledOnce();
    expect(session.clearContexts).toHaveBeenCalledOnce();
    expect(manager.values()).toEqual([]);
  });

  it("closes late native registrations and sealed logout renders without reviving a socket or losing draft attachments", async () => {
    const w = world(), a = bind(w, "conv_a");
    w.manager.select(a.session); const socket = await ready(a);
    a.c.draftSessionRef.current.session.update({ text: "Saved across logout", attachments: [{ contextId: "file-a" }] });
    let release;
    const invoke = vi.fn(async (command, args) => {
      if (command === "set_window_tool_context") {
        await new Promise((resolve) => { release = resolve; });
        return { context_id: "late-context" };
      }
      return w.native(command, args);
    });
    a.session.clearContexts = () => a.session.clearNativeContexts(invoke);
    const registration = a.session.registerNativeContext(invoke, {
      conversationId: "conv_a", runId: "late-run", workspaceGrantId: "grant", permissionPolicy: "ask-before-changes"
    }).catch((error) => error);
    const closing = w.manager.closeAll();
    expect(w.manager.get(a.session.scope)).toBe(a.session);
    const empty = w.manager.get({ accountId: "", entitlementId: "", conversationId: "desktop-chat" });
    expect(empty.disposed).toBe(true);
    expect(empty.send({ type: "client.message" })).toBe(false);
    release();
    await closing;
    expect((await registration).message).toContain("closed");
    expect(invoke).toHaveBeenCalledWith("clear_window_tool_context", { contextId: "late-context", runId: "late-run" });
    expect(socket.close).toHaveBeenCalledTimes(1);
    const saved = w.drafts.get(JSON.stringify(["account", "conv_a"]));
    expect(saved.text).toBe("Saved across logout");
    expect(saved.attachments[0].contextId).toBe("file-a");
    expect(w.manager.values()).toEqual([]);
    const fresh = w.manager.get(a.session.scope);
    expect(fresh).not.toBe(a.session);
    expect(fresh.snapshot().messages).toEqual([]);
  });
});
