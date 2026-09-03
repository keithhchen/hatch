const MAX_NATIVE_DROP_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_NATIVE_DROP_TEXT_BYTES = 64 * 1024;
const DROP_HANDLE_PATTERN = /^drop_[a-z0-9_-]{1,91}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * This is the intentionally tiny renderer-side representation of a native
 * drop.  It never includes a path, file URL, bookmark, or a filesystem grant.
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
  const text = typeof value.text === "string" ? value.text : null;
  const textSha256 = typeof value.textSha256 === "string" ? value.textSha256.trim() : "";
  const truncated = typeof value.truncated === "boolean" ? value.truncated : null;
  const assetId = typeof value.assetId === "string" ? value.assetId.trim() : contextId;
  const dataBase64 = typeof value.dataBase64 === "string" ? value.dataBase64 : "";
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim() : "";
  if (
    !DROP_HANDLE_PATTERN.test(contextId)
    || !DROP_HANDLE_PATTERN.test(assetId)
    || !displayName
    || displayName.length > 256
    || !MEDIA_TYPE_PATTERN.test(mediaType)
    || !Number.isSafeInteger(sourceBytes)
    || sourceBytes < 0
    || sourceBytes > MAX_NATIVE_DROP_SOURCE_BYTES
    || text === null
    || utf8ByteLength(text) > MAX_NATIVE_DROP_TEXT_BYTES
    || !SHA256_PATTERN.test(textSha256)
    || truncated === null
  ) return null;

  if (dataBase64) {
    const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(dataBase64.length * 3 / 4) - padding;
    if (!BASE64_PATTERN.test(dataBase64)
      || dataBase64.length % 4 !== 0
      || decodedBytes !== sourceBytes
      || !SHA256_PATTERN.test(sha256)) return null;
    return Object.freeze({
      contextId,
      attachment: Object.freeze({
        kind: "asset",
        attachment_id: contextId,
        asset_id: assetId,
        display_name: displayName,
        media_type: mediaType,
        source_bytes: sourceBytes,
        sha256,
        data_base64: dataBase64
      })
    });
  }

  const textBytes = utf8ByteLength(text);
  if ((!truncated && sourceBytes !== textBytes) || (truncated && sourceBytes <= textBytes)) return null;

  return Object.freeze({
    contextId,
    attachment: Object.freeze({
      attachment_id: contextId,
      display_name: displayName,
      media_type: mediaType,
      source_bytes: sourceBytes,
      text,
      text_sha256: textSha256,
      truncated
    })
  });
}
