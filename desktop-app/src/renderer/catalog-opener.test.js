import { describe, expect, it, vi } from "vitest";
import { openCreatorAgentCatalog } from "./catalog-opener.js";

describe("Creator Agent catalog opener", () => {
  it("does not fall back to a WebView when the packaged native opener fails", async () => {
    const open = vi.fn();
    const error = await openCreatorAgentCatalog({
      catalogUrl: "https://hatch.tokenquadrant.cn/agents",
      invokeImpl: vi.fn(async () => { throw new Error("native open failed"); }),
      windowObject: { __TAURI_INTERNALS__: {}, open },
      packaged: true
    }).catch((caught) => caught);
    expect(error).toMatchObject({
      message: "Hatch couldn't open the Creator Agent catalog in your system browser. Try again.",
      i18nKey: "error.catalog.openSystemBrowserFailed"
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("labels a blocked web-preview popup without changing the existing message", async () => {
    const error = await openCreatorAgentCatalog({
      catalogUrl: "https://hatch.tokenquadrant.cn/agents",
      invokeImpl: vi.fn(async () => { throw new Error("no Tauri bridge"); }),
      windowObject: { open: vi.fn(() => null) },
      packaged: false
    }).catch((caught) => caught);

    expect(error).toMatchObject({
      message: "Allow pop-ups to open the Creator Agent catalog in your browser.",
      i18nKey: "error.catalog.popupsBlocked"
    });
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
