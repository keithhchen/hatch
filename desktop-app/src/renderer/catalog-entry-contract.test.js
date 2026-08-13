import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Desktop buyer catalog entrypoint", () => {
  it("uses the canonical public Explore entrypoint without legacy aliases", async () => {
    const caddyfile = await readFile(new URL("../../../Caddyfile", import.meta.url), "utf8");
    expect(caddyfile).toContain("handle /assets/*");
    expect(caddyfile).toContain("handle {");
    expect(caddyfile).not.toContain("/agents");
    expect(caddyfile).not.toContain("/portal");
  });
});
