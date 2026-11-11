import { createCompactionSummaryMessage, estimateTokens, generateSummaryWithUsage, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Models } from "@earendil-works/pi-ai";
import type { Entry, SummarizeInput } from "./compactionStrategy.js";
import { traceObservation } from "./langfuse.js";

/** The Pi side of the compaction port, shared by Chat's adapter and Studio's. */

const WRITE_TOOL = /write|edit|create|save|append|delete|upload|patch/i;
const PATH_KEYS = ["path", "file_path", "filePath", "file"];
const PRUNED = "[Tool result pruned";

type Block = { type: string; text?: string; data?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
const blocksOf = (message: AgentMessage): Block[] => {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Block[] : [];
};

/** A workspace image is `hatch-file:<path>`; any image is shown to a summary as a label, never as pixels. */
export const imageLabel = (block: Block): string => `[image: ${block.data?.startsWith("hatch-file:") ? block.data.slice("hatch-file:".length) : "attached"}]`;

export const textOf = (message: AgentMessage): string =>
  blocksOf(message).map((block) => block.type === "text" ? block.text ?? "" : block.type === "image" ? imageLabel(block) : "").filter(Boolean).join("\n");

const pathsOf = (block: Block): Array<{ path: string; mode: "read" | "write" }> => {
  const args = block.arguments ?? {};
  const mode = WRITE_TOOL.test(block.name ?? "") ? "write" as const : "read" as const;
  return PATH_KEYS.flatMap((key) => typeof args[key] === "string" ? [{ path: args[key] as string, mode }] : []);
};

export function describePiMessage(message: AgentMessage): Entry {
  const tokens = estimateTokens(message);
  if (message.role === "compactionSummary") return { role: "summary", tokens, text: message.summary };
  if (message.role === "user") return { role: "user", tokens, text: textOf(message) };
  if (message.role === "toolResult") {
    const text = textOf(message);
    return { role: "tool", tokens, text, resultFor: message.toolCallId, toolName: message.toolName, ...(text.startsWith(PRUNED) ? { pruned: true } : {}) };
  }
  const calls = blocksOf(message).filter((block) => block.type === "toolCall");
  return {
    role: "assistant", tokens, text: textOf(message),
    ...(calls.length ? { callIds: calls.map((block) => block.id!), paths: calls.flatMap(pathsOf) } : {})
  };
}

/** The same result with a placeholder in place of its content: the call id stays, so the pair is intact. */
export function prunePiMessage(message: AgentMessage, placeholder: string): AgentMessage {
  if (message.role !== "toolResult") return message;
  return { ...message, content: [{ type: "text", text: placeholder }], details: undefined };
}

export const piSummaryMessage = (summary: string, tokensBefore: number): AgentMessage =>
  createCompactionSummaryMessage(summary, tokensBefore, new Date().toISOString());

/** The model call. Messages become text first, so no image bytes and no reminder reach the summarizer. */
export function summarizeWithPi<M>(
  toPi: (message: M) => AgentMessage,
  models: () => { models: Models; model: Model<any> },
  reserveTokens = 10_000
): (input: SummarizeInput<M>) => Promise<string> {
  return async ({ messages, previous, instructions, signal }) => {
    const { models: registry, model } = models();
    const asText = messages.map(toPi).filter((message) => !textOf(message).startsWith("<system-reminder>"));
    // A span, not a generation: the summary request is already a generation underneath, and cost counts once.
    const result = await traceObservation(
      "compaction.summarize",
      { model: model.id, provider: model.provider, metadata: { messages: asText.length, has_previous_summary: Boolean(previous) } },
      () => generateSummaryWithUsage(asText, registry, model, reserveTokens, signal, instructions, previous),
      outcome => outcome.ok
        ? { output: outcome.value.text, metadata: { usage: outcome.value.usage } }
        : { failed: outcome.error.message }
    );
    if (!result.ok) throw result.error;
    return result.value.text;
  };
}
