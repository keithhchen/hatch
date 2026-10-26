import { describe, expect, it, vi } from "vitest";
import { NativeDraftStore, composerFile, draftAttachmentReference, openDraftSession } from "./native-drafts.js";

const scope = { accountId: "account", conversationId: "conv_1" };
const file = { contextId: "drop_a", displayName: "a.png", mediaType: "image/png", size: 3, sha256: "f".repeat(64), localPath: "/tmp/a.png", hostId: "h" };

/** Native draft bridge double for this unit test only. */
function bridge(initial = { text: "hello", attachments: [file] }) {
  let stored = structuredClone(initial);
  const invoke = vi.fn(async (command, args) => {
    if (command === "open_conversation_draft") return { lease: "lease", draft: structuredClone(stored) };
    if (command === "save_conversation_draft") stored = structuredClone(args.draft);
  });
  return { invoke, stored: () => stored };
}

describe("native conversation drafts", () => {
  it("restores text and files into the composer and writes edits back as references", async () => {
    const native = bridge();
    const store = new NativeDraftStore(await openDraftSession(native.invoke, scope));
    expect(store.read()).toEqual({ text: "hello", files: [composerFile(file)] });
    store.write(scope, { text: "next", files: [] });
    await store.session.flush();
    expect(native.stored()).toMatchObject({ text: "next", attachments: [], textRevision: 1 });
    store.write(scope, { text: "next", files: [composerFile(file)] });
    await store.session.flush();
    expect(native.stored().attachments).toEqual([draftAttachmentReference(file)]);
    expect(native.stored().textRevision).toBe(1);
  });

  it("releases the lease once after the last save and refuses later edits", async () => {
    const native = bridge();
    const session = await openDraftSession(native.invoke, scope);
    session.update({ text: "kept" });
    const closing = session.close();
    expect(session.close()).toBe(closing);
    expect(() => session.update({ text: "late" })).toThrow("closing");
    await closing;
    expect(native.stored().text).toBe("kept");
    expect(native.invoke.mock.calls.filter(([command]) => command === "release_conversation_draft")).toEqual([["release_conversation_draft", { ...scope, lease: "lease" }]]);
  });

  it("rejects an invalid native response", async () => {
    await expect(openDraftSession(async () => ({ draft: {} }), scope)).rejects.toThrow("draft_invalid");
  });
});
