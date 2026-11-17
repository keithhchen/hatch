import { UUID_V4_RE } from "../identity.js";

export const PRODUCT_OPEN_EVENT = "hatch://product-open";

/**
 * `hatch://products/open?product_id=…` is a routing hint,
 * never authorization: Desktop selects the Agent only if the signed-in
 * account's Agent list contains that product.
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
  const productId = url.searchParams.get("product_id") || "";
  if (!UUID_V4_RE.test(productId)) return null;
  return Object.freeze({ productId });
}

export function normalizeProductOpenPayload(payload) {
  const values = Array.isArray(payload) ? payload : Array.isArray(payload?.urls) ? payload.urls : [payload];
  return values.map(normalizeProductOpenLink).filter(Boolean);
}
