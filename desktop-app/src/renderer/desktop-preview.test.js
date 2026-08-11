import { describe, expect, it } from "vitest";
import { previewArtifactRelativePath } from "./desktop-preview.jsx";

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
});
