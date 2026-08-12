import { describe, expect, it } from "vitest";
import {
  DEFAULT_CREATOR_AGENT,
  ADVERTISED_LOCAL_TOOLS,
  CHANGE_TOOLS,
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_OPTIONS,
  PERMISSION_POLICIES,
  PLATFORM_LOCAL_TOOLS,
  PRODUCT_COPY,
  READ_TOOLS,
  SHELL_TOOLS,
  creatorAgentFromBoundSession,
  creatorAgentFromSession,
  canStartConversation,
  normalizePermissionPolicy,
  permissionPolicyDetail,
  permissionPolicyLabel,
  requiresUserApproval,
  shouldRequestDesktopApproval
} from "./product-policy.js";

describe("consumer product contract", () => {
  it("uses generic agent-home copy while presenting the demo creator", () => {
    expect(PRODUCT_COPY.home).toBe("Your agents");
    expect(DEFAULT_CREATOR_AGENT.name).toBe("Creator Agent");
    expect(PRODUCT_COPY.workspaceRequired).toMatch(/workspace/i);
  });

  it("renders Creator identity from public Release metadata", () => {
    expect(creatorAgentFromSession({
      creator_agent: {
        creator: { id: "creator-1", name: "Ari Cole" },
        product: { id: "plan", name: "Adaptive Plan", description: "A useful plan." },
        presentation: { accent: "green" }
      }
    })).toEqual({
      id: "plan", creator: "Ari Cole", creatorInitials: "AC", name: "Adaptive Plan",
      description: "A useful plan.", boundary: "", presentation: { accent: "green" }
    });
  });

  it("preserves the entitlement Agent when session metadata is missing or belongs to another binding", () => {
    const current = { id: "agent-a", name: "Agent A" };
    const entitlement = {
      entitlement_id: "entitlement-a",
      agent_id: "agent-a",
      creator_id: "creator-a"
    };
    expect(creatorAgentFromBoundSession({ type: "session.ready" }, entitlement, current)).toBe(current);
    expect(creatorAgentFromBoundSession({
      type: "session.ready",
      entitlement_id: "entitlement-b",
      agent_id: "agent-b",
      creator_id: "creator-b",
      creator_agent: {
        creator: { id: "creator-b", name: "Creator B" },
        product: { id: "agent-b", name: "Agent B" },
        presentation: {}
      }
    }, entitlement, current)).toBe(current);
  });

  it("accepts a Runtime Agent projection only for the selected entitlement binding", () => {
    const projected = creatorAgentFromBoundSession({
      type: "session.ready",
      entitlement_id: "entitlement-a",
      agent_id: "agent-a",
      creator_id: "creator-a",
      creator_agent: {
        creator: { id: "creator-a", name: "Creator A" },
        product: { id: "agent-a", name: "Agent A", description: "Bound projection" },
        presentation: { accent: "orange" }
      }
    }, {
      entitlement_id: "entitlement-a",
      agent_id: "agent-a",
      creator_id: "creator-a"
    }, { id: "old", name: "Old" });
    expect(projected).toMatchObject({ id: "agent-a", name: "Agent A", creator: "Creator A" });
  });

  it.each(["file_write", "file_patch", "shell_exec"])("requires approval for %s", (tool) => {
    expect(requiresUserApproval(tool)).toBe(true);
  });

  it("does not require per-call approval for reads after a workspace grant", () => {
    expect(requiresUserApproval("file_read")).toBe(false);
    expect(shouldRequestDesktopApproval({ name: "file_read", approval: "ask" })).toBe(false);
    expect(shouldRequestDesktopApproval({ name: "file_list", approval: "ask" })).toBe(false);
  });

  it("treats every shell command as a change while advertising all local tools", () => {
    expect(READ_TOOLS).toEqual(["file_list", "file_search", "file_read", "git_diff"]);
    expect(SHELL_TOOLS).toEqual(["shell_exec"]);
    expect(CHANGE_TOOLS).toEqual(["file_write", "file_patch", "shell_exec"]);
    expect(PLATFORM_LOCAL_TOOLS).toEqual([...READ_TOOLS, ...CHANGE_TOOLS]);
    expect(ADVERTISED_LOCAL_TOOLS).toEqual(PLATFORM_LOCAL_TOOLS);
  });

  it("keeps the complete hello capability declaration independent of Ask/Allow", () => {
    expect(DEFAULT_PERMISSION_POLICY).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    const helloForAsk = { local_tools: [...PLATFORM_LOCAL_TOOLS] };
    const helloForAllow = { local_tools: [...PLATFORM_LOCAL_TOOLS] };
    expect(helloForAsk.local_tools).toEqual(helloForAllow.local_tools);
    expect(helloForAsk.local_tools).toContain("shell_exec");
  });

  it("migrates removed or unknown permission policies to ask before changes", () => {
    expect(normalizePermissionPolicy("read-only")).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    expect(normalizePermissionPolicy("unknown")).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    expect(normalizePermissionPolicy(PERMISSION_POLICIES.ALLOW_CHANGES))
      .toBe(PERMISSION_POLICIES.ALLOW_CHANGES);
  });

  it("uses precise change-policy labels without implying unrestricted access", () => {
    expect(PERMISSION_OPTIONS.map((option) => option.label))
      .toEqual(["Ask before changes", "Allow changes"]);
    expect(permissionPolicyLabel(PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe("Ask before changes");
    expect(permissionPolicyLabel(PERMISSION_POLICIES.ALLOW_CHANGES)).toBe("Allow changes");
    expect(permissionPolicyDetail(PERMISSION_POLICIES.ALLOW_CHANGES)).toMatch(/file changes and shell commands/);
    expect(PERMISSION_OPTIONS.map((option) => `${option.label} ${option.detail}`).join(" "))
      .not.toMatch(/full access|完全访问/i);
  });

  it("lets Allow cover every change tool, including shell commands", () => {
    expect(requiresUserApproval("file_write", PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe(true);
    expect(requiresUserApproval("file_patch", PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe(true);
    expect(requiresUserApproval("shell_exec", PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe(true);
    expect(requiresUserApproval("file_write", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
    expect(requiresUserApproval("file_patch", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
    expect(requiresUserApproval("shell_exec", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
  });

  it("guards new conversations while a run remains active", () => {
    expect(canStartConversation({ activeRun: { runId: "run_1" }, connected: true }))
      .toEqual({ allowed: false, reason: PRODUCT_COPY.activeRunGuard });
    expect(canStartConversation({ activeRun: null, connected: true }).allowed).toBe(true);
  });
});
