export const DEFAULT_CREATOR_AGENT = Object.freeze({
  id: "creator-agent",
  creator: "Creator",
  creatorInitials: "C",
  name: "Creator Agent",
  description: "Work with this Creator Agent in your own files and context.",
  boundary: "The Agent works within the scope defined by its Creator.",
  presentation: {}
});

export function creatorAgentFromSession(message) {
  const agent = message?.creator_agent;
  if (!agent?.creator?.name || !agent?.product?.name) return DEFAULT_CREATOR_AGENT;
  return Object.freeze({
    id: agent.product.id,
    creator: agent.creator.name,
    creatorInitials: initials(agent.creator.name),
    name: agent.product.name,
    description: agent.product.description || "Work with this Creator Agent in your own files and context.",
    boundary: "",
    presentation: agent.presentation || {}
  });
}

export function creatorAgentFromEntitlement(entitlement) {
  return creatorAgentFromSession({ creator_agent: entitlement });
}

function initials(name) {
  return String(name).trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() || "").join("") || "C";
}

export const PRODUCT_COPY = Object.freeze({
  home: "Your agents",
  workspaceRequired: "Choose a workspace to continue",
  activeRunGuard: "This task is still active. Stop or close it before starting another conversation."
});

export const READ_TOOLS = Object.freeze(["file_list", "file_search", "file_read", "git_diff"]);
export const SHELL_TOOLS = Object.freeze(["shell_exec"]);
export const CHANGE_TOOLS = Object.freeze(["file_write", "file_patch", ...SHELL_TOOLS]);

// This is the complete set of local tools understood by the desktop/runtime
// protocol. It is a capability declaration, not a grant: the selected
// permission policy and the Tauri sidecar still decide whether a request can
// be executed.
export const PLATFORM_LOCAL_TOOLS = Object.freeze([
  ...READ_TOOLS,
  ...CHANGE_TOOLS
]);
export const ADVERTISED_LOCAL_TOOLS = PLATFORM_LOCAL_TOOLS;

export const PERMISSION_POLICIES = Object.freeze({
  ASK_BEFORE_CHANGES: "ask-before-changes",
  ALLOW_CHANGES: "allow-changes"
});

export const PERMISSION_OPTIONS = Object.freeze([
  Object.freeze({
    value: PERMISSION_POLICIES.ASK_BEFORE_CHANGES,
    label: "Ask before changes",
    detail: "Ask before file changes and shell commands"
  }),
  Object.freeze({
    value: PERMISSION_POLICIES.ALLOW_CHANGES,
    label: "Allow changes",
    detail: "Allow file changes; ask before every shell command"
  })
]);

// Reads are automatic. Allow can cover structured file changes, but Shell is
// deliberately a separate high-risk capability and always requires a native
// per-command approval.
export const DEFAULT_PERMISSION_POLICY = PERMISSION_POLICIES.ASK_BEFORE_CHANGES;

function assertPermissionPolicy(policy) {
  if (!Object.values(PERMISSION_POLICIES).includes(policy)) {
    throw new Error(`Unknown permission policy: ${policy}`);
  }
}

export function normalizePermissionPolicy(policy) {
  return Object.values(PERMISSION_POLICIES).includes(policy)
    ? policy
    : DEFAULT_PERMISSION_POLICY;
}

export function requiresUserApproval(toolName, policy = DEFAULT_PERMISSION_POLICY) {
  assertPermissionPolicy(policy);
  return toolName === "shell_exec"
    || (CHANGE_TOOLS.includes(toolName) && policy !== PERMISSION_POLICIES.ALLOW_CHANGES);
}

export function shouldRequestDesktopApproval(toolRequest, policy = DEFAULT_PERMISSION_POLICY) {
  // Runtime metadata cannot turn automatic reads into consent prompts. The
  // user's Desktop change policy is the sole approval source.
  return requiresUserApproval(toolRequest?.name, policy);
}

export function permissionPolicyLabel(policy) {
  return PERMISSION_OPTIONS.find((option) => option.value === policy)?.label
    ?? PERMISSION_OPTIONS[0].label;
}

export function permissionPolicyDetail(policy) {
  return PERMISSION_OPTIONS.find((option) => option.value === policy)?.detail
    ?? PERMISSION_OPTIONS[0].detail;
}

export function canStartConversation({ activeRun, connected }) {
  if (activeRun) return { allowed: false, reason: PRODUCT_COPY.activeRunGuard };
  if (!connected) return { allowed: false, reason: "The connection is still restoring. Please wait a moment." };
  return { allowed: true, reason: "" };
}

export function workspaceGrantLabel(path) {
  if (!path) return "No folder granted";
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) || path;
}
