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
  readPolicy: "Hatch can only read files inside the folder you choose.",
  changePolicy: "File changes and shell commands stay inside your workspace and ask for approval.",
  activeRunGuard: "This task is still active. Stop or close it before starting another conversation."
});

export const READ_TOOLS = Object.freeze(["fs.list", "fs.search", "fs.read", "git.diff"]);
export const CHANGE_TOOLS = Object.freeze(["fs.write", "fs.patch"]);
export const SHELL_TOOLS = Object.freeze(["shell.exec"]);

// This is the complete set of local tools understood by the desktop/runtime
// protocol. It is a capability declaration, not a grant: the selected
// permission policy and the Tauri sidecar still decide whether a request can
// be executed.
export const PLATFORM_LOCAL_TOOLS = Object.freeze([
  ...READ_TOOLS,
  ...CHANGE_TOOLS,
  ...SHELL_TOOLS
]);
export const ADVERTISED_LOCAL_TOOLS = PLATFORM_LOCAL_TOOLS;

export const PERMISSION_POLICIES = Object.freeze({
  READ_ONLY: "read-only",
  ASK_BEFORE_CHANGES: "ask-before-changes",
  ALLOW_CHANGES: "allow-changes"
});

// Keep the existing desktop behavior as the safe default: reads are automatic
// and file changes require an in-window approval. Shell is opt-in separately.
export const DEFAULT_PERMISSION_POLICY = PERMISSION_POLICIES.ASK_BEFORE_CHANGES;

export const LOCAL_TOOLS_BY_PERMISSION_POLICY = Object.freeze({
  [PERMISSION_POLICIES.READ_ONLY]: READ_TOOLS,
  [PERMISSION_POLICIES.ASK_BEFORE_CHANGES]: Object.freeze([...READ_TOOLS, ...CHANGE_TOOLS]),
  [PERMISSION_POLICIES.ALLOW_CHANGES]: Object.freeze([...READ_TOOLS, ...CHANGE_TOOLS])
});

function assertPermissionPolicy(policy) {
  if (!Object.hasOwn(LOCAL_TOOLS_BY_PERMISSION_POLICY, policy)) {
    throw new Error(`Unknown permission policy: ${policy}`);
  }
}

/**
 * Resolve the local capabilities for a user-selected policy.
 * `enableShell` is deliberately explicit because shell is never part of the
 * default policy, even when file changes are allowed.
 */
export function localToolsForPermissionPolicy(
  policy = DEFAULT_PERMISSION_POLICY,
  { enableShell = false } = {}
) {
  assertPermissionPolicy(policy);
  if (enableShell && policy === PERMISSION_POLICIES.READ_ONLY) {
    throw new Error("shell.exec is not compatible with the read-only policy");
  }
  return Object.freeze([
    ...LOCAL_TOOLS_BY_PERMISSION_POLICY[policy],
    ...(enableShell ? SHELL_TOOLS : [])
  ]);
}

export function requiresUserApproval(toolName, policy = DEFAULT_PERMISSION_POLICY) {
  assertPermissionPolicy(policy);
  if (toolName === "shell.exec") return true;
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
