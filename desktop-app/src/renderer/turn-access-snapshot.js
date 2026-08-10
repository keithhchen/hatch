import { normalizePermissionPolicy } from "./product-policy.js";

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
