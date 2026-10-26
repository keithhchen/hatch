import { AttachmentSource } from "@hatch/chat";
import { MAX_ATTACHMENTS } from "../config.js";
import { HatchRequestError } from "../http.js";
import { composerFile } from "./native-drafts.js";
import { MAX_NATIVE_DROP_SOURCE_BYTES, normalizeNativeDropAttachment, normalizeNativeDropFile } from "./native-drop-context.js";

const IMAGE = /^image\//;

function bytesToBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

/**
 * Desktop attachments are native managed copies: picked, dropped or pasted
 * files are copied by Rust and referenced by an opaque context id. At send
 * time Rust's immutable snapshot becomes a `local_file` attachment, which
 * Runtime verifies again (hash, host, size).
 */
export class NativeAttachmentSource extends AttachmentSource {
  constructor(invoke) {
    super();
    this.invoke = invoke;
  }

  get limit() { return MAX_ATTACHMENTS; }

  accepts(mediaType) { return IMAGE.test(String(mediaType ?? "")); }

  async prepareAll(files) {
    if (!files.length) return [];
    const ids = files.map(file => file.contextId);
    const snapshots = await this.invoke("read_native_drop_contexts", { contextIds: ids });
    const prepared = new Map((Array.isArray(snapshots) ? snapshots : []).map(normalizeNativeDropAttachment).filter(Boolean).map(entry => [entry.contextId, entry.attachment]));
    if (ids.some(id => !prepared.has(id))) throw new HatchRequestError("attachment_unavailable", "An attached file is no longer available. Remove it and attach it again.");
    return ids.map(id => prepared.get(id));
  }

  /** Native file picker. @returns {Promise<{files: object[], rejected: number}>} */
  async pick() {
    const result = await this.invoke("pick_native_drop_files");
    return { files: (result?.files ?? []).map(normalizeNativeDropFile).filter(Boolean).map(composerFile), rejected: result?.rejectedFiles?.length ?? 0 };
  }

  /** Import a pasted clipboard file as a managed copy. */
  async importPasted(file) {
    if (file.size > MAX_NATIVE_DROP_SOURCE_BYTES) throw new HatchRequestError("attachment_too_large", "Files are limited to 100 MB.");
    const mediaType = file.type || "application/octet-stream";
    const displayName = file.name?.trim() || (IMAGE.test(mediaType) ? `pasted-image.${mediaType.split("/")[1] || "png"}` : "pasted-file");
    const saved = normalizeNativeDropFile(await this.invoke("import_clipboard_attachment", {
      displayName, mediaType, dataBase64: bytesToBase64(new Uint8Array(await file.arrayBuffer()))
    }));
    if (!saved) throw new HatchRequestError("attachment_invalid", "The pasted file could not be attached.");
    return composerFile(saved);
  }

  /** Files from a native drop event payload. */
  static dropped(payload) {
    return (Array.isArray(payload?.files) ? payload.files : []).map(normalizeNativeDropFile).filter(Boolean).map(composerFile);
  }
}
