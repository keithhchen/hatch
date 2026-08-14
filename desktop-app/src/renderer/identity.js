/** Canonical authority identity: lower-case RFC 4122 UUID v4. */
export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value) {
  return typeof value === "string" && UUID_V4_RE.test(value);
}
