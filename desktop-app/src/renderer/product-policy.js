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
  workspaceScope: "Hatch works only with files inside the folder you choose.",
  activeRunGuard: "This task is still active. Stop or close it before starting another conversation."
});

export const READ_TOOLS = Object.freeze(["fs.list", "fs.search", "fs.read", "git.diff"]);
export const SHELL_TOOLS = Object.freeze(["shell.exec"]);
export const CHANGE_TOOLS = Object.freeze(["fs.write", "fs.patch", ...SHELL_TOOLS]);

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

// Reads are automatic. File changes and every shell command follow the same
// user-selected changes policy.
export const DEFAULT_PERMISSION_POLICY = PERMISSION_POLICIES.ASK_BEFORE_CHANGES;

export const LOCAL_TOOLS_BY_PERMISSION_POLICY = Object.freeze({
  [PERMISSION_POLICIES.ASK_BEFORE_CHANGES]: PLATFORM_LOCAL_TOOLS,
  [PERMISSION_POLICIES.ALLOW_CHANGES]: PLATFORM_LOCAL_TOOLS
});

function assertPermissionPolicy(policy) {
  if (!Object.hasOwn(LOCAL_TOOLS_BY_PERMISSION_POLICY, policy)) {
    throw new Error(`Unknown permission policy: ${policy}`);
  }
}

export function localToolsForPermissionPolicy(policy = DEFAULT_PERMISSION_POLICY) {
  assertPermissionPolicy(policy);
  return LOCAL_TOOLS_BY_PERMISSION_POLICY[policy];
}

export function normalizePermissionPolicy(policy) {
  return Object.hasOwn(LOCAL_TOOLS_BY_PERMISSION_POLICY, policy)
    ? policy
    : DEFAULT_PERMISSION_POLICY;
}

export function profileStorageKey(profileId, key) {
  if (!profileId || !key) throw new Error("profileId and key are required");
  return `hatch.profile.${encodeURIComponent(profileId)}.${key}`;
}

export function requiresUserApproval(toolName, policy = DEFAULT_PERMISSION_POLICY) {
  assertPermissionPolicy(policy);
  return CHANGE_TOOLS.includes(toolName) && policy !== PERMISSION_POLICIES.ALLOW_CHANGES;
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
