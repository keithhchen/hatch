import { isProductLive } from "./studioPath.js";
import { WebChatRoute } from "./webChatRoute.js";

// /explore is a projection of three real sources: the public catalog, the
// account's own Products (Studio) and the Agents it acquired (entitlements).
// "My Agents" lists only what can be chatted with now; Products still being
// built are only counted, and live in Studio.

const idOf = (value) => String(value ?? "");
const timeOf = (...values) => {
  for (const value of values) {
    const time = Date.parse(value ?? "");
    if (Number.isFinite(time)) return time;
  }
  return 0;
};

/** One of my published Products: the owner chats without acquiring it. */
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

/** An Agent this account acquired from someone else. */
export function acquiredAgentRow(entitlement) {
  const product = entitlement.product ?? {};
  const productId = idOf(entitlement.product_id ?? product.product_id ?? product.id);
  return {
    key: `acquired:${idOf(entitlement.entitlement_id)}`,
    kind: "acquired",
    productId,
    name: product.name ?? entitlement.product_name ?? "",
    creator: entitlement.creator ?? null,
    at: timeOf(entitlement.granted_at, entitlement.valid_from, entitlement.created_at),
    href: WebChatRoute.productPath(productId)
  };
}

export function exploreModel({ accountId, ownedProducts = [], acquired = [], catalog = [] }) {
  const me = idOf(accountId);
  const live = ownedProducts.filter(isProductLive);
  const seen = new Set();
  const myAgents = [
    ...live.map(ownedAgentRow),
    ...acquired
      .filter((entry) => entry.entitlement_id && idOf(entry.creator_id) !== me)
      .map(acquiredAgentRow)
  ]
    .sort((left, right) => right.at - left.at)
    .filter((row) => row.productId && !seen.has(row.productId) && seen.add(row.productId));
  const discover = catalog.filter((product) => {
    const productId = idOf(product.product_id ?? product.id);
    return (!me || idOf(product.creator_id ?? product.creator?.id) !== me) && !seen.has(productId);
  });
  return {
    myAgents,
    draftCount: ownedProducts.filter((product) => !isProductLive(product) && product.status !== "withdrawn").length,
    discover
  };
}
