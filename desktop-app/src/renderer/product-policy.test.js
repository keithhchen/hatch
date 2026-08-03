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

  it("advertises shell as a protocol local tool without changing the read/change groups", () => {
    expect(READ_TOOLS).toEqual(["fs.list", "fs.search", "fs.read", "git.diff"]);
    expect(CHANGE_TOOLS).toEqual(["fs.write", "fs.patch"]);
    expect(SHELL_TOOLS).toEqual(["shell.exec"]);
    expect(PLATFORM_LOCAL_TOOLS).toEqual([...READ_TOOLS, ...CHANGE_TOOLS, ...SHELL_TOOLS]);
    expect(ADVERTISED_LOCAL_TOOLS).toEqual(PLATFORM_LOCAL_TOOLS);
  });

  it("maps permission policies to safe local tool capabilities", () => {
    expect(DEFAULT_PERMISSION_POLICY).toBe(PERMISSION_POLICIES.ASK_BEFORE_CHANGES);
    expect(LOCAL_TOOLS_BY_PERMISSION_POLICY[PERMISSION_POLICIES.READ_ONLY])
      .toEqual(READ_TOOLS);
    expect(localToolsForPermissionPolicy(PERMISSION_POLICIES.ASK_BEFORE_CHANGES))
      .toEqual([...READ_TOOLS, ...CHANGE_TOOLS]);
    expect(localToolsForPermissionPolicy(PERMISSION_POLICIES.ALLOW_CHANGES))
      .toEqual([...READ_TOOLS, ...CHANGE_TOOLS]);
    expect(localToolsForPermissionPolicy(PERMISSION_POLICIES.ASK_BEFORE_CHANGES, { enableShell: true }))
      .toEqual([...READ_TOOLS, ...CHANGE_TOOLS, ...SHELL_TOOLS]);
    expect(() => localToolsForPermissionPolicy(PERMISSION_POLICIES.READ_ONLY, { enableShell: true }))
      .toThrow(/read-only policy/);
  });

  it("keeps shell approval mandatory even when file changes are allowed", () => {
    expect(requiresUserApproval("fs.write", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
    expect(requiresUserApproval("fs.patch", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(false);
    expect(requiresUserApproval("shell.exec", PERMISSION_POLICIES.ALLOW_CHANGES)).toBe(true);
  });

  it("guards new conversations while a run remains active", () => {
    expect(canStartConversation({ activeRun: { runId: "run_1" }, connected: true }))
      .toEqual({ allowed: false, reason: PRODUCT_COPY.activeRunGuard });
    expect(canStartConversation({ activeRun: null, connected: true }).allowed).toBe(true);
  });
});
