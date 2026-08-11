import { englishMessage } from "./i18n.js";

export const STALE_WORKSPACE_STATUS = englishMessage("workspace.status.stale");
export const STALE_WORKSPACE_STATUS_KEY = "workspace.status.stale";
export const MISSING_WORKSPACE_STATUS_KEY = "workspace.status.chooseFolder";
export const RESTORED_WORKSPACE_STATUS_KEY = "workspace.status.restored";

const WORKSPACE_ERROR_KEYS = Object.freeze({
  workspace_grant_missing: "workspace.chooseBeforeStart",
  workspace_grant_invalid: "error.workspace.invalidSelection",
  workspace_grant_denied: "error.workspace.accessDenied",
  workspace_grant_stale: "workspace.status.stale",
  workspace_grant_revoked: "workspace.status.stale",
  workspace_grant_unavailable: "error.workspace.unavailable",
  workspace_grant_store_invalid: "error.workspace.unavailable",
  workspace_grant_store_unavailable: "error.workspace.unavailable"
});

export function isInvalidWorkspaceGrantError(error) {
  return /workspace_grant_(?:missing|stale|revoked|denied|invalid)/.test(errorText(error));
}

export function isWorkspaceGrantError(error) {
  return /^workspace_grant_[a-z_]+(?::|$)/.test(errorText(error));
}

export function localizedWorkspaceCommandError(error) {
  if (error?.i18nKey) return error;
  const code = errorText(error).match(/^(workspace_grant_[a-z_]+)(?::|$)/)?.[1]
    ?? "workspace_grant_unavailable";
  const i18nKey = WORKSPACE_ERROR_KEYS[code] ?? "error.workspace.unavailable";
  const localized = new Error(englishMessage(i18nKey));
  localized.code = code;
  localized.i18nKey = i18nKey;
  localized.i18nValues = {};
  localized.cause = error;
  return localized;
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
      status: englishMessage(MISSING_WORKSPACE_STATUS_KEY),
      statusKey: MISSING_WORKSPACE_STATUS_KEY
    };
  }

  try {
    const normalized = normalizeWorkspaceGrant(await ensureWorkspace(candidate.grant_id));
    if (!normalized || normalized.grant_id !== candidate.grant_id) {
      throw localizedError(
        englishMessage("error.workspace.invalidGrantValidation"),
        "error.workspace.invalidGrantValidation"
      );
    }
    return {
      state: "valid",
      grant: normalized,
      workspace: normalized.display_path,
      status: englishMessage(RESTORED_WORKSPACE_STATUS_KEY),
      statusKey: RESTORED_WORKSPACE_STATUS_KEY
    };
  } catch (error) {
    return {
      state: "stale",
      workspace: "",
      staleGrant: candidate,
      status: STALE_WORKSPACE_STATUS,
      statusKey: STALE_WORKSPACE_STATUS_KEY,
      error: annotateError(error, error?.i18nKey || "error.workspace.restoreFailed")
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

function localizedError(message, i18nKey) {
  return annotateError(new Error(message), i18nKey);
}

function annotateError(error, i18nKey) {
  if (!error || typeof error !== "object") return error;
  error.i18nKey = i18nKey;
  return error;
}

function errorText(error) {
  return String(typeof error === "string" ? error : error?.message ?? "");
}
