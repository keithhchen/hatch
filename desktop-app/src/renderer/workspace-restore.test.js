import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "./i18n.js";

import {
  MISSING_WORKSPACE_STATUS_KEY,
  RESTORED_WORKSPACE_STATUS_KEY,
  STALE_WORKSPACE_STATUS,
  STALE_WORKSPACE_STATUS_KEY,
  isInvalidWorkspaceGrantError,
  isWorkspaceGrantError,
  localizedWorkspaceCommandError,
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
      status: "Folder access restored",
      statusKey: RESTORED_WORKSPACE_STATUS_KEY
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
      status: STALE_WORKSPACE_STATUS,
      statusKey: STALE_WORKSPACE_STATUS_KEY,
      error: {
        message: "folder does not exist",
        i18nKey: "error.workspace.restoreFailed"
      }
    });
  });

  it("returns localization keys for missing grants and invalid native validation", async () => {
    await expect(validateRestoredWorkspace(null, vi.fn())).resolves.toEqual({
      state: "missing",
      workspace: "",
      status: "Choose a workspace folder to continue.",
      statusKey: MISSING_WORKSPACE_STATUS_KEY
    });

    const invalid = await validateRestoredWorkspace({
      grant_id: "grant_saved",
      display_path: "/saved/workspace"
    }, async () => ({ grant_id: "different_grant", display_path: "/saved/workspace" }));
    expect(invalid).toMatchObject({
      state: "stale",
      statusKey: STALE_WORKSPACE_STATUS_KEY,
      error: {
        message: "The native workspace validator returned an invalid grant.",
        i18nKey: "error.workspace.invalidGrantValidation"
      }
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
    expect(isWorkspaceGrantError("workspace_grant_store_unavailable: retry later")).toBe(true);
  });

  it("maps native picker and validator errors to localized semantic messages", () => {
    const invalid = localizedWorkspaceCommandError(
      "workspace_grant_invalid: Choose a folder below the filesystem root"
    );
    const denied = localizedWorkspaceCommandError(
      new Error("workspace_grant_denied: macOS did not grant read access")
    );
    const unavailable = localizedWorkspaceCommandError("native picker failed");

    expect(invalid).toMatchObject({
      code: "workspace_grant_invalid",
      i18nKey: "error.workspace.invalidSelection"
    });
    expect(denied).toMatchObject({
      code: "workspace_grant_denied",
      i18nKey: "error.workspace.accessDenied"
    });
    expect(unavailable).toMatchObject({
      code: "workspace_grant_unavailable",
      i18nKey: "error.workspace.unavailable"
    });
    expect(createTranslator("zh-CN")(invalid.i18nKey)).toBe("请选择文件系统根目录下的现有文件夹。");
    expect(createTranslator("ja")(denied.i18nKey))
      .toBe("Hatch にはこのフォルダを読み取る権限がありません。もう一度選択するか、別のフォルダを選択してください。");
  });
});
