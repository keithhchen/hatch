import { DraftStore } from "@hatch/chat";

const REFERENCE_KEYS = ["contextId", "assetId", "displayName", "mediaType", "size", "sha256", "isImage", "localPath", "hostId"];

/** The durable part of a composer file: a native managed-copy reference. */
export function draftAttachmentReference(file) {
  return Object.fromEntries(REFERENCE_KEYS.filter(key => file[key] !== undefined).map(key => [key, file[key]]));
}

/** A composer file as the chat view renders it (`id` + `name`). */
export const composerFile = reference => Object.freeze({ ...reference, id: reference.contextId, name: reference.displayName });

/**
 * Native files are the durable draft authority. The window holds the draft's
 * lease while it owns the conversation; edits are queued and written in
 * order, and a failed save is retried on the next edit, never dropped.
 */
export async function openDraftSession(invoke, scope, onStatus = () => {}) {
  const opened = await invoke("open_conversation_draft", scope);
  if (!opened?.lease || typeof opened.draft?.text !== "string" || !Array.isArray(opened.draft.attachments)) {
    throw new Error("draft_invalid: Native draft response was invalid");
  }
  let draft = { text: opened.draft.text, attachments: structuredClone(opened.draft.attachments), textRevision: opened.draft.textRevision ?? 0, pending: null };
  let revision = 0;
  let saved = 0;
  let writing = null;
  let closing = null;
  const args = { ...scope, lease: opened.lease };
  const drain = () => {
    if (writing) return writing;
    if (saved === revision) return Promise.resolve();
    onStatus("saving");
    writing = (async () => {
      while (saved !== revision) {
        const target = revision;
        await invoke("save_conversation_draft", { ...args, draft: structuredClone(draft) });
        saved = target;
      }
    })().then(() => onStatus("ready"), error => { onStatus("error", error); throw error; })
      .finally(() => { writing = null; });
    return writing;
  };
  return {
    snapshot: () => structuredClone(draft),
    update(patch) {
      if (closing) throw new Error("draft_closed: Draft editor is closing");
      const textChanged = Object.hasOwn(patch, "text") && patch.text !== draft.text;
      draft = { ...draft, ...structuredClone(patch), textRevision: draft.textRevision + (textChanged ? 1 : 0) };
      revision += 1;
      void drain().catch(() => {});
    },
    flush: drain,
    close() {
      closing ??= drain().finally(() => invoke("release_conversation_draft", args));
      return closing;
    }
  };
}

/** DraftStore port over an opened native draft session (one conversation). */
export class NativeDraftStore extends DraftStore {
  constructor(session) {
    super();
    this.session = session;
  }

  read() {
    const { text, attachments } = this.session.snapshot();
    return { text, files: attachments.map(composerFile) };
  }

  write(_scope, { text, files }) {
    this.session.update({ text, attachments: files.map(draftAttachmentReference) });
  }

  close() {
    return this.session.close();
  }
}
