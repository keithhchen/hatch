import { describe, expect, it } from "vitest";
import { normalizeNativeDropAttachment, normalizeNativeDropFile } from "./native-drop-context.js";
const snapshot = { contextId: "drop_123", displayName: "document.docx",
  mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  sourceBytes: 4, sha256: "a".repeat(64), hostId: "f780570c-7e50-4c14-bbd0-8a6c06d3302b",
  localPath: "/Users/example/Hatch/attachments/document.docx" };
describe("managed local attachments", () => {
  it("retains stable copy metadata", () => {
    expect(normalizeNativeDropFile({ ...snapshot, size: 4 })).toMatchObject({
      contextId: snapshot.contextId, localPath: snapshot.localPath, hostId: snapshot.hostId, sha256: snapshot.sha256, size: 4 });
    expect(normalizeNativeDropFile({ path: "/unmanaged/file" })).toBeNull();
  });
  it("sends document references without binary or extracted text", () => {
    const result = normalizeNativeDropAttachment({ ...snapshot, dataBase64: "eA==", text: "old projection" });
    expect(result.attachment).toEqual({ kind: "local_file", attachment_id: "drop_123",
      display_name: snapshot.displayName, media_type: snapshot.mediaType, source_bytes: 4,
      sha256: snapshot.sha256, host_id: snapshot.hostId, local_path: snapshot.localPath });
    expect(Object.isFrozen(result.attachment)).toBe(true);
  });
  it("requires host and absolute path without a cloud fallback", () => {
    for (const patch of [{ hostId: "" }, { localPath: "relative.docx" }, { localPath: "/bad\0path" }, { localPath: "" }, { sha256: "invalid" }]) {
      expect(normalizeNativeDropAttachment({ ...snapshot, ...patch })).toBeNull();
    }
    expect(normalizeNativeDropAttachment({ ...snapshot, localPath: "C:\\Hatch\\file.docx" })).not.toBeNull();
  });
  it("requires correctly sized image bytes", () => {
    const image = { ...snapshot, mediaType: "image/png", dataBase64: "AJ+Slg==" };
    expect(normalizeNativeDropAttachment(image).attachment).toMatchObject({ kind: "local_file", data_base64: "AJ+Slg==" });
    expect(normalizeNativeDropAttachment({ ...image, dataBase64: "" })).toBeNull();
    expect(normalizeNativeDropAttachment({ ...image, sourceBytes: 5 })).toBeNull();
  });
  it("supports empty files and enforces file size limit", () => {
    expect(normalizeNativeDropAttachment({ ...snapshot, sourceBytes: 0 })).not.toBeNull();
    expect(normalizeNativeDropAttachment({ ...snapshot, sourceBytes: 100 * 1024 * 1024 })).not.toBeNull();
    expect(normalizeNativeDropAttachment({ ...snapshot, sourceBytes: 100 * 1024 * 1024 + 1 })).toBeNull();
  });
});
