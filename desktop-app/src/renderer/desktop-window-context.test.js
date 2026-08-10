import { describe, expect, it } from "vitest";
import {
  accountScopedWindowContext,
  usesLegacyProfileRunFallback
} from "./desktop-window-context.js";

describe("desktop window context account boundary", () => {
  it("restores only a context explicitly owned by the signed-in account", () => {
    const context = { accountId: "account-a", conversationId: "conv_a", composerDraft: "private" };
    expect(accountScopedWindowContext(context, "account-a")).toBe(context);
    expect(accountScopedWindowContext(context, "account-b")).toEqual({});
  });

  it("rejects legacy and malformed unbound contexts instead of guessing ownership", () => {
    expect(accountScopedWindowContext({ conversationId: "legacy" }, "account-a")).toEqual({});
    expect(accountScopedWindowContext(null, "account-a")).toEqual({});
    expect(accountScopedWindowContext([], "account-a")).toEqual({});
    expect(accountScopedWindowContext({ accountId: "account-a" }, "")).toEqual({});
  });

  it("keeps the profile active-run slot only for the original main window", () => {
    expect(usesLegacyProfileRunFallback("")).toBe(true);
    expect(usesLegacyProfileRunFallback("   ")).toBe(true);
    expect(usesLegacyProfileRunFallback("conv_server_123")).toBe(false);
  });
});
