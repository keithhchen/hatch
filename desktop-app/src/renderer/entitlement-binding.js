export function runtimeBindingForEntitlement(entitlement) {
  if (!entitlement?.entitlement_id) return null;
  return Object.freeze({
    entitlementId: entitlement.entitlement_id,
    productId: entitlement.product_id || entitlement.product?.id || "",
    agentId: entitlement.product_id || entitlement.product?.id || "",
    creatorId: entitlement.creator_id || ""
  });
}

export function runtimeBindingMatches(connectionConfig, binding) {
  if (!connectionConfig || !binding) return false;
  return connectionConfig.entitlementId === binding.entitlementId
    && String(connectionConfig.productId || connectionConfig.agentId || "") === (binding.productId || binding.agentId)
    && String(connectionConfig.creatorId || "") === binding.creatorId;
}

export function entitlementRefreshNeedsReconnect(connectionConfig, selectedEntitlement) {
  if (!connectionConfig) return false;
  return !runtimeBindingMatches(connectionConfig, runtimeBindingForEntitlement(selectedEntitlement));
}
