// Native files are the durable draft authority. This session only queues edits
// for its single account/conversation and holds them until a save succeeds.
export async function openDraftSession(invoke, scope, onStatus = () => {}) {
  const opened = await invoke("open_conversation_draft", scope);
  if (!opened?.lease || typeof opened.draft?.text !== "string" || !Array.isArray(opened.draft.attachments)) {
    throw new Error("draft_invalid: Native draft response was invalid");
  }
  let draft = { textRevision: 0, pending: null, ...structuredClone(opened.draft) };
  let revision = 0;
  let saved = 0;
  let writing = null;
  let closed = false;
  let closing = null;
  const preparing = new Set();
  const args = { ...scope, lease: opened.lease };
  const snapshot = () => structuredClone(draft);
  const applyUpdate = (patch) => {
    if (closed) throw new Error("draft_closed: Draft editor has closed");
    draft = { ...draft, ...structuredClone(patch) };
    if (Object.hasOwn(patch, "text")) draft.textRevision += 1;
    revision += 1;
    void drain().catch(() => {});
  };
  const drain = () => {
    if (writing) return writing;
    if (saved === revision) return Promise.resolve();
    onStatus("saving");
    let failed = false;
    writing = (async () => {
      while (saved !== revision) {
        const target = revision;
        await invoke("save_conversation_draft", { ...args, draft: snapshot() });
        saved = target;
      }
    })().then(() => onStatus("ready"), (error) => {
      failed = true;
      onStatus("error", error);
      throw error;
    }).finally(() => {
      writing = null;
      if (!failed && saved !== revision) void drain().catch(() => {});
    });
    return writing;
  };
  const flush = async () => {
    await Promise.allSettled([...preparing]);
    do { await drain(); } while (saved !== revision);
  };
  const session = {
    scope,
    snapshot,
    textVersion: () => draft.textRevision,
    update(patch) {
      if (closing) throw new Error("draft_closed: Draft editor is closing");
      applyUpdate(patch);
    },
    prepareAttachments(load) {
      if (closed || closing) return Promise.reject(new Error("draft_closed: Draft editor has closed"));
      const task = Promise.resolve().then(load).then((files) => {
        const byId = new Map(draft.attachments.map((file) => [file.contextId, file]));
        for (const file of files) byId.set(file.contextId, draftAttachmentReference(file));
        if (byId.size > 8) throw new Error("A message can contain at most 8 attachments. Remove a file first.");
        // Imports already accepted before close must still be saved.
        applyUpdate({ attachments: [...byId.values()] });
        return snapshot();
      });
      preparing.add(task);
      void task.finally(() => preparing.delete(task)).catch(() => {});
      return task;
    },
    async stageSubmission(input) {
      if (draft.pending) throw new Error("A previous message is awaiting confirmation.");
      session.update({ pending: { ...structuredClone(input), attachments: input.attachments.map(draftAttachmentReference), status: "prepared" } });
      await flush();
      return structuredClone(draft.pending);
    },
    async markSubmissionUnknown() {
      if (!draft.pending) throw new Error("No prepared submission");
      session.update({ pending: { ...draft.pending, status: "unknown" } });
      await flush(); // Persist uncertainty before handing bytes to the socket.
    },
    async acceptSubmission(receipt) {
      const pending = draft.pending;
      if (!pending || receipt?.client_message_id !== pending.clientMessageId || receipt?.run_id !== pending.runId) return false;
      const submittedIds = new Set(pending.attachments.map((file) => file.contextId));
      session.update({
        pending: null,
        attachments: draft.attachments.filter((file) => !submittedIds.has(file.contextId)),
        ...(draft.textRevision === pending.textRevision ? { text: "" } : {})
      });
      await flush();
      return true;
    },
    async restoreRejectedSubmission() {
      const pending = draft.pending;
      if (!pending || pending.status !== "failed") return;
      const files = new Map(pending.attachments.map((file) => [file.contextId, file]));
      for (const file of draft.attachments) files.set(file.contextId, file);
      if (files.size > 8) throw new Error("Remove an attachment before restoring the rejected message.");
      session.update({
        pending: null, attachments: [...files.values()],
        text: draft.textRevision === pending.textRevision || draft.text === pending.text
          ? pending.text : [pending.text, draft.text].filter(Boolean).join("\n\n")
      });
      await flush();
    },
    flush,
    close() {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        await flush(); // A failed save must not silently discard an edit.
        await invoke("release_conversation_draft", args);
        closed = true;
      }).finally(() => { closing = null; });
      return closing;
    }
  };
  return session;
}

export function draftAttachmentReference(file) {
  return Object.fromEntries(["contextId", "assetId", "displayName", "mediaType", "size",
    "sha256", "isImage", "localPath", "hostId"].map((key) => [key, file[key]]));
}
