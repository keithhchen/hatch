import { normalizePermissionPolicy, PERMISSION_POLICIES } from "./product-policy.js";

// A pending logical message owns its send-time grant, never today's selection.
// Missing legacy snapshots must be reconciled, not filled from current settings.
export function requirePendingAccessSnapshot(pending) {
  const saved = pending?.accessSnapshot;
  if (!saved || typeof saved.workspaceGrantId !== "string" || !saved.workspaceGrantId.trim()
    || typeof saved.displayPath !== "string"
    || !Object.values(PERMISSION_POLICIES).includes(saved.permissionMode)) {
    throw new Error("This pending message has no valid saved execution context. Check its submission status before returning it to the draft.");
  }
  return createTurnAccessSnapshot(saved.workspaceGrantId, saved.displayPath, saved.permissionMode);
}

export function createTurnAccessSnapshot(workspaceGrantId, displayPath, permissionMode) {
  return Object.freeze({
    workspaceGrantId: typeof workspaceGrantId === "string" ? workspaceGrantId.trim() : "",
    displayPath: typeof displayPath === "string" ? displayPath.trim() : "",
    permissionMode: normalizePermissionPolicy(permissionMode)
  });
}

export function accessSnapshotForToolCall(activeRun, fallback) {
  const saved = activeRun?.accessSnapshot;
  if (saved && typeof saved.workspaceGrantId === "string" && saved.workspaceGrantId && saved.permissionMode) {
    return createTurnAccessSnapshot(saved.workspaceGrantId, saved.displayPath, saved.permissionMode);
  }
  return createTurnAccessSnapshot(fallback?.workspaceGrantId, fallback?.displayPath, fallback?.permissionMode);
}
