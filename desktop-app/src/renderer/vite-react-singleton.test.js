import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import viteConfig from "../../vite.config.js";

const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

describe("desktop Vite React boundary", () => {
  it("deduplicates React for workspace UI packages", () => {
    expect(viteConfig.resolve?.dedupe).toEqual(
      expect.arrayContaining(["react", "react-dom"])
    );
  });

  it("serves shared workspace font assets during local development", () => {
    expect(viteConfig.server?.fs?.allow?.some((entry) => path.resolve(entry) === workspaceRoot)).toBe(true);
  });
});
