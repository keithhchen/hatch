export const STALE_WORKSPACE_STATUS = "Your previous workspace is no longer available. Choose the folder again to continue.";

export function isInvalidWorkspaceGrantError(error) {
  const message = typeof error === "string" ? error : error?.message;
  return /workspace_grant_(?:missing|stale|revoked|denied|invalid)/.test(String(message || ""));
}

export function normalizeWorkspaceGrant(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const grantId = typeof value.grant_id === "string" ? value.grant_id.trim() : "";
  const displayPath = typeof value.display_path === "string" ? value.display_path.trim() : "";
  if (!grantId || !displayPath) return null;
  return Object.freeze({ grant_id: grantId, display_path: displayPath });
}

export async function validateRestoredWorkspace(savedGrant, ensureWorkspace) {
  const candidate = normalizeWorkspaceGrant(savedGrant);
  if (!candidate) {
    return {
      state: "missing",
      workspace: "",
      status: "Choose a workspace folder to continue."
    };
  }

  try {
    const normalized = normalizeWorkspaceGrant(await ensureWorkspace(candidate.grant_id));
    if (!normalized || normalized.grant_id !== candidate.grant_id) throw new Error("The native workspace validator returned an invalid grant.");
    return {
      state: "valid",
      grant: normalized,
      workspace: normalized.display_path,
      status: "Folder access restored"
    };
  } catch (error) {
    return {
      state: "stale",
      workspace: "",
      staleGrant: candidate,
      status: STALE_WORKSPACE_STATUS,
      error
    };
  }
}

export function workspacePickerSelection(currentGrant, selectedPath) {
  const selected = normalizeWorkspaceGrant(selectedPath);
  if (!selected) {
    return { ...currentGrant, changed: false };
  }
  return {
    ...currentGrant,
    draft: selected.display_path,
    pendingGrant: selected,
    changed: true
  };
}
