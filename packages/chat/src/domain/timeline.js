/**
 * Library-agnostic assistant turn timeline. One ordered list of entries:
 * text, thinking, status, tool (incl. approval state), skill and skill_run.
 * Live wire events and durable history both project into the same entries,
 * so a streamed card keeps its key when the canonical snapshot replaces it.
 */
export const ACTIVITY_KINDS = Object.freeze(["thinking", "tool", "skill", "skill_run"]);
const activityKinds = new Set(ACTIVITY_KINDS);

export function skillEntryId(event) {
  return event.status === "invoked"
    ? ["skill", event.run_id, "invoked", event.source_tool_call_id ?? "", event.path, event.reason].join(":")
    : ["skill", event.run_id, "activated", event.path, event.reason].join(":");
}

export function skillRunEntryId(event) {
  return ["skill-run", event.run_id, event.skill_run_id].join(":");
}

const toolEvent = (tool, runId) => ({
  type: "tool_call.delta",
  run_id: tool.run_id ?? runId,
  tool_call_id: tool.tool_call_id,
  name: tool.name,
  activity_message: tool.activity_message,
  arguments: tool.arguments,
  locality: tool.locality,
  approval: tool.approval,
  status: tool.status,
  result: tool.result,
  error: tool.error,
  detail_ref: tool.detail_ref
});

export class ChatTimeline {
  constructor() {
    this.entries = [];
    this.sequence = 0;
    this.activeThinking = new Map();
  }

  reset() {
    this.entries = [];
    this.sequence = 0;
    this.activeThinking.clear();
    return this.entries;
  }

  snapshot() {
    return this.entries;
  }

  appendText(content) {
    if (!content) return this.entries;
    const current = this.entries.at(-1);
    if (current?.kind === "text") {
      this.entries = [...this.entries.slice(0, -1), { ...current, content: current.content + content }];
    } else {
      this.entries = [...this.entries, { kind: "text", id: `text-${++this.sequence}`, content }];
    }
    return this.entries;
  }

  startThinking(contentIndex) {
    if (this.activeThinking.has(contentIndex)) {
      throw new Error("Thinking content index started more than once: " + contentIndex);
    }
    const entry = { kind: "thinking", id: "thinking-" + contentIndex + "-" + ++this.sequence, contentIndex, title: "thinking", content: "", streaming: true };
    this.entries = [...this.entries, entry];
    this.activeThinking.set(contentIndex, entry.id);
    return this.entries;
  }

  appendThinking(contentIndex, delta) {
    const id = this.activeThinking.get(contentIndex);
    if (!id) throw new Error("Thinking delta arrived before start: " + contentIndex);
    if (!delta) return this.entries;
    return this.patch(id, entry => ({ ...entry, content: entry.content + delta }));
  }

  finishThinking(contentIndex, content) {
    const id = this.activeThinking.get(contentIndex);
    if (!id) throw new Error("Thinking end arrived before start: " + contentIndex);
    this.activeThinking.delete(contentIndex);
    return this.patch(id, entry => ({ ...entry, content, streaming: false }));
  }

  restoreThinking(contentIndex, content) {
    this.entries = [...this.entries, { kind: "thinking", id: "thinking-" + contentIndex + "-" + ++this.sequence, contentIndex, title: "thinking", content, streaming: false }];
    return this.entries;
  }

  updateThinking(content) {
    if (!content) return this.entries;
    const current = this.entries.at(-1);
    if (current?.kind === "thinking" && current.contentIndex === undefined) {
      this.entries = [...this.entries.slice(0, -1), { ...current, title: "thinking", content }];
    } else {
      this.entries = [...this.entries, { kind: "thinking", id: `thinking-${++this.sequence}`, title: "thinking", content }];
    }
    return this.entries;
  }

  updateRuntimeStatus(content) {
    const normalizedContent = content?.trim();
    if (!normalizedContent || normalizedContent === "Thinking through the product.") return this.entries;
    if (ChatTimeline.isRedundantToolStatus(normalizedContent)) return this.entries;
    const current = this.entries.at(-1);
    if (current?.kind === "status") {
      this.entries = [...this.entries.slice(0, -1), { ...current, content: normalizedContent }];
    } else {
      this.entries = [...this.entries, { kind: "status", id: "status-" + ++this.sequence, content: normalizedContent }];
    }
    return this.entries;
  }

  static isRedundantToolStatus(content) {
    const normalizedContent = content?.trim();
    return typeof normalizedContent === "string"
      && (/^Calling tool .+\.$/i.test(normalizedContent) || /^Tool .+ (completed|failed)\.$/i.test(normalizedContent));
  }

  upsertTool(event) {
    const previous = this.entries.find(entry => entry.kind === "tool" && entry.content.toolCallId === event.tool_call_id);
    return this.upsert(`tool-${event.tool_call_id}`, {
      kind: "tool",
      id: previous?.id ?? `tool-${event.tool_call_id}`,
      title: (event.name ?? previous?.content?.name ?? "tool").replaceAll("_", " "),
      content: {
        runId: event.run_id ?? previous?.content?.runId,
        toolCallId: event.tool_call_id,
        name: event.name ?? previous?.content?.name ?? "tool",
        activityMessage: event.activity_message ?? previous?.content?.activityMessage,
        arguments: event.arguments ?? previous?.content?.arguments ?? {},
        locality: event.locality ?? previous?.content?.locality,
        approval: event.approval ?? previous?.content?.approval,
        result: event.result ?? previous?.content?.result,
        error: event.error ?? previous?.content?.error,
        detailRef: event.detail_ref ?? previous?.content?.detailRef
      },
      status: event.status ?? previous?.status ?? "requested"
    });
  }

