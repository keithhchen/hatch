import { describe, expect, it } from "vitest";

import {
  LOCAL_TOOL_TRANSPORT_GRACE_MS,
  LOCAL_TOOL_STOP_UNCONFIRMED,
  LOCAL_TOOL_STOP_UNCONFIRMED_KEY,
  committedResultAfterCancellation,
  localToolCancellationError,
  localToolTransportDeadlineMs,
  protocolToolError,
  statusAfterLocalToolStop
} from "./local-tool-lifecycle.js";

describe("Desktop local tool lifecycle", () => {
  it("strips renderer localization metadata from strict protocol errors", () => {
    expect(protocolToolError({
      code: "approval_denied",
      message: "Tool call rejected",
      i18nKey: "approval.toolRejectedByUser",
      i18nValues: { name: "file_write" }
    })).toEqual({
      code: "approval_denied",
      message: "Tool call rejected"
    });
  });

  it("uses the native shell request timeout plus transport grace", () => {
    expect(localToolTransportDeadlineMs({ name: "shell_exec", arguments: { timeout_ms: 120_000 } }))
      .toBe(120_000 + LOCAL_TOOL_TRANSPORT_GRACE_MS);
  });

  it("uses the native 30s default rather than a fixed renderer 45s race", () => {
    expect(localToolTransportDeadlineMs({ name: "shell_exec", arguments: {} })).toBe(35_000);
    expect(localToolTransportDeadlineMs({ name: "file_list", arguments: {} })).toBe(35_000);
  });

  it("distinguishes user cancellation from deadline expiry", () => {
    expect(localToolCancellationError({ name: "shell_exec" }, "user_requested", 35_000))
      .toMatchObject({
        code: "local_tool_cancelled",
        i18nKey: "error.localTool.cancelled",
        i18nValues: { name: "shell_exec" }
      });
    expect(localToolCancellationError({ name: "shell_exec" }, "timeout", 35_000))
      .toMatchObject({
        code: "local_tool_timeout",
        i18nKey: "error.localTool.timeout",
        i18nValues: { seconds: 35, name: "shell_exec" }
      });
  });

  it("never hides an unconfirmed native stop behind a completed label", () => {
    expect(statusAfterLocalToolStop("Completed", true)).toBe("Completed");
    expect(statusAfterLocalToolStop("Completed", false)).toBe(LOCAL_TOOL_STOP_UNCONFIRMED);
    expect(LOCAL_TOOL_STOP_UNCONFIRMED_KEY).toBe("error.localTool.stopUnconfirmed");
  });

  it("preserves a native result that committed before cancellation was observed", () => {
    const committed = { status: "ok", result: { path: "changed.txt" } };
    expect(committedResultAfterCancellation(committed)).toBe(committed);
    expect(committedResultAfterCancellation({
      status: "error",
      error: { code: "cancelled" }
    })).toBeNull();
  });
});
