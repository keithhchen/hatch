import { describe, expect, it, vi } from "vitest";
import { openCreatorAgentCatalog } from "./catalog-opener.js";

describe("Creator Agent catalog opener", () => {
  it("does not fall back to a WebView when the packaged native opener fails", async () => {
    const open = vi.fn();
    await expect(openCreatorAgentCatalog({
      catalogUrl: "https://hatch.tokenquadrant.cn/agents",
      invokeImpl: vi.fn(async () => { throw new Error("native open failed"); }),
      windowObject: { __TAURI_INTERNALS__: {}, open },
      packaged: true
    })).rejects.toThrow(/system browser/);
    expect(open).not.toHaveBeenCalled();
  });

  it("uses a browser tab only in the web preview", async () => {
    const open = vi.fn(() => ({}));
    await expect(openCreatorAgentCatalog({
      catalogUrl: "https://hatch.tokenquadrant.cn/agents",
      invokeImpl: vi.fn(async () => { throw new Error("no Tauri bridge"); }),
      windowObject: { open },
      packaged: false
    })).resolves.toBe("web-preview");
    expect(open).toHaveBeenCalledWith(
      "https://hatch.tokenquadrant.cn/agents",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
