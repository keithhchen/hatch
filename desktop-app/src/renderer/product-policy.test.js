import { describe, expect, it } from "vitest";
import {
  DEFAULT_CREATOR_AGENT,
  ADVERTISED_LOCAL_TOOLS,
  CHANGE_TOOLS,
  DEFAULT_PERMISSION_POLICY,
  LOCAL_TOOLS_BY_PERMISSION_POLICY,
  PERMISSION_POLICIES,
  PLATFORM_LOCAL_TOOLS,
  PRODUCT_COPY,
  READ_TOOLS,
  SHELL_TOOLS,
  creatorAgentFromSession,
  canStartConversation,
  localToolsForPermissionPolicy,
  normalizePermissionPolicy,
  profileStorageKey,
  requiresUserApproval
} from "./product-policy.js";

describe("consumer product contract", () => {
  it("uses generic agent-home copy while presenting the demo creator", () => {
    expect(PRODUCT_COPY.home).toBe("Your agents");
    expect(DEFAULT_CREATOR_AGENT.name).toBe("Creator Agent");
    expect(PRODUCT_COPY.workspaceRequired).not.toMatch(/resume/i);
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

  it("isolates persisted state by signed-in profile", () => {
    expect(profileStorageKey("buyer_fixture", "workspaceRoot"))
      .not.toBe(profileStorageKey("buyer_someone_else", "workspaceRoot"));
  });

  it.each(["fs.write", "fs.patch", "shell.exec"])("requires approval for %s", (tool) => {
    expect(requiresUserApproval(tool)).toBe(true);
  });

  it("does not require per-call approval for reads after a workspace grant", () => {
    expect(requiresUserApproval("fs.read")).toBe(false);
  });

  it("treats every shell command as a change while advertising all local tools", () => {
    expect(READ_TOOLS).toEqual(["fs.list", "fs.search", "fs.read", "git.diff"]);
    expect(SHELL_TOOLS).toEqual(["shell.exec"]);
    expect(CHANGE_TOOLS).toEqual(["fs.write", "fs.patch", "shell.exec"]);
    expect(PLATFORM_LOCAL_TOOLS).toEqual([...READ_TOOLS, ...CHANGE_TOOLS]);
    expect(ADVERTISED_LOCAL_TOOLS).toEqual(PLATFORM_LOCAL_TOOLS);
  });

  it("always exposes shell and change capabilities for both permission policies", () => {
    expect(DEFAULT_PERMISSION_POLICY).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    expect(localToolsForPermissionPolicy(PERMISSION_POLICIES.ASK_BEFORE_CHANGES))
      .toEqual(PLATFORM_LOCAL_TOOLS);
    expect(localToolsForPermissionPolicy(PERMISSION_POLICIES.ALLOW_CHANGES))
      .toEqual(PLATFORM_LOCAL_TOOLS);
    expect(LOCAL_TOOLS_BY_PERMISSION_POLICY).not.toHaveProperty("read-only");
  });

  it("migrates removed or unknown permission policies to ask before changes", () => {
    expect(normalizePermissionPolicy("read-only")).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    expect(normalizePermissionPolicy("unknown")).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    expect(normalizePermissionPolicy(PERMISSION_POLICIES.ALLOW_CHANGES))
      .toBe(PERMISSION_POLICIES.ALLOW_CHANGES);
  });

  it("applies the selected changes policy to files and every shell command", () => {
    expect(requiresUserApproval("fs.write", PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe(true);
    expect(requiresUserApproval("fs.patch", PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe(true);
    expect(requiresUserApproval("shell.exec", PERMISSION_POLICIES.ASK_BEFORE_CHANGES)).toBe(true);
    expect(requiresUserApproval("fs.write", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
    expect(requiresUserApproval("fs.patch", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
    expect(requiresUserApproval("shell.exec", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
  });

  it("guards new conversations while a run remains active", () => {
    expect(canStartConversation({ activeRun: { runId: "run_1" }, connected: true }))
      .toEqual({ allowed: false, reason: PRODUCT_COPY.activeRunGuard });
    expect(canStartConversation({ activeRun: null, connected: true }).allowed).toBe(true);
  });
});
