import { isProductLive } from "./studioPath.js";
import { creatorProductPath } from "./creatorRoutes.js";
import { WebChatRoute } from "./webChatRoute.js";

// The signed-in home is a projection of three real sources: the account's own
// Products (Studio), the Agents it acquired (entitlements) and the public
// catalog. Every card opens one Agent; conversations live inside that Agent.

const idOf = (value) => String(value ?? "");

/** One of my Products: live opens chat (owner access), anything else opens Studio. */
export function ownedAgentCard(product) {
  const productId = idOf(product.product_id ?? product.id);
  const live = isProductLive(product);
  return {
    key: `owned:${productId}`,
    kind: live ? "owned_live" : "owned_draft",
    productId,
    name: product.name ?? product.product_name ?? "",
    summary: product.promise ?? product.product_promise ?? product.description ?? product.product_description ?? "",
    href: live ? WebChatRoute.productPath(productId) : creatorProductPath(productId)
  };
}

/** An Agent this account acquired from someone else: always chat. */
export function acquiredAgentCard(entitlement) {
  const product = entitlement.product ?? {};
  const productId = idOf(entitlement.product_id ?? product.product_id ?? product.id);
  return {
    key: `acquired:${idOf(entitlement.entitlement_id)}`,
    kind: "acquired",
    productId,
    name: product.name ?? entitlement.product_name ?? "",
    summary: product.promise ?? product.description ?? "",
    creator: entitlement.creator ?? null,
    href: WebChatRoute.productPath(productId)
  };
}

export function homeModel({ accountId, ownedProducts = [], acquired = [], catalog = [] }) {
  const me = idOf(accountId);
  const mine = ownedProducts.map(ownedAgentCard);
  const acquiredCards = acquired
    .filter((entry) => entry.entitlement_id && idOf(entry.creator_id) !== me)
    .map(acquiredAgentCard);
  const discover = catalog.filter((product) => idOf(product.creator_id ?? product.creator?.id) !== me);
  return {
    empty: mine.length === 0 && acquiredCards.length === 0,
    mine,
    acquired: acquiredCards,
    discover
  };
}
