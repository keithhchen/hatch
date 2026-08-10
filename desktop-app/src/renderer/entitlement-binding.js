export function runtimeBindingForEntitlement(entitlement) {
  if (!entitlement?.entitlement_id) return null;
  return Object.freeze({
    entitlementId: entitlement.entitlement_id,
    agentId: entitlement.agent_id || "",
    creatorId: entitlement.creator_id || ""
  });
}

export function runtimeBindingMatches(connectionConfig, binding) {
  if (!connectionConfig || !binding) return false;
  return connectionConfig.entitlementId === binding.entitlementId
    && String(connectionConfig.agentId || "") === binding.agentId
    && String(connectionConfig.creatorId || "") === binding.creatorId;
}

export function entitlementRefreshNeedsReconnect(connectionConfig, selectedEntitlement) {
  if (!connectionConfig) return false;
  return !runtimeBindingMatches(connectionConfig, runtimeBindingForEntitlement(selectedEntitlement));
}
