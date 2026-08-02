import { describe, expect, it } from "vitest";
import {
  DEFAULT_CREATOR_AGENT,
  PRODUCT_COPY,
  creatorAgentFromSession,
  canStartConversation,
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

  it("guards new conversations while a run remains active", () => {
    expect(canStartConversation({ activeRun: { runId: "run_1" }, connected: true }))
      .toEqual({ allowed: false, reason: PRODUCT_COPY.activeRunGuard });
    expect(canStartConversation({ activeRun: null, connected: true }).allowed).toBe(true);
  });
});
