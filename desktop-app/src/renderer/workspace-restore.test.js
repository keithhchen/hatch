import { describe, expect, it, vi } from "vitest";

import {
  STALE_WORKSPACE_STATUS,
  isInvalidWorkspaceGrantError,
  validateRestoredWorkspace,
  workspacePickerSelection
} from "./workspace-restore.js";

describe("restored Desktop workspace grants", () => {
  it("does not grant a saved path until the native validator accepts it", async () => {
    let finishValidation;
    const validation = new Promise((resolve) => { finishValidation = resolve; });
    const pending = validateRestoredWorkspace({
      grant_id: "grant_saved",
      display_path: "/saved/workspace"
    }, () => validation);

    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishValidation({ grant_id: "grant_saved", display_path: "/private/saved/workspace" });
    await expect(pending).resolves.toEqual({
      state: "valid",
      grant: { grant_id: "grant_saved", display_path: "/private/saved/workspace" },
      workspace: "/private/saved/workspace",
      status: "Folder access restored"
    });
  });

  it("turns a deleted, moved, or inaccessible saved path into explicit onboarding state", async () => {
    const ensureWorkspace = vi.fn().mockRejectedValue(new Error("folder does not exist"));

    await expect(validateRestoredWorkspace({
      grant_id: "grant_deleted",
      display_path: "/deleted/workspace"
    }, ensureWorkspace)).resolves.toMatchObject({
      state: "stale",
      workspace: "",
      staleGrant: { grant_id: "grant_deleted", display_path: "/deleted/workspace" },
      status: STALE_WORKSPACE_STATUS
    });
  });

  it("keeps the current grant unchanged when the folder picker is cancelled", () => {
    const current = { workspace: "/current", draft: "/current", granted: true };

    expect(workspacePickerSelection(current, null)).toEqual({ ...current, changed: false });
    expect(workspacePickerSelection(current, {})).toEqual({ ...current, changed: false });
  });

  it("separates invalid/revoked grants from transient native-store failures", () => {
    expect(isInvalidWorkspaceGrantError("workspace_grant_revoked: denied")).toBe(true);
    expect(isInvalidWorkspaceGrantError(new Error("workspace_grant_stale: moved"))).toBe(true);
    expect(isInvalidWorkspaceGrantError("workspace_grant_store_unavailable: retry later")).toBe(false);
  });
});
