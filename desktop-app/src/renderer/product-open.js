const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PRODUCT_OPEN_EVENT = "hatch://product-open";

/**
 * Deep links are routing hints, never authorization. The Desktop must match
 * the entitlement against the signed-in Registry projection before selecting
 * it or opening Runtime.
 */
export function normalizeProductOpenLink(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "hatch:" || url.hostname !== "products" || url.pathname !== "/open") return null;
  const entitlementId = url.searchParams.get("entitlement_id") || "";
  const productId = url.searchParams.get("product_id") || "";
  const creatorId = url.searchParams.get("creator_id") || "";
  if (!UUID_V4_RE.test(entitlementId) || !UUID_V4_RE.test(productId)) return null;
  if (creatorId && !UUID_V4_RE.test(creatorId)) return null;
  return Object.freeze({ entitlementId, productId, creatorId });
}

export function normalizeProductOpenPayload(payload) {
  const values = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.urls)
      ? payload.urls
      : [payload];
  return values.map(normalizeProductOpenLink).filter(Boolean);
}
