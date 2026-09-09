import { describe, expect, it, vi } from "vitest";
import { openDraftSession, draftAttachmentReference } from "./conversation-draft.js";

const scope = { accountId: "account", conversationId: "conversation" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const receipt = { run_id: "run", client_message_id: "message" };
function persistentBridge() {
  let stored = { text: "send me", attachments: [{ contextId: "original" }] };
  return async (command, args) => {
    if (command === "open_conversation_draft") return { lease: "one", draft: structuredClone(stored) };
    if (command === "save_conversation_draft") stored = structuredClone(args.draft);
  };
}
async function stage(session) {
  await session.stageSubmission({ runId: "run", clientMessageId: "message",
    text: session.snapshot().text, attachments: session.snapshot().attachments,
    textRevision: session.textVersion() });
  await session.markSubmissionUnknown();
}
describe("durable conversation draft session", () => {
  it("seals edits during lease release and shares concurrent close requests", async () => {
    let release;
    const bridge = persistentBridge();
    const invoke = vi.fn(async (command, args) => {
      if (command === "release_conversation_draft") await new Promise((resolve) => { release = resolve; });
      return bridge(command, args);
    });
    const session = await openDraftSession(invoke, scope);
    const closing = session.close();
    expect(session.close()).toBe(closing);
    await tick();
    expect(() => session.update({ text: "late lost edit" })).toThrow("closing");
    await expect(session.prepareAttachments(async () => [])).rejects.toThrow("closed");
    release();
    await closing;
    expect(invoke.mock.calls.filter(([command]) => command === "release_conversation_draft")).toHaveLength(1);
    expect((await openDraftSession(invoke, scope)).snapshot().text).toBe("send me");
  });
  it("a late old receipt cannot clear a newly staged message", async () => {
    const session = await openDraftSession(persistentBridge(), scope);
    await stage(session);
    expect(await session.acceptSubmission(receipt)).toBe(true);
    session.update({ text: "next message", attachments: [{ contextId: "next-file" }] });
    await session.stageSubmission({ runId: "next-run", clientMessageId: "next-id",
      text: session.snapshot().text, attachments: session.snapshot().attachments,
      textRevision: session.textVersion() });
    await session.markSubmissionUnknown();
    const before = session.snapshot();
    expect(await session.acceptSubmission(receipt)).toBe(false);
    expect(session.snapshot()).toEqual(before);
    await session.close();
  });
  it("recovers an uncertain submission with the same logical IDs after reopening", async () => {
    const invoke = persistentBridge();
    const session = await openDraftSession(invoke, scope);
    await stage(session);
    await session.close();
    const reopened = await openDraftSession(invoke, scope);
    expect(reopened.snapshot().pending).toMatchObject({ runId: "run", clientMessageId: "message", status: "unknown" });
    expect(reopened.snapshot().text).toBe("send me");
    await expect(reopened.stageSubmission({})).rejects.toThrow("awaiting confirmation");
    expect(await reopened.acceptSubmission({ ...receipt, run_id: "other" })).toBe(false);
    expect(reopened.snapshot().pending).not.toBeNull();
    expect(await reopened.acceptSubmission(receipt)).toBe(true);
    expect(reopened.snapshot()).toMatchObject({ text: "", attachments: [], pending: null });
  });
  it("acceptance preserves newer text and attachments across restart, including retyped text", async () => {
    const invoke = persistentBridge();
    const session = await openDraftSession(invoke, scope);
    await stage(session);
    session.update({ text: "changed" });
    session.update({ text: "send me", attachments: [{ contextId: "original" }, { contextId: "new" }] });
    await session.close();
    const reopened = await openDraftSession(invoke, scope);
    await reopened.acceptSubmission(receipt);
    expect(reopened.snapshot()).toMatchObject({ text: "send me", attachments: [{ contextId: "new" }], pending: null });
  });
  it("explicit rejected-message restoration retains edits made after submission", async () => {
    const session = await openDraftSession(persistentBridge(), scope);
    await stage(session);
    session.update({ text: "next message", attachments: [{ contextId: "new" }],
      pending: { ...session.snapshot().pending, status: "failed" } });
    await session.restoreRejectedSubmission();
    expect(session.snapshot()).toMatchObject({ text: "send me\n\nnext message", pending: null,
      attachments: [{ contextId: "original" }, { contextId: "new" }] });
  });
  it("serializes saves and persists edits made during an in-flight save", async () => {
    let release;
    const writes = [];
    const invoke = vi.fn(async (command, args) => {
      if (command === "open_conversation_draft") return { lease: "one", draft: { text: "saved", attachments: [] } };
      if (command === "save_conversation_draft") {
        writes.push(args.draft.text);
        if (writes.length === 1) await new Promise((resolve) => { release = resolve; });
      }
    });
    const session = await openDraftSession(invoke, scope);
    session.update({ text: "first" });
    session.update({ text: "latest" });
    expect(session.snapshot().text).toBe("latest");
    release();
    await session.flush();
    expect(writes).toEqual(["first", "latest"]);
    await session.close();
    expect(invoke.mock.calls.at(-1)).toEqual(["release_conversation_draft", { ...scope, lease: "one" }]);
  });
  it("retains unsaved content on failure and flush retries before releasing ownership", async () => {
    let failing = true;
    const status = vi.fn();
    const invoke = vi.fn(async (command) => {
      if (command === "open_conversation_draft") return { lease: "one", draft: { text: "", attachments: [] } };
      if (command === "save_conversation_draft" && failing) throw new Error("disk full");
    });
    const session = await openDraftSession(invoke, scope, status);
    session.update({ text: "do not lose this" });
    await tick();
    await expect(session.close()).rejects.toThrow("disk full");
    expect(invoke.mock.calls.some(([command]) => command === "release_conversation_draft")).toBe(false);
    expect(session.snapshot().text).toBe("do not lose this");
    failing = false;
    await session.close();
    expect(status.mock.calls.some(([state]) => state === "error")).toBe(true);
  });
  it("persists references, never transient prepared attachment bodies", () => {
    const ref = draftAttachmentReference({ contextId: "id", attachment: { data_base64: "big" }, previewUrl: "blob:temporary" });
    expect(ref).not.toHaveProperty("attachment");
    expect(ref).not.toHaveProperty("previewUrl");
  });
  it("waits for an attachment import before releasing a conversation editor", async () => {
    let imported;
    const writes = [];
    const invoke = vi.fn(async (command, args) => {
      if (command === "open_conversation_draft") return { lease: "one", draft: { text: "first conversation", attachments: [] } };
      if (command === "save_conversation_draft") writes.push(args);
    });
    const session = await openDraftSession(invoke, scope);
    const preparing = session.prepareAttachments(() => new Promise((resolve) => { imported = resolve; }));
    const closing = session.close();
    await tick();
    expect(invoke.mock.calls.some(([command]) => command === "release_conversation_draft")).toBe(false);
    imported([{ contextId: "copy" }]);
    await preparing;
    await closing;
    expect(writes.at(-1).conversationId).toBe("conversation");
    expect(writes.at(-1).draft.attachments[0].contextId).toBe("copy");
  });
  it("rejects attachment overflow instead of evicting existing chips", async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ contextId: String(index) }));
    const session = await openDraftSession(async () => ({ lease: "one", draft: { text: "", attachments: files } }), scope);
    await expect(session.prepareAttachments(async () => [{ contextId: "ninth" }])).rejects.toThrow("at most 8");
    expect(session.snapshot().attachments).toEqual(files);
  });
  it("tracks newer text edits even if the user retypes the same submitted text", async () => {
    const session = await openDraftSession(async (command) => command === "open_conversation_draft"
      ? { lease: "one", draft: { text: "same", attachments: [] } } : undefined, scope);
    const submitted = session.textVersion();
    session.update({ text: "changed" });
    session.update({ text: "same" });
    expect(session.textVersion()).not.toBe(submitted);
    await session.flush();
  });
});
