import { createCompactionSummaryMessage, estimateTokens, generateSummaryWithUsage, type AgentMessage } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
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

/** Han, kana and hangul characters. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Pi estimates a token as four characters, which holds for English. A CJK character is about one token, so a Chinese
 * conversation was counted at a quarter of its size and never reached the compaction trigger before the provider's window
 * did. The estimate adds the three quarters Pi leaves out for each CJK character, in text and in tool call arguments.
 */
export function estimatePiMessageTokens(message: AgentMessage): number {
  const cjk = JSON.stringify((message as { content?: unknown; summary?: unknown }).content ?? (message as { summary?: unknown }).summary ?? "").match(CJK)?.length ?? 0;
  return estimateTokens(message) + Math.ceil(cjk * 0.75);
}

export function describePiMessage(message: AgentMessage): Entry {
  const tokens = estimatePiMessageTokens(message);
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

/**
 * What the summarizer reads of a tool result. Pi's serializer cuts every tool result to 2,000 characters, which suits a
 * coding agent that runs the command again; a report reads its facts from files and records, and anything past the first
 * 2,000 characters of each never reached the summary. A tool result is handed over as a labelled message instead, which Pi
 * serializes whole (as it does its own command output); only when the messages would not fit the summary model's window is
 * each result shortened, all by the same share.
 */
export function forSummary(messages: AgentMessage[], budgetTokens: number): AgentMessage[] {
  const total = messages.reduce((sum, message) => sum + estimatePiMessageTokens(message), 0);
  const share = total > budgetTokens ? budgetTokens / total : 1;
  return messages.map((message) => {
    if (message.role !== "toolResult") return message;
    const text = textOf(message);
    const kept = share < 1 ? `${text.slice(0, Math.floor(text.length * share))}\n[... ${text.length - Math.floor(text.length * share)} more characters left out to fit the summary]` : text;
    return { role: "custom", customType: "toolResult", content: `[Tool result: ${message.toolName}${message.isError ? ", error" : ""}]\n${kept}`, display: false, timestamp: message.timestamp } as AgentMessage;
  });
}

/** The model call. Messages become text first, so no image bytes and no reminder reach the summarizer. */
export function summarizeWithPi<M>(
  toPi: (message: M) => AgentMessage,
  models: () => { models: Models; model: Model<any> },
  reserveTokens = 10_000
): (input: SummarizeInput<M>) => Promise<string> {
  return async ({ messages, previous, instructions, signal, usage }) => {
    const { models: registry, model } = models();
    // The window holds the messages, the previous summary, the instructions and the summary itself. The estimate runs up to
    // 2.6 times under a provider's own count on ids and JSON (measured 2026-11-19 on Kimi, DeepSeek and Gemini), so a third of it.
    const budget = Math.floor((model.contextWindow - reserveTokens) / 3) - (previous?.length ?? 0);
    const asText = forSummary(messages.map(toPi).filter((message) => !textOf(message).startsWith("<system-reminder>")), budget);
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
    await usage?.({ id: randomUUID(), model: model.id, usage: result.value.usage });
    return result.value.text;
  };
}
