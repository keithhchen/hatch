import { describe, expect, it } from "vitest";
import viteConfig from "../../vite.config.js";

describe("desktop Vite React boundary", () => {
  it("deduplicates React for workspace UI packages", () => {
    expect(viteConfig.resolve?.dedupe).toEqual(
      expect.arrayContaining(["react", "react-dom"])
    );
  });

  it("serves shared workspace font assets during local development", () => {
    expect(viteConfig.server?.fs?.allow).toEqual(
      expect.arrayContaining([expect.stringMatching(/\/hatch\/?$/)])
    );
  });
});
