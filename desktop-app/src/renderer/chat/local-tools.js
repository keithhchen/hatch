export const READ_TOOLS = Object.freeze(["file_list", "file_search", "file_read", "git_diff"]);
export const CHANGE_TOOLS = Object.freeze(["file_write", "file_patch", "shell_exec"]);

/**
 * Every local tool the Desktop runner understands. This is a capability
 * declaration, not a grant: the native window's workspace grant and the
 * permission policy still decide whether a request runs.
 */
export const LOCAL_TOOLS = Object.freeze([...READ_TOOLS, ...CHANGE_TOOLS]);

export const PERMISSION_POLICIES = Object.freeze({
  ASK_BEFORE_CHANGES: "ask-before-changes",
  ALLOW_CHANGES: "allow-changes"
});
export const DEFAULT_PERMISSION_POLICY = PERMISSION_POLICIES.ASK_BEFORE_CHANGES;

export function normalizePermissionPolicy(policy) {
  return Object.values(PERMISSION_POLICIES).includes(policy) ? policy : DEFAULT_PERMISSION_POLICY;
}

/** Last path segment of a granted folder, for compact display. */
export function folderName(path) {
  const parts = String(path ?? "").replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || String(path ?? "");
}
