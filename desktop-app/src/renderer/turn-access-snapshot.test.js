import { describe, expect, it } from "vitest";

import { accessSnapshotForToolCall, createTurnAccessSnapshot } from "./turn-access-snapshot.js";
import { PERMISSION_POLICIES } from "./product-policy.js";

describe("active-turn access snapshot", () => {
  it("keeps the active turn on its send-time workspace and permission", () => {
    const activeRun = {
      accessSnapshot: createTurnAccessSnapshot(
        "grant_old",
        "/workspace/old",
        PERMISSION_POLICIES.ASK_BEFORE_CHANGES
      )
    };
    const changedPreferences = {
      workspaceGrantId: "grant_new",
      displayPath: "/workspace/new",
      permissionMode: PERMISSION_POLICIES.ALLOW_CHANGES
    };

    expect(accessSnapshotForToolCall(activeRun, changedPreferences)).toEqual({
      workspaceGrantId: "grant_old",
      displayPath: "/workspace/old",
      permissionMode: PERMISSION_POLICIES.ASK_BEFORE_CHANGES
    });
  });

  it("takes changed settings only when the next turn is sent", () => {
    const nextRun = {
      accessSnapshot: createTurnAccessSnapshot(
        "grant_new",
        "/workspace/new",
        PERMISSION_POLICIES.ALLOW_CHANGES
      )
    };

    expect(accessSnapshotForToolCall(nextRun, {})).toEqual({
      workspaceGrantId: "grant_new",
      displayPath: "/workspace/new",
      permissionMode: PERMISSION_POLICIES.ALLOW_CHANGES
    });
  });

  it("supports saved pre-snapshot active runs with a conservative fallback", () => {
    expect(accessSnapshotForToolCall({ runId: "legacy" }, {
      workspaceGrantId: "grant_current",
      displayPath: "/workspace/current",
      permissionMode: PERMISSION_POLICIES.ASK_BEFORE_CHANGES
    })).toEqual({
      workspaceGrantId: "grant_current",
      displayPath: "/workspace/current",
      permissionMode: PERMISSION_POLICIES.ASK_BEFORE_CHANGES
    });
  });

  it("normalizes a removed saved policy to conservative Ask behavior", () => {
    expect(accessSnapshotForToolCall({
      accessSnapshot: {
        workspaceGrantId: "grant_legacy",
        displayPath: "/workspace/legacy",
        permissionMode: "read-only"
      }
    }, {})).toEqual({
      workspaceGrantId: "grant_legacy",
      displayPath: "/workspace/legacy",
      permissionMode: PERMISSION_POLICIES.ASK_BEFORE_CHANGES
    });
  });
});
