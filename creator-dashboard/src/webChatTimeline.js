export class WebChatTimeline {
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
    const entry = {
      kind: "thinking",
      id: "thinking-" + contentIndex + "-" + ++this.sequence,
      contentIndex,
      content: "",
      streaming: true
    };
    this.entries = [...this.entries, entry];
    this.activeThinking.set(contentIndex, entry.id);
    return this.entries;
  }

  appendThinking(contentIndex, delta) {
    const id = this.activeThinking.get(contentIndex);
    if (!id) throw new Error("Thinking delta arrived before start: " + contentIndex);
    if (!delta) return this.entries;
    this.entries = this.entries.map(entry => entry.id === id ? { ...entry, content: entry.content + delta } : entry);
    return this.entries;
  }

  finishThinking(contentIndex, content) {
    const id = this.activeThinking.get(contentIndex);
    if (!id) throw new Error("Thinking end arrived before start: " + contentIndex);
    this.entries = this.entries.map(entry => entry.id === id ? { ...entry, content, streaming: false } : entry);
    this.activeThinking.delete(contentIndex);
    return this.entries;
  }

  restoreThinking(contentIndex, content) {
    this.entries = [...this.entries, {
      kind: "thinking",
      id: "thinking-" + contentIndex + "-" + ++this.sequence,
      contentIndex,
      content,
      streaming: false
    }];
    return this.entries;
  }

  updateThinking(content) {
    if (!content) return this.entries;
    const current = this.entries.at(-1);
    if (current?.kind === "thinking" && current.contentIndex === undefined) {
      this.entries = [...this.entries.slice(0, -1), { ...current, content }];
    } else {
      this.entries = [...this.entries, { kind: "thinking", id: `thinking-${++this.sequence}`, content }];
    }
    return this.entries;
  }

  updateRuntimeStatus(content) {
    if (content === "Thinking through the product.") return this.entries;
    if (this.isRedundantToolStatus(content)) return this.entries;
    if (!content) return this.entries;
    const current = this.entries.at(-1);
    if (current?.kind === "status") {
      this.entries = [...this.entries.slice(0, -1), { ...current, content }];
    } else {
      this.entries = [...this.entries, { kind: "status", id: "status-" + ++this.sequence, content }];
    }
    return this.entries;
  }

  isRedundantToolStatus(content) {
    const toolStatus = /^Calling tool .+\.$/.test(content)
      ? "requested"
      : /^Tool .+ (completed|failed)\.$/.exec(content)?.[1];
    const current = this.entries.at(-1);
    return Boolean(toolStatus && current?.kind === "tool" && current.status === toolStatus);
  }

  upsertTool(event) {
    const index = this.entries.findIndex(entry => entry.kind === "tool" && entry.toolCallId === event.tool_call_id);
    const previous = index < 0 ? null : this.entries[index];
    const next = {
      kind: "tool",
      id: previous?.id ?? `tool-${event.tool_call_id}`,
      runId: event.run_id ?? previous?.runId,
      toolCallId: event.tool_call_id,
      toolName: event.name ?? previous?.toolName ?? "tool",
      arguments: event.arguments ?? previous?.arguments ?? {},
      locality: event.locality ?? previous?.locality,
      approval: event.approval ?? previous?.approval,
      status: event.status ?? previous?.status ?? "requested",
      result: event.result ?? previous?.result,
      error: event.error ?? previous?.error,
      detailRef: event.detail_ref ?? previous?.detailRef
    };
    if (index < 0) this.entries = [...this.entries, next];
    else this.entries = this.entries.map((entry, entryIndex) => entryIndex === index ? next : entry);
    return this.entries;
  }

  snapshot() {
    return this.entries;
  }

  static streamingAssistantMessage(runId, timestamp = new Date().toISOString()) {
    return {
      id: `stream-${runId}`,
      renderKey: `${runId}-assistant`,
      run_id: runId,
      role: "assistant",
      content: "",
      timestamp,
      transient: true,
      timeline: []
    };
  }

  static fromHistory(message) {
    const timeline = new WebChatTimeline();
    const tools = new Map((message.tool_calls ?? []).map(tool => [tool.tool_call_id, tool]));
    if (Array.isArray(message.parts) && message.parts.length) {
      for (const part of message.parts) {
        if (part.type === "text") {
          const start = Math.max(0, Number(part.start) || 0);
          const end = Math.max(start, Number(part.end) || 0);
          timeline.appendText(String(message.content ?? "").slice(start, end));
        }
        if (part.type === "thinking") {
          timeline.restoreThinking(Number(part.contentIndex), String(part.content ?? ""));
        }
        if (part.type === "tool_call") {
          const tool = tools.get(part.tool_call_id);
          if (tool) timeline.upsertTool({
            type: "tool_call.delta",
            run_id: tool.run_id ?? message.run_id,
            tool_call_id: tool.tool_call_id,
            name: tool.name,
            arguments: tool.arguments,
            locality: tool.locality,
            approval: tool.approval,
            status: tool.status,
            result: tool.result,
            error: tool.error,
            detail_ref: tool.detail_ref
          });
        }
      }
      return timeline.snapshot();
    }
    timeline.appendText(message.content ?? "");
    for (const tool of message.tool_calls ?? []) {
      timeline.upsertTool({
        type: "tool_call.delta",
        run_id: tool.run_id ?? message.run_id,
        tool_call_id: tool.tool_call_id,
        name: tool.name,
        arguments: tool.arguments,
        locality: tool.locality,
        approval: tool.approval,
        status: tool.status,
        result: tool.result,
        error: tool.error,
        detail_ref: tool.detail_ref
      });
    }
    return timeline.snapshot();
  }
}

export function groupTimelineEntries(entries) {
  const grouped = [];
  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (entry.kind !== "thinking" && entry.kind !== "tool") {
      grouped.push(entry);
      index++;
      continue;
    }

    const activities = [];
    while (index < entries.length && (entries[index].kind === "thinking" || entries[index].kind === "tool")) {
      activities.push(entries[index]);
      index++;
    }
    grouped.push(activities.length > 1
      ? { kind: "activity_group", id: "activity-group-" + activities[0].id, entries: activities }
      : activities[0]);
  }
  return grouped;
}

export class PendingWebSubmission {
  constructor({ conversationId, runId, clientMessageId, content, attachments, imageFiles }) {
    this.conversationId = conversationId;
    this.runId = runId;
    this.clientMessageId = clientMessageId;
    this.content = content;
    this.attachments = attachments;
    this.imageFiles = imageFiles;
    this.accepted = false;
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