  /** skill.activated / skill.invoked, or a durable skill_event history part. */
  upsertSkill(event) {
    const id = skillEntryId(event);
    return this.upsert(id, {
      kind: "skill", id, title: event.name, status: event.status,
      content: { runId: event.run_id, name: event.name, path: event.path, reason: event.reason, sourceToolCallId: event.source_tool_call_id, invocationType: event.invocation_type }
    });
  }

  /** skill.run, or a durable skill_run history part. */
  upsertSkillRun(event) {
    const id = skillRunEntryId(event);
    return this.upsert(id, {
      kind: "skill_run", id, title: event.name, status: event.status,
      content: { runId: event.run_id, skillRunId: event.skill_run_id, skillId: event.skill_id, name: event.name, error: event.error }
    });
  }

  upsert(id, next) {
    const index = this.entries.findIndex(entry => entry.id === id || entry.id === next.id);
    this.entries = index < 0 ? [...this.entries, next] : this.entries.map((entry, entryIndex) => entryIndex === index ? next : entry);
    return this.entries;
  }

  patch(id, update) {
    this.entries = this.entries.map(entry => entry.id === id ? update(entry) : entry);
    return this.entries;
  }

  static streamingAssistantMessage(runId, timestamp = new Date().toISOString()) {
    return { id: `stream-${runId}`, renderKey: `${runId}-assistant`, run_id: runId, role: "assistant", content: "", timestamp, transient: true, timeline: [] };
  }

  /** Project a durable assistant message (protocol 0.8 `parts`) into timeline entries. */
  static fromHistory(message) {
    const timeline = new ChatTimeline();
    const tools = new Map((message.tool_calls ?? []).map(tool => [tool.tool_call_id, tool]));
    const skillRuns = new Map((message.skill_runs ?? []).map(run => [run.skill_run_id, run]));
    if (!Array.isArray(message.parts) || !message.parts.length) {
      timeline.appendText(message.content ?? "");
      for (const tool of message.tool_calls ?? []) timeline.upsertTool(toolEvent(tool, message.run_id));
      return timeline.snapshot();
    }
    for (const part of message.parts) {
      if (part.type === "text") {
        const start = Math.max(0, Number(part.start) || 0);
        const end = Math.max(start, Number(part.end) || 0);
        timeline.appendText(String(message.content ?? "").slice(start, end));
      } else if (part.type === "thinking") {
        timeline.restoreThinking(Number(part.contentIndex), String(part.content ?? ""));
      } else if (part.type === "tool_call") {
        const tool = tools.get(part.tool_call_id);
        if (tool) timeline.upsertTool(toolEvent(tool, message.run_id));
      } else if (part.type === "skill_run") {
        const run = skillRuns.get(part.skill_run_id);
        if (run) timeline.upsertSkillRun({ run_id: message.run_id, ...run });
      } else if (part.type === "skill_event") {
        const event = (message.skill_events ?? []).find(candidate => candidate.name === part.name
          && candidate.status === part.status && candidate.reason === part.reason
          && (candidate.source_tool_call_id ?? "") === (part.source_tool_call_id ?? ""));
        if (event) timeline.upsertSkill({ run_id: message.run_id, ...event });
      }
    }
    return timeline.snapshot();
  }
}

/** Consecutive activity entries collapse into one activity group. */
export function groupTimelineEntries(entries) {
  const grouped = [];
  for (let index = 0; index < entries.length;) {
    if (!activityKinds.has(entries[index].kind)) {
      grouped.push(entries[index++]);
      continue;
    }
    const activities = [];
    while (index < entries.length && activityKinds.has(entries[index].kind)) activities.push(entries[index++]);
    grouped.push({ kind: "activity_group", id: "activity-group-" + activities[0].id, entries: activities });
  }
  return grouped;
}

/** A message the user submitted that the Runtime has not yet confirmed. */
export class PendingSubmission {
  constructor({ conversationId, runId, clientMessageId, content, attachments, files }) {
    this.conversationId = conversationId;
    this.runId = runId;
    this.clientMessageId = clientMessageId;
    this.content = content;
    this.attachments = attachments;
    this.files = files;
    this.optimisticMessageId = `optimistic-${clientMessageId}`;
    this.renderKey = `${runId}-user`;
  }

  optimisticMessage() {
    return {
      id: this.optimisticMessageId,
      renderKey: this.renderKey,
      run_id: this.runId,
      role: "user",
      content: this.content,
      timestamp: new Date().toISOString(),
      attachments: this.attachments.map(({ text: _text, data_base64: _data, ...attachment }) => attachment),
      optimistic: true,
      provisional: true
    };
  }
}
