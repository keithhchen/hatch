const TOOL_DISPLAYS = [
  {
    matches: (name) => name.includes("web.search"),
    value: display("◎", "Searching the web", "Searched the web", "Couldn't search the web", "Ready to search the web")
  },
  {
    matches: (name) => name.includes("file.search") || name.includes("fs.search"),
    value: display("⌕", "Searching files", "Searched files", "Couldn't search files", "Ready to search files")
  },
  {
    matches: (name) => name.includes("file.read") || name.includes("fs.read"),
    value: display("▣", "Reading", "Read", "Couldn't read", "Ready to read")
  },
  {
    matches: (name) => name.includes("file.list") || name.includes("fs.list"),
    value: display("☷", "Listing files", "Listed files", "Couldn't list files", "Ready to list files")
  },
  {
    matches: (name) => name.includes("file.write") || name.includes("fs.write"),
    value: display("✎", "Writing", "Wrote", "Couldn't write", "Ready to write")
  },
  {
    matches: (name) => name.includes("file.patch") || name.includes("fs.patch"),
    value: display("✎", "Editing", "Edited", "Couldn't edit", "Ready to edit")
  },
  {
    matches: (name) => name.includes("shell.exec"),
    value: display(">_", "Running", "Ran", "Couldn't run", "Ready to run")
  },
  {
    matches: (name) => name.includes("git.diff"),
    value: display("Δ", "Reviewing changes", "Reviewed changes", "Couldn't review changes", "Ready to review changes")
  },
  {
    matches: (name) => name.includes("api.request"),
    value: display("↗", "Contacting service", "Contacted service", "Couldn't contact service", "Ready to contact service")
  },
  {
    matches: (name) => name.includes("mcp.call"),
    value: display("◇", "Using connected service", "Used connected service", "Couldn't use connected service", "Ready to use connected service")
  }
];

const FALLBACK_DISPLAY = display("·", "Running a step", "Completed a step", "Couldn't complete a step", "Ready to run a step");

export const TURN_ACTIVITY_PART = "hatch.turn_activity";
export const SKILL_ACTIVITY_PART = "hatch.skill_activity";
export const SKILL_RUN_ACTIVITY_PART = "hatch.skill_run_activity";

const ACTIVITY_DATA_PARTS = new Set([
  TURN_ACTIVITY_PART,
  SKILL_ACTIVITY_PART,
  SKILL_RUN_ACTIVITY_PART
]);

function display(icon, running, completed, failed, approval) {
  return { icon, running, completed, failed, approval };
}

export function toolDisplay(name) {
  const normalized = String(name ?? "").replaceAll("_", ".");
  return TOOL_DISPLAYS.find((entry) => entry.matches(normalized))?.value ?? FALLBACK_DISPLAY;
}

export function toolActionLabel(tool, state, target) {
  const suffix = target ? ` ${target}` : "";
  return `${tool[state] ?? tool.running}${suffix}`;
}

export function toolTarget(args) {
  const value = args?.path ?? args?.query ?? args?.command ?? args?.endpoint ?? args?.tool;
  if (typeof value !== "string" || value.length === 0) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 58 ? `${compact.slice(0, 55)}...` : compact;
}

export function toolState(part, approvalRequest) {
  if (approvalRequest?.status === "pending") return "approval";
  if (approvalRequest?.status === "approved" && part.result === undefined && !part.isError) return "running";
  if (approvalRequest?.status === "denied") return "failed";
  if (part.isError || part.status?.type === "incomplete") return "failed";
  if (part.result !== undefined || part.status?.type === "complete") return "completed";
  if (part.status?.type === "requires-action" || part.approval?.approved === undefined && part.approval) return "approval";
  return "running";
}

export function toolResultSummary(part) {
  if (part.isError) return "";
  const result = part.result;
  if (!result) return "";
  if (Array.isArray(result.entries)) return `${result.entries.length} items`;
  if (Array.isArray(result.matches)) return `${result.matches.length} matches`;
  return "";
}

export function activitySummary({ isRunning, failed = false, filtered = false, elapsedMs, activeLabel = "" }) {
  const duration = elapsedMs === undefined ? "" : ` · ${formatDuration(elapsedMs)}`;
  if (filtered) return `Blocked${duration}`;
  if (failed) return `Couldn't finish${duration}`;
  if (isRunning) return activeLabel || "Thinking";
  return elapsedMs === undefined ? "Worked" : `Worked for ${formatDuration(elapsedMs)}`;
}

export function prependTurnActivity(parts, runId) {
  if (!runId || parts.some((part) => part?.type === "data" && part.name === TURN_ACTIVITY_PART)) {
    return parts;
  }
  return [
    {
      type: "data",
      name: TURN_ACTIVITY_PART,
      data: { id: `${runId}:activity`, run_id: runId }
    },
    ...parts
  ];
}

export function activityGroupPath(part) {
  if (part?.type === "tool-call") return ["group-activity", "group-tools"];
  if (part?.type === "data" && ACTIVITY_DATA_PARTS.has(part.name)) return ["group-activity"];
  return [];
}

export function formatDuration(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

export function appendTimelineText(parts, delta) {
  if (!delta) return parts;
  const last = parts.at(-1);
  if (last?.type !== "text") {
    return [...parts, { type: "text", text: delta }];
  }
  return [
    ...parts.slice(0, -1),
    { ...last, text: `${last.text ?? ""}${delta}` }
  ];
}

export function upsertTimelinePart(parts, nextPart, matches) {
  const existingIndex = parts.findIndex(matches);
  if (existingIndex < 0) return [...parts, nextPart];
  return parts.map((part, index) => index === existingIndex ? nextPart : part);
}

export function reconcileTimelineText(parts, terminalText) {
  if (!terminalText) return parts;
  const visibleText = parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  if (visibleText === terminalText) return parts;
  if (!terminalText.startsWith(visibleText)) return parts;
  return appendTimelineText(parts, terminalText.slice(visibleText.length));
}

export function historyTimelineEntries(message) {
  if (!Array.isArray(message.parts)) return null;
  const tools = new Map((message.tool_calls ?? []).map((tool) => [tool.tool_call_id, tool]));
  const skillRuns = new Map((message.skill_runs ?? []).map((run) => [run.skill_run_id, run]));
  return message.parts.flatMap((part) => {
    if (part.type === "text") {
      const start = Math.max(0, Number(part.start) || 0);
      const end = Math.max(start, Number(part.end) || 0);
      const text = String(message.content ?? "").slice(start, end);
      return text ? [{ type: "text", text }] : [];
    }
    if (part.type === "tool_call") {
      const tool = tools.get(part.tool_call_id);
      return tool ? [{ type: "tool_call", value: tool }] : [];
    }
    if (part.type === "skill_run") {
      const run = skillRuns.get(part.skill_run_id);
      return run ? [{ type: "skill_run", value: run }] : [];
    }
    if (part.type === "skill_event") {
      const event = (message.skill_events ?? []).find((candidate) => (
        candidate.name === part.name
        && candidate.status === part.status
        && candidate.reason === part.reason
        && (candidate.source_tool_call_id ?? "") === (part.source_tool_call_id ?? "")
      ));
      return event ? [{ type: "skill_event", value: event }] : [];
    }
    return [];
  });
}
