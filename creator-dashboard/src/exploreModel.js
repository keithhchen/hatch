import { isProductLive } from "./studioPath.js";
import { WebChatRoute } from "./webChatRoute.js";

// /explore and /library are projections of three real sources: the public
// catalog, the account's own Products (Studio) and the Agents it saved to its
// library by chatting with them. "My library" lists what can be chatted with
// now, in two groups: saved Agents (which can be removed) and my own published
// Agents. Products still being built are only counted, and live in Studio.
// Discover shows the whole catalog, including my own and saved Agents.

const idOf = (value) => String(value ?? "");
const timeOf = (...values) => {
  for (const value of values) {
    const time = Date.parse(value ?? "");
    if (Number.isFinite(time)) return time;
  }
  return 0;
};

/** One of my published Products: the owner chats without saving it. */
export function ownedAgentRow(product) {
  const productId = idOf(product.product_id ?? product.id);
  return {
    key: `owned:${productId}`,
    kind: "owned",
    productId,
    name: product.name ?? product.product_name ?? "",
    creator: null,
    at: timeOf(product.published_at, product.updated_at, product.created_at),
    href: WebChatRoute.productPath(productId)
  };
}

/** An Agent this account saved to its library: one library entry. */
export function savedAgentRow(entry) {
  const product = entry.product ?? {};
  const productId = idOf(entry.product_id ?? product.product_id ?? product.id);
  return {
    key: `saved:${productId}`,
    kind: "saved",
    productId,
    name: product.name ?? entry.product_name ?? "",
    creator: entry.creator ?? null,
    at: timeOf(entry.granted_at, entry.valid_from, entry.created_at),
    href: WebChatRoute.productPath(productId)
  };
}

/** Takes an Agent out of the library. The conversations stay; chatting again saves it again. */
export const removeFromLibrary = (request, productId) => request(`/v1/library/${encodeURIComponent(productId)}`, { method: "DELETE" });

export function exploreModel({ accountId, ownedProducts = [], saved = [], catalog = [] }) {
  const me = idOf(accountId);
  const seen = new Set();
  const unique = (rows) => rows
    .sort((left, right) => right.at - left.at)
    .filter((row) => row.productId && !seen.has(row.productId) && seen.add(row.productId));
  const published = unique(ownedProducts.filter(isProductLive).map(ownedAgentRow));
  const savedRows = unique(saved
    .filter((entry) => idOf(entry.creator_id) !== me)
    .map(savedAgentRow));
  return {
    saved: savedRows,
    published,
    draftCount: ownedProducts.filter((product) => !isProductLive(product) && product.status !== "withdrawn").length,
    discover: catalog
  };
}
