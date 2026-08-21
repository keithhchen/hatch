import { isUuidV4 } from "./identity.js";

export function runtimeBindingForEntitlement(entitlement) {
  if (!isUuidV4(entitlement?.entitlement_id)
    || !isUuidV4(entitlement?.creator_id)
    || !isUuidV4(entitlement?.product_id)) return null;
  return Object.freeze({
    entitlementId: entitlement.entitlement_id,
    productId: entitlement.product_id,
    creatorId: entitlement.creator_id
  });
}

export function runtimeBindingMatches(connectionConfig, binding) {
  if (!connectionConfig || !binding) return false;
  return connectionConfig.entitlementId === binding.entitlementId
    && String(connectionConfig.productId || "") === binding.productId
    && String(connectionConfig.creatorId || "") === binding.creatorId;
}

export function entitlementRefreshNeedsReconnect(connectionConfig, selectedEntitlement) {
  if (!connectionConfig) return false;
  return !runtimeBindingMatches(connectionConfig, runtimeBindingForEntitlement(selectedEntitlement));
}
