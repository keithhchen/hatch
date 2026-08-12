import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Desktop buyer catalog entrypoint", () => {
  it("redirects the legacy /agents allowlist path to the public Explore catalog", async () => {
    const caddyfile = await readFile(new URL("../../../Caddyfile", import.meta.url), "utf8");
    const redirect = "redir @legacy_agents /explore 308";

    expect(caddyfile).toContain("@legacy_agents path /agents /agents/*");
    expect(caddyfile).toContain(redirect);
    expect(caddyfile.indexOf(redirect)).toBeLessThan(caddyfile.indexOf("handle /portal*"));
    expect(caddyfile.indexOf(redirect)).toBeLessThan(caddyfile.indexOf("handle {"));
  });
});
