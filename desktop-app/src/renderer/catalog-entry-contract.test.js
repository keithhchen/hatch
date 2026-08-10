import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Desktop buyer catalog entrypoint", () => {
  it("redirects the fixed /agents allowlist path to the buyer Portal catalog", async () => {
    const caddyfile = await readFile(new URL("../../../Caddyfile", import.meta.url), "utf8");
    const matcher = "@buyer_catalog_entry path /agents /agents/*";
    const redirect = "redir @buyer_catalog_entry /portal/ 308";

    expect(caddyfile).toContain(matcher);
    expect(caddyfile).toContain(redirect);
    expect(caddyfile.indexOf(redirect)).toBeLessThan(caddyfile.indexOf("handle /portal*"));
    expect(caddyfile.indexOf(redirect)).toBeLessThan(caddyfile.indexOf("handle {"));
  });
});
