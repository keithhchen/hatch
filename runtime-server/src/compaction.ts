import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "./protocol.js";
import { PROJECT_DOCS_CONTEXT_PREFIX } from "./projectDocs.js";
import { requireKimiProviderConfig } from "./kimiProvider.js";

export const SUMMARY_PREFIX = "CONTEXT CHECKPOINT COMPACTION";
export const RUNTIME_CONTEXT_PREFIX = "HATCH RUNTIME CONTEXT";
export const SUMMARIZATION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work."
].join("\n");

export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

export type CompactionPhase = "pre_turn" | "mid_turn" | "standalone_turn";
export type CompactionTrigger = "auto" | "manual";
export type CompactionReason = "context_limit" | "user_requested";

export type RuntimeCompactionMessage = {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
};

export type CompactionWindowState = {
  window_number?: number;
  first_window_id?: string;
  previous_window_id?: string;
  window_id?: string;
};

export type CompactionCheckpoint = {
  trigger: CompactionTrigger;
  phase: CompactionPhase;
  reason: CompactionReason;
  message: string;
  replacement_history: ConversationMessage[];
  window_number: number;
  first_window_id: string;
  previous_window_id?: string;
  window_id: string;
};

export function shouldAutoCompactMessages(messages: RuntimeCompactionMessage[]): boolean {
  const limit = autoCompactTokenLimit();
  return limit !== undefined && estimateRuntimeMessageTokens(messages) >= limit;
}

export function autoCompactTokenLimit(): number | undefined {
  const explicit = positiveIntegerEnv("HATCH_AUTO_COMPACT_LIMIT_TOKENS");
  if (explicit !== undefined) return explicit;

  const tokenWindow = positiveIntegerEnv("HATCH_MODEL_CONTEXT_WINDOW_TOKENS");
  if (tokenWindow !== undefined) return Math.floor(tokenWindow * 0.9);

  const charWindow = positiveIntegerEnv("HATCH_MODEL_CONTEXT_WINDOW_CHARS");
  if (charWindow !== undefined) return Math.floor(approxTokenCount("x".repeat(charWindow)) * 0.9);

  return undefined;
}

export function estimateRuntimeMessageTokens(messages: RuntimeCompactionMessage[]): number {
  return approxTokenCount(runtimeMessagesTranscript(messages));
}

export async function compactRuntimeMessages(
  messages: RuntimeCompactionMessage[],
  options: {
    trigger: CompactionTrigger;
    phase: CompactionPhase;
    reason: CompactionReason;
    windowState?: CompactionWindowState;
  }
): Promise<CompactionCheckpoint> {
  const summarySuffix = await summarizeForCompaction(messages);
  const message = `${SUMMARY_PREFIX}\n${summarySuffix || "(no summary available)"}`;
  const replacementHistory = buildCompactedHistory(messages, message);
  return {
    trigger: options.trigger,
    phase: options.phase,
    reason: options.reason,
    message,
    replacement_history: replacementHistory,
    ...nextWindow(options.windowState)
  };
}

export function buildCompactedHistory(
  messages: RuntimeCompactionMessage[],
  summaryMessage: string,
  maxUserMessageTokens = COMPACT_USER_MESSAGE_MAX_TOKENS
): ConversationMessage[] {
  const realUserMessages = messages
    .filter((message) => message.role === "user" && typeof message.content === "string")
    .map((message) => String(message.content))
    .filter((content) => !isRebuiltRuntimeContext(content) && !isCheckpointSummary(content));
  const selected: string[] = [];
  let remaining = Math.max(0, maxUserMessageTokens);

  for (let index = realUserMessages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = realUserMessages[index] ?? "";
    const tokens = approxTokenCount(message);
    if (tokens <= remaining) {
      selected.push(message);
      remaining -= tokens;
      continue;
    }
    selected.push(truncateApproxTokens(message, remaining));
    break;
  }

  selected.reverse();
  return [
    ...selected.map((content) => ({ role: "user" as const, content })),
    {
      role: "user",
      content: summaryMessage || `${SUMMARY_PREFIX}\n(no summary available)`
    }
  ];
}

export function runtimeMessagesTranscript(messages: RuntimeCompactionMessage[]): string {
  return messages
    .filter((message) => message.role !== "system")
    .filter((message) => !isRebuiltRuntimeContext(typeof message.content === "string" ? message.content : ""))
    .map((message, index) => {
      const parts = [`[${index + 1}] ${message.role}`];
      if (message.tool_call_id) parts.push(`tool_call_id=${message.tool_call_id}`);
      if (message.content) parts.push(String(message.content));
      if (message.tool_calls) parts.push(`tool_calls=${JSON.stringify(message.tool_calls)}`);
      return parts.join("\n");
    })
    .join("\n\n");
}

function isRebuiltRuntimeContext(content: string): boolean {
  return content.startsWith(RUNTIME_CONTEXT_PREFIX) || content.startsWith(PROJECT_DOCS_CONTEXT_PREFIX);
}

function isCheckpointSummary(content: string): boolean {
  return content.startsWith(SUMMARY_PREFIX);
}

async function summarizeForCompaction(messages: RuntimeCompactionMessage[]): Promise<string> {
  const provider = requireKimiProviderConfig();

  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseURL
  });
  const completion = await openai.chat.completions.create({
    model: provider.model,
    temperature: provider.temperature,
    thinking: provider.thinking,
    stream: false,
    messages: [
      { role: "system", content: SUMMARIZATION_PROMPT },
      { role: "user", content: `Conversation transcript:\n\n${runtimeMessagesTranscript(messages)}` }
    ]
  } as any);
  return String(completion.choices?.[0]?.message?.content ?? "").trim();
}

function nextWindow(state: CompactionWindowState = {}): Pick<CompactionCheckpoint, "window_number" | "first_window_id" | "previous_window_id" | "window_id"> {
  const windowId = randomUUID();
  const firstWindowId = state.first_window_id ?? state.window_id ?? randomUUID();
  return {
    window_number: (state.window_number ?? 0) + 1,
    first_window_id: firstWindowId,
    previous_window_id: state.window_id,
    window_id: windowId
  };
}

function approxTokenCount(text: string): number {
  return Math.ceil(Array.from(text).length / 4);
}

function truncateApproxTokens(text: string, maxTokens: number): string {
  return Array.from(text).slice(0, Math.max(0, maxTokens * 4)).join("");
}

function positiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
