import type { OutboundMessage } from "../protocol.js";
import type { VisibleConversationPart } from "../store.js";
import { ThinkingPartJournal } from "../thinkingPartJournal.js";

/**
 * A Run's reply as ordered parts (text ranges, thinking, tool calls, skills), built from the events the Run publishes.
 * One account of the order, used wherever a Run's progress is kept: the reply a Run ends with, the progress saved
 * while it runs, and the live view a page joins. Text is placed by its own running length.
 */
export class VisibleParts {
  readonly parts: VisibleConversationPart[] = [];
  private readonly thinking = new ThinkingPartJournal(this.parts);
  private readonly seen = new Set<string>();
  private length = 0;
  private tail = "";

  get textLength(): number { return this.length; }

  /** What must come before the next text so that segments the Run's steps separate read as paragraphs: nothing when text continues text. */
  separator(): string {
    if (!this.length || this.parts.at(-1)?.type === "text") return "";
    return this.tail.endsWith("\n\n") ? "" : this.tail.endsWith("\n") ? "\n" : "\n\n";
  }

  /** Thinking parts with the one still being written marked, as a page that joins mid-thought needs it. */
  view(): Array<VisibleConversationPart & { streaming?: true }> {
    return this.parts.map((part) => this.thinking.isActive(part) ? { ...part, streaming: true as const } : { ...part });
  }

  accept(message: OutboundMessage): void {
    if (message.type === "assistant.delta") {
      const delta = message.delta;
      if (delta.kind === "text") {
        const start = this.length;
        this.length += delta.content.length;
        this.tail = (this.tail + delta.content).slice(-2);
        const last = this.parts.at(-1);
        if (last?.type === "text" && last.end === start) last.end = this.length;
        else this.parts.push({ type: "text", start, end: this.length });
      } else if (delta.kind !== "status") this.thinking.accept(delta);
      return;
    }
    if (message.type === "tool_call.delta") {
      this.once(`tool:${message.tool_call_id}`, { type: "tool_call", tool_call_id: message.tool_call_id });
    } else if (message.type === "skill.invoked" || message.type === "skill.activated") {
      const source = message.type === "skill.invoked" ? message.source_tool_call_id : "";
      this.once(["skill", message.status, message.name, message.reason, source].join(":"), {
        type: "skill_event", name: message.name, status: message.status, reason: message.reason,
        ...(message.type === "skill.invoked" ? { source_tool_call_id: message.source_tool_call_id } : {})
      });
    } else if (message.type === "skill.run") {
      this.once(`skill-run:${message.skill_run_id}`, { type: "skill_run", skill_run_id: message.skill_run_id });
    }
  }

  private once(key: string, part: VisibleConversationPart): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.parts.push(part);
  }
}
