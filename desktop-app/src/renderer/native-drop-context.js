export const MAX_NATIVE_DROP_SOURCE_BYTES = 100 * 1024 * 1024;
const DROP_HANDLE_PATTERN = /^drop_[a-z0-9_-]{1,91}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * This is the intentionally tiny renderer-side representation of a native
 * drop. Its path identifies the managed copy, not a new filesystem grant.
 */
export function normalizeNativeDropFile(value) {
  if (!value || typeof value !== "object") return null;
  const contextId = typeof value.contextId === "string" ? value.contextId.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!DROP_HANDLE_PATTERN.test(contextId) || !displayName || displayName.length > 256) return null;
  const assetId = typeof value.assetId === "string" ? value.assetId.trim() : "";
  const mediaType = typeof value.mediaType === "string" ? value.mediaType.trim() : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim() : "";
  return Object.freeze({
    contextId,
    displayName,
    size: Number.isFinite(value.size) ? Math.max(0, Number(value.size)) : 0,
    ...(assetId && DROP_HANDLE_PATTERN.test(assetId) ? { assetId } : {}),
    ...(MEDIA_TYPE_PATTERN.test(mediaType) ? { mediaType } : {}),
    ...(SHA256_PATTERN.test(sha256) ? { sha256 } : {}),
    ...(typeof value.localPath === "string" && value.localPath ? { localPath: value.localPath } : {}),
    ...(typeof value.hostId === "string" && value.hostId ? { hostId: value.hostId } : {}),
    ...(typeof value.isImage === "boolean" ? { isImage: value.isImage } : {})
  });
}

/**
 * Turn Rust's immutable drop snapshot into the `client.message.attachments`
 * wire object. The Runtime remains the authority and verifies every field and
 * hash again; these checks prevent malformed bridge values from being sent.
 */
export function normalizeNativeDropAttachment(value) {
  if (!value || typeof value !== "object") return null;
  const contextId = typeof value.contextId === "string" ? value.contextId.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  const mediaType = typeof value.mediaType === "string" ? value.mediaType.trim() : "";
  const sourceBytes = Number(value.sourceBytes);
  const localPath = typeof value.localPath === "string" ? value.localPath : "";
  const hostId = typeof value.hostId === "string" ? value.hostId : "";
  const dataBase64 = typeof value.dataBase64 === "string" ? value.dataBase64 : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim() : "";
  if (
    !DROP_HANDLE_PATTERN.test(contextId)
    || !displayName
    || displayName.length > 256
    || !MEDIA_TYPE_PATTERN.test(mediaType)
    || !Number.isSafeInteger(sourceBytes)
    || sourceBytes < 0
    || sourceBytes > MAX_NATIVE_DROP_SOURCE_BYTES
    || !SHA256_PATTERN.test(sha256)
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(hostId)
    || localPath.includes("\0") || localPath.length > 4096
    || !(/^\//.test(localPath) || /^[a-z]:[\\/]/i.test(localPath))
  ) return null;

  const isImage = mediaType.startsWith("image/");
  if (isImage) {
    const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(dataBase64.length * 3 / 4) - padding;
    if (!BASE64_PATTERN.test(dataBase64)
      || dataBase64.length % 4 !== 0
      || decodedBytes !== sourceBytes
      || !SHA256_PATTERN.test(sha256)) return null;
  }
  return Object.freeze({
    contextId,
    attachment: Object.freeze({
      kind: "local_file",
      attachment_id: contextId,
      display_name: displayName,
      media_type: mediaType,
      source_bytes: sourceBytes,
      sha256,
      host_id: hostId,
      local_path: localPath,
      ...(isImage ? { data_base64: dataBase64 } : {})
    })
  });
}
