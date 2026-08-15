import { describe, expect, it } from "vitest";
import {
  SKILL_ACTIVITY_PART,
  SKILL_RUN_ACTIVITY_PART,
  TURN_ACTIVITY_PART,
  activityGroupPath,
  activitySummary,
  appendTimelineText,
  historyTimelineEntries,
  prependTurnActivity,
  reconcileTimelineText,
  shouldHideWorkedSummary,
  terminalTimelineParts,
  toolActionLabel,
  toolDisplay,
  toolResultSummary,
  toolState,
  upsertTimelinePart
} from "./activity-ui.js";

function toolPart(overrides = {}) {
  return {
    type: "tool-call",
    toolCallId: overrides.toolCallId ?? "tool-1",
    toolName: overrides.toolName ?? "file_read",
    args: overrides.args ?? { path: "auth.ts" },
    artifact: overrides.artifact ?? { status: "completed" },
    result: Object.hasOwn(overrides, "result") ? overrides.result : { status: "ok" },
    isError: overrides.isError ?? false
  };
}

describe("activity accordion projection", () => {
  it("adds one synthetic thinking marker to every durable assistant turn", () => {
    const marked = prependTurnActivity([{ type: "text", text: "answer" }], "run-1");

    expect(marked).toEqual([
      {
        type: "data",
        name: TURN_ACTIVITY_PART,
        data: { id: "run-1:activity", run_id: "run-1" }
      },
      { type: "text", text: "answer" }
    ]);
    expect(prependTurnActivity(marked, "run-1")).toEqual(marked);
    expect(prependTurnActivity([{ type: "text", text: "error" }], "")).toEqual([
      { type: "text", text: "error" }
    ]);
  });

  it("groups adjacent thinking, tool, and skill parts without crossing assistant text", () => {
    expect(activityGroupPath({
      type: "data",
      name: TURN_ACTIVITY_PART,
      data: {}
    })).toEqual(["group-activity"]);
    expect(activityGroupPath(toolPart())).toEqual(["group-activity", "group-tools"]);
    expect(activityGroupPath({
      type: "data",
      name: SKILL_ACTIVITY_PART,
      data: {}
    })).toEqual(["group-activity"]);
    expect(activityGroupPath({
      type: "data",
      name: SKILL_RUN_ACTIVITY_PART,
      data: {}
    })).toEqual(["group-activity"]);
    expect(activityGroupPath({ type: "text", text: "answer" })).toEqual([]);
  });

  it("uses the current active action as the running title", () => {
    expect(activitySummary({ isRunning: true, activeLabel: "Reading auth.ts", elapsedMs: 12_000 }))
      .toBe("Reading auth.ts");
    expect(activitySummary({ isRunning: true, activeLabel: "", elapsedMs: 12_000 }))
      .toBe("Thinking");
  });

  it("replaces the active action with a stable terminal summary", () => {
    expect(activitySummary({ isRunning: false, elapsedMs: 40_000 })).toBe("Worked for 40s");
    expect(activitySummary({ isRunning: false, failed: true, elapsedMs: 40_000 }))
      .toBe("Couldn't finish · 40s");
    expect(activitySummary({ isRunning: false, filtered: true, elapsedMs: 40_000 }))
      .toBe("Blocked · 40s");
    expect(activitySummary({ isRunning: false })).toBe("Worked");
  });

  it("hides a completed Worked summary when no tool item was recorded", () => {
    expect(shouldHideWorkedSummary({ isRunning: false, toolItemCount: 0 })).toBe(true);
    expect(shouldHideWorkedSummary({ isRunning: false, toolItemCount: 1 })).toBe(false);
    expect(shouldHideWorkedSummary({ isRunning: true, toolItemCount: 0 })).toBe(false);
    expect(shouldHideWorkedSummary({ isRunning: false, failed: true, toolItemCount: 0 })).toBe(false);
  });

  it("uses natural verb tense instead of debug-style completion suffixes", () => {
    const display = toolDisplay("file_read");
    expect(toolActionLabel(display, "running", "auth.ts")).toBe("Reading auth.ts");
    expect(toolActionLabel(display, "completed", "auth.ts")).toBe("Read auth.ts");
    expect(toolActionLabel(display, "failed", "auth.ts")).toBe("Couldn't read auth.ts");
    expect(toolActionLabel(display, "approval", "auth.ts")).toBe("Ready to read auth.ts");
  });

  it("keeps approval and result state derived from existing tool parts", () => {
    const part = toolPart({ artifact: { status: "requested" }, result: undefined });
    expect(toolState(part, { status: "pending" })).toBe("approval");
    expect(toolState(part, { status: "approved" })).toBe("running");
  });

  it("does not place raw tool output in the compact timeline", () => {
    expect(toolResultSummary(toolPart({ result: { output: "verbose command output" } }))).toBe("");
    expect(toolResultSummary(toolPart({ result: { matches: [1, 2, 3] } }))).toBe("3 matches");
    expect(toolResultSummary(toolPart({
      isError: true,
      result: JSON.stringify({ status: "error", error: { message: "internal runtime detail" } })
    }))).toBe("");
  });

  it("keeps assistant text and tools in live arrival order", () => {
    const firstText = appendTimelineText([], "先读取。");
    const withTool = upsertTimelinePart(
      firstText,
      toolPart({ toolCallId: "read", result: undefined }),
      (part) => part.type === "tool-call" && part.toolCallId === "read"
    );
    const interleaved = appendTimelineText(withTool, "再回答。");

    expect(interleaved.map((part) => part.type === "text" ? part.text : part.toolCallId)).toEqual([
      "先读取。",
      "read",
      "再回答。"
    ]);
  });

  it("updates an existing activity in place without moving it across text", () => {
    const requested = toolPart({ toolCallId: "read", result: undefined });
    const completed = toolPart({ toolCallId: "read", result: { status: "ok" } });
    const parts = appendTimelineText([
      { type: "text", text: "之前" },
      requested
    ], "之后");

    const updated = upsertTimelinePart(
      parts,
      completed,
      (part) => part.type === "tool-call" && part.toolCallId === "read"
    );

    expect(updated).toEqual([
      { type: "text", text: "之前" },
      completed,
      { type: "text", text: "之后" }
    ]);
  });

  it("terminal reconciliation preserves tool boundaries", () => {
    const parts = [
      { type: "text", text: "先读取。" },
      toolPart({ toolCallId: "read" }),
      { type: "text", text: "再回答。" }
    ];

    expect(reconcileTimelineText(parts, "先读取。再回答。")).toEqual(parts);
    expect(reconcileTimelineText(parts, "先读取。再回答。补充。")).toEqual([
      ...parts.slice(0, -1),
      { type: "text", text: "再回答。补充。" }
    ]);
  });

  it("replaces every provisional part with the client-owned blocked state", () => {
    expect(terminalTimelineParts([
      { type: "data", name: TURN_ACTIVITY_PART, data: { id: "run-1:activity", run_id: "run-1" } },
      { type: "text", text: "safe preview" },
      toolPart({ toolCallId: "read" })
    ], "This response was blocked by the output safety check.", "content_filter", "run-1"))
      .toEqual([
        { type: "data", name: TURN_ACTIVITY_PART, data: { id: "run-1:activity", run_id: "run-1" } },
        { type: "text", text: "This response was blocked by the output safety check." }
      ]);
  });

  it("hydrates persisted text and activity in committed order", () => {
    const tool = { tool_call_id: "read", name: "file_read" };
    const skillRun = { skill_run_id: "skill-1", name: "research" };
    expect(historyTimelineEntries({
      content: "先读取。再回答。",
      parts: [
        { type: "text", start: 0, end: 4 },
        { type: "tool_call", tool_call_id: "read" },
        { type: "text", start: 4, end: 8 },
        { type: "skill_run", skill_run_id: "skill-1" }
      ],
      tool_calls: [tool],
      skill_runs: [skillRun]
    })).toEqual([
      { type: "text", text: "先读取。" },
      { type: "tool_call", value: tool },
      { type: "text", text: "再回答。" },
      { type: "skill_run", value: skillRun }
    ]);
  });

  it("does not guess activity order for history without committed parts", () => {
    expect(historyTimelineEntries({
      content: "legacy answer",
      tool_calls: [{ tool_call_id: "legacy-tool", name: "fs.read" }]
    })).toBeNull();
  });
});
