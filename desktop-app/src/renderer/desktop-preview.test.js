import { describe, expect, it } from "vitest";
import { normalizePreviewWindowContext, previewArtifactRelativePath } from "./desktop-preview.jsx";

describe("desktop preview artifact UAT helper", () => {
  it("accepts only normalized workspace-relative paths", () => {
    expect(previewArtifactRelativePath("docs/spec.md")).toBe("docs/spec.md");
    expect(previewArtifactRelativePath("docs\\spec.md")).toBe("docs/spec.md");
  });

  it("rejects absolute paths, traversal and control text", () => {
    for (const value of ["", "/tmp/spec.md", "../spec.md", "docs/../spec.md", "C:/spec.md", "docs/\u0000spec.md"]) {
      expect(previewArtifactRelativePath(value)).toBe("");
    }
  });

  it("normalizes the native per-window preview context without restoring unsafe fields", () => {
    expect(normalizePreviewWindowContext({
      conversationId: "conv-other-window",
      composerDraft: "draft stays in this window",
      scrollTop: "128.5",
      selectedAgentId: "maya",
      workspaceGrant: { grant_id: "workspace_1", display_path: "/private/path" },
      accountId: "must-not-be-used-by-preview"
    })).toEqual({
      composerDraft: "draft stays in this window",
      scrollTop: 128.5,
      selectedAgentId: "maya",
      workspaceGrant: { grant_id: "workspace_1", display_path: "/private/path" }
    });
  });

  it("drops malformed context and clamps scroll positions", () => {
    expect(normalizePreviewWindowContext({
      composerDraft: 42,
      scrollTop: -12,
      selectedAgentId: "  ",
      workspaceGrant: { display_path: "/no-id" }
    })).toEqual({
      composerDraft: "",
      scrollTop: 0,
      selectedAgentId: "",
      workspaceGrant: null
    });
  });
});
