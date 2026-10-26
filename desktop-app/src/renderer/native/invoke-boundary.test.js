import { describe, expect, it, vi } from "vitest";
import { invokeDesktopCommand } from "./native-invoke-boundary.js";

describe("native invoke boundary", () => {
  it("returns real native results unchanged", async () => {
    const invokeImpl = vi.fn().mockResolvedValue({ grant_id: "grant-real" });
    await expect(invokeDesktopCommand("ensure_workspace", {}, { invokeImpl, packaged: true }))
      .resolves.toEqual({ grant_id: "grant-real" });
  });

  it.each(["ensure_workspace", "set_window_tool_context", "execute_tool_call", "approve_pending_tool_call"])(
    "fails closed for %s outside packaged Hatch",
    async (command) => {
      const invokeImpl = vi.fn();
      await expect(invokeDesktopCommand(command, {}, { invokeImpl, packaged: false }))
        .rejects.toMatchObject({ code: "desktop_only" });
      expect(invokeImpl).not.toHaveBeenCalled();
    }
  );

  it("represents a missing browser default workspace as empty without creating authority", async () => {
    const invokeImpl = vi.fn();
    await expect(invokeDesktopCommand("default_workspace", {}, { invokeImpl, packaged: false }))
      .resolves.toBe("");
    expect(invokeImpl).not.toHaveBeenCalled();
  });

  it("preserves packaged native failures instead of rewriting them", async () => {
    const nativeError = Object.assign(new Error("grant revoked"), { code: "workspace_grant_invalid" });
    const invokeImpl = vi.fn().mockRejectedValue(nativeError);
    await expect(invokeDesktopCommand("ensure_workspace", {}, { invokeImpl, packaged: true }))
      .rejects.toBe(nativeError);
  });
});
