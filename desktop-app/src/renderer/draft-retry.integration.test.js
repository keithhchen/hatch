import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createConversationSession } from "./conversation-session.js";
import { draftAttachmentReference } from "./conversation-draft.js";
import { createTurnAccessSnapshot, requirePendingAccessSnapshot } from "./turn-access-snapshot.js";

// Execute App's actual send/reconcile/restore handlers together with its real
// draft + conversation sessions. Only HTTP, socket and native I/O are doubles;
// this is renderer/draft integration coverage, not native or OS UAT.
const source = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const block = (from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error(`App handler moved: ${from}`);
  return source.slice(start, end);
};
const handlers = [
  block("  function setComposerDraftValue(", "  useEffect(() => {\n    if (!signedIn || !connected || !draftEditable)"),
  block("  async function synchronizeNativeToolContext(", "  async function clearSessionNativeToolContexts("),
  block("  const sendUserMessage = useCallback(", "  async function sendTaskStartIfNeeded(")
].join("\n");
const originalAccess = createTurnAccessSnapshot("grant_original", "/workspace/original", "ask-before-changes");
const newFile = { contextId: "new-file" };

async function setup(saved) {
  let disk = structuredClone(saved ?? { text: "send me", attachments: [{ contextId: "original-file" }], textRevision: 0 });
  const contexts = new Map();
  let revoked = false;
  const invoke = vi.fn(async (command, args) => {
    if (command === "open_conversation_draft") return { lease: "lease", draft: structuredClone(disk) };
    if (command === "save_conversation_draft") { disk = structuredClone(args.draft); return; }
    if (command === "release_conversation_draft") return;
    if (command === "set_window_tool_context") {
      if (revoked && args.workspaceGrantId === "grant_original") throw new Error("workspace_grant_revoked");
      const existing = contexts.get(args.runId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(args)) throw new Error("run_tool_context_conflict");
      contexts.set(args.runId, structuredClone(args));
      return { context_id: `context-${args.runId}` };
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const conversationSession = createConversationSession({ accountId: "account", entitlementId: "ent", conversationId: "conv_test" });
  const holder = await conversationSession.openDraft(invoke);
  let sendFails = true;
  const socket = { readyState: 1, send: vi.fn((frame) => {
    expect(disk.pending.status).toBe("unknown");
    expect(disk.pending.accessSnapshot).toEqual(originalAccess);
    if (sendFails) throw new Error("socket write failed");
    return frame;
  }) };
  const context = {
    conversationSession, invokeTauri: invoke, draftAttachmentReference,
    createTurnAccessSnapshot, requirePendingAccessSnapshot,
    draftKey: holder.key, draftEditable: true, conversationReady: true,
    buyerProfile: { id: "account" }, conversationId: "conv_test", conversationLibraryStatus: "ready",
    buyerSessionRef: { current: { accessToken: "token" } }, serverUrl: "ws://test",
    workspace: originalAccess.displayPath, workspaceGrant: { grant_id: originalAccess.workspaceGrantId, display_path: originalAccess.displayPath },
    permissionMode: originalAccess.permissionMode, droppedFiles: holder.session.snapshot().attachments,
    useCallback: (callback) => callback, WebSocket: { OPEN: 1 },
    isServerConversationId: (id) => id === "conv_test", stableRandomId: () => "stable",
    textFromAppendMessage: (message) => message.text,
    errorMessage: (error) => String(error.message || error), t: (key) => key,
    conversationBindingFor: () => ({ entitlementId: "ent" }),
    isTerminalRunStatus: (status) => ["failed", "completed", "cancelled"].includes(status),
    getConversationSubmission: vi.fn(async () => ({})),
    prepareNativeDropAttachments: vi.fn(async (files) => ({ attachments: files.map((f) => ({ attachment_id: f.contextId, kind: "local_file" })) })),
    setStatus: vi.fn(), setRunning: vi.fn(), patchWindowContext: vi.fn(),
    setComposerDraft: vi.fn(), setComposerRestoreRequest: vi.fn(), storeDroppedFiles: vi.fn(),
    setMessages: vi.fn(),
    makeUserMessage: (id, content) => ({ id, content }), makeAssistantPlaceholder: (id) => ({ id }),
    send: (message) => conversationSession.send(message)
  };
  for (const name of ["draftSessionRef", "submissionPreparingRef", "sessionDraftKeyRef", "socketRef",
    "activeRunRef", "workspaceRef", "workspaceGrantRef", "permissionRef", "textRevealRef", "composerDraftRef", "droppedFilesRef", "runtimeCapabilitiesRef"]) {
    context[name] = conversationSession.ref(name);
  }
  context.socketRef.current = socket;
  conversationSession.ref("intentionalDisconnectRef").current = false;
  context.sessionDraftKeyRef.current = holder.key;
  context.runtimeCapabilitiesRef.current = { messageAcceptance: true, localFileReferences: true };
  const app = runInNewContext(`(() => { ${handlers}; return { sendUserMessage, restoreComposerDraft, reconcilePendingSubmission, returnPendingToDraft, setComposerDraftValue, setDroppedFiles }; })()`, context);
  return { app, context, session: holder.session, socket, invoke,
    disk: () => structuredClone(disk), allowSend: () => { sendFails = false; },
    revokeOriginal: () => { revoked = true; },
    changePreferences() { context.workspace = "/workspace/changed"; context.workspaceGrant = { grant_id: "grant_changed" }; context.permissionMode = "allow-changes"; }
  };
}

describe("App draft retry integration", () => {
  it.each([false, true])("send=false then retry+accept retains original authority (new input: %s)", async (newInput) => {
    const h = await setup();
    await h.app.sendUserMessage({ text: "send me" });
    expect(h.socket.send).toHaveBeenCalledTimes(1);
    const pending = h.disk().pending;
    expect(pending).toMatchObject({ status: "unknown", text: "send me", textRevision: 0, accessSnapshot: originalAccess });
    expect(h.session.textVersion()).toBe(0);
    expect(h.context.activeRunRef.current).toBeNull();
    if (newInput) {
      h.app.setComposerDraftValue("next message");
      h.app.setDroppedFiles((files) => [...files, newFile]);
    }
    h.changePreferences();
    h.allowSend();
    await h.app.sendUserMessage({ text: "must not replace pending" });
    expect(h.socket.send).toHaveBeenCalledTimes(2);
    expect(h.socket.send.mock.calls[1][0]).toBe(h.socket.send.mock.calls[0][0]);
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "set_window_tool_context").map(([, args]) => args))
      .toEqual([1, 2].map(() => ({ conversationId: "conv_test", runId: pending.runId,
        workspaceGrantId: "grant_original", permissionPolicy: "ask-before-changes" })));
    expect(h.context.activeRunRef.current.accessSnapshot).toEqual(originalAccess);
    await h.context.conversationSession.acceptSubmission({ run_id: pending.runId, client_message_id: pending.clientMessageId });
    expect(h.disk()).toMatchObject({ pending: null, text: newInput ? "next message" : "",
      attachments: newInput ? [newFile] : [] });
  });

  it("reopens unknown submission and re-registers only its persisted grant after preferences change", async () => {
    const first = await setup();
    await first.app.sendUserMessage({ text: "send me" });
    await first.session.close();
    const h = await setup(first.disk());
    h.changePreferences(); h.allowSend();
    await h.app.sendUserMessage({ text: "send me" });
    expect(h.socket.send).toHaveBeenCalledTimes(1);
    expect(h.context.activeRunRef.current.accessSnapshot).toEqual(originalAccess);
    expect(h.disk().pending).toEqual(first.disk().pending);
    const p = h.disk().pending;
    await h.context.conversationSession.acceptSubmission({ run_id: p.runId, client_message_id: p.clientMessageId });
    expect(h.disk()).toMatchObject({ text: "", pending: null, attachments: [] });
  });

  it("checks an accepted unknown submission without registering or sending it again", async () => {
    const h = await setup();
    await h.app.sendUserMessage({ text: "send me" });
    const p = h.disk().pending;
    h.app.setComposerDraftValue("new input"); h.changePreferences();
    h.context.getConversationSubmission.mockResolvedValue({ submission: { run_id: p.runId, client_message_id: p.clientMessageId } });
    await h.app.sendUserMessage({ text: "new input" });
    expect(h.socket.send).toHaveBeenCalledTimes(1);
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "set_window_tool_context")).toHaveLength(1);
    expect(h.disk()).toMatchObject({ text: "new input", pending: null });
  });

  it("does not substitute current authorization when the original grant is revoked", async () => {
    const h = await setup();
    await h.app.sendUserMessage({ text: "send me" });
    const pending = h.disk().pending;
    h.revokeOriginal(); h.changePreferences(); h.allowSend();
    await h.app.sendUserMessage({ text: "send me" });
    expect(h.socket.send).toHaveBeenCalledTimes(1);
    expect(h.disk().pending).toEqual(pending);
    expect(h.disk().textRevision).toBe(pending.textRevision);
    expect(h.context.setStatus).toHaveBeenLastCalledWith(expect.stringContaining("workspace_grant_revoked"));
    expect(h.invoke.mock.calls.filter(([cmd]) => cmd === "set_window_tool_context").at(-1)[1].workspaceGrantId).toBe("grant_original");
  });

  it("retains a genuine intervening edit even when the user retypes the submitted text", async () => {
    const h = await setup();
    await h.app.sendUserMessage({ text: "send me" });
    const pending = h.disk().pending;
    h.app.setComposerDraftValue("changed");
    h.app.setComposerDraftValue("send me");
    h.allowSend();
    await h.app.sendUserMessage({ text: "send me" });
    await h.context.conversationSession.acceptSubmission({ run_id: pending.runId, client_message_id: pending.clientMessageId });
    expect(h.disk()).toMatchObject({ text: "send me", attachments: [], pending: null });
  });

  it("never upgrades a legacy pending without authority; only confirmed nonacceptance permits draft restoration", async () => {
    const h = await setup({ text: "send me", attachments: [], textRevision: 0,
      pending: { runId: "legacy", clientMessageId: "legacy-message", text: "send me", attachments: [], textRevision: 0, status: "unknown" } });
    h.context.getConversationSubmission.mockRejectedValueOnce(new Error("network unavailable"));
    await h.app.sendUserMessage({ text: "send me" });
    expect(h.disk().pending.status).toBe("unknown");
    expect(h.socket.send).not.toHaveBeenCalled();
    await h.app.sendUserMessage({ text: "send me" });
    expect(h.disk().pending.status).toBe("failed");
    expect(h.invoke.mock.calls.some(([cmd]) => cmd === "set_window_tool_context")).toBe(false);
    await h.app.returnPendingToDraft();
    expect(h.disk()).toMatchObject({ text: "send me", pending: null });
  });
});
