import type { AgentDelta } from "./protocol.js";
import type { VisibleConversationPart } from "./store.js";

export class ThinkingPartJournal {
  private readonly activeParts = new Map<number, Extract<VisibleConversationPart, { type: "thinking" }>>();

  constructor(private readonly orderedParts: VisibleConversationPart[]) {}

  accept(delta: AgentDelta["delta"]): void {
    if (delta.kind === "thinking_start") {
      if (this.activeParts.has(delta.contentIndex)) {
        throw new Error("Thinking content index " + delta.contentIndex + " started more than once");
      }
      const part: Extract<VisibleConversationPart, { type: "thinking" }> = {
        type: "thinking",
        contentIndex: delta.contentIndex,
        content: ""
      };
      this.orderedParts.push(part);
      this.activeParts.set(delta.contentIndex, part);
      return;
    }

    if (delta.kind === "thinking_delta") {
      this.requirePart(delta.contentIndex).content += delta.delta;
      return;
    }

    if (delta.kind === "thinking_end") {
      const part = this.requirePart(delta.contentIndex);
      part.content = delta.content;
      this.activeParts.delete(delta.contentIndex);
    }
  }

  private requirePart(contentIndex: number): Extract<VisibleConversationPart, { type: "thinking" }> {
    const part = this.activeParts.get(contentIndex);
    if (!part) throw new Error("Thinking event arrived before start for content index " + contentIndex);
    return part;
  }
}
