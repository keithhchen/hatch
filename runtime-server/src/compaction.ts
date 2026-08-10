import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  compact,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
  uuidv7,
  type AgentMessage,
  type SessionTreeEntry
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { ConversationMessage } from "./protocol.js";
import { createPiModel, createPiModels } from "./piModel.js";
import { PROJECT_DOCS_CONTEXT_PREFIX } from "./projectDocs.js";

// These are Pi's own model-facing compaction delimiters. Keep the export name
// for the existing event/UI projection, but do not invent a second summary
// protocol in the runtime.
export const SUMMARY_PREFIX = COMPACTION_SUMMARY_PREFIX;
export const SUMMARY_SUFFIX = COMPACTION_SUMMARY_SUFFIX;
export const RUNTIME_CONTEXT_PREFIX = "HATCH RUNTIME CONTEXT";

export type CompactionPhase = "pre_turn" | "mid_turn" | "standalone_turn";
export type CompactionTrigger = "auto" | "manual";
export type CompactionReason = "context_limit" | "user_requested";

export type RuntimeCompactionMessage = {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  usage?: Usage;
  tokens_before?: number;
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
  /** Pi's model-facing summary projection, including Pi's delimiters. */
  message: string;
  replacement_history: ConversationMessage[];
  window_number: number;
  first_window_id: string;
  previous_window_id?: string;
  window_id: string;
};

/**
 * Use Pi's context estimate and default compaction settings. There is no
 * Hatch output budget, per-turn budget, user-message truncation, or env-based
 * replacement threshold here.
 */
export function shouldAutoCompactMessages(messages: RuntimeCompactionMessage[]): boolean {
  const model = createPiModel();
  const contextTokens = estimateContextTokens(messages.map(toPiMessage)).tokens;
  return shouldCompact(contextTokens, model.contextWindow, DEFAULT_COMPACTION_SETTINGS);
}

/** Derived only from Pi's model context window and its default reserve. */
export function autoCompactTokenLimit(): number {
  const model = createPiModel();
  return model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
}

export function estimateRuntimeMessageTokens(messages: RuntimeCompactionMessage[]): number {
  return estimateContextTokens(messages.map(toPiMessage)).tokens;
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
  const entries = toSessionEntries(messages);
  const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
  if (!preparation.ok) throw preparation.error;
  if (!preparation.value) {
    throw new Error("Pi compaction is not applicable to the current session");
  }

  const { models, model } = createPiModels();
  const result = await compact(preparation.value, models, model, undefined, undefined, "high");
  if (!result.ok) throw result.error;

  const summary = result.value.summary;
  const message = `${SUMMARY_PREFIX}${summary}${SUMMARY_SUFFIX}`;
  const replacementHistory: ConversationMessage[] = [
    {
      role: "compactionSummary",
      content: summary,
      tokens_before: result.value.tokensBefore
    },
    ...(result.value.retainedTail ?? []).map(fromPiMessage)
  ];
  return {
    trigger: options.trigger,
    phase: options.phase,
    reason: options.reason,
    message,
    replacement_history: replacementHistory,
    ...nextWindow(options.windowState)
  };
}

/**
 * Compatibility helper for callers that need the projected history without
 * making the summary request. The cut point and retained tail are selected by
 * Pi; the supplied text is treated as the already-generated Pi summary.
 */
export function buildCompactedHistory(
  messages: RuntimeCompactionMessage[],
  summaryMessage: string
): ConversationMessage[] {
  const preparation = prepareCompaction(toSessionEntries(messages), DEFAULT_COMPACTION_SETTINGS);
  if (!preparation.ok) throw preparation.error;
  if (!preparation.value) return [];
  return [
    {
      role: "compactionSummary",
      content: unwrapSummary(summaryMessage),
      tokens_before: estimateRuntimeMessageTokens(messages)
    },
    ...preparation.value.retainedTail.map(fromPiMessage)
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

function toSessionEntries(messages: RuntimeCompactionMessage[]): SessionTreeEntry[] {
  let parentId: string | null = null;
  return messages.map((message) => {
    const id = uuidv7();
    const entry: SessionTreeEntry = {
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: toPiMessage(message)
    };
    parentId = id;
    return entry;
  });
}

function toPiMessage(message: RuntimeCompactionMessage): AgentMessage {
  if (message.role === "compactionSummary") {
    return createCompactionSummaryMessage(
      message.content ?? "",
      message.tokens_before ?? 0,
      new Date().toISOString()
    );
  }
  if (message.role === "user") {
    return { role: "user", content: message.content ?? "", timestamp: Date.now() };
  }
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.tool_call_id ?? "unknown-tool-call",
      toolName: message.tool_name ?? "tool",
      content: [{ type: "text", text: message.content ?? "" }],
      isError: false,
      details: {},
      timestamp: Date.now()
    } as ToolResultMessage;
  }

  const model = createPiModel();
  const content: AssistantMessage["content"] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of toolCalls(message.tool_calls)) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: model.provider,
    model: model.id,
    usage: message.usage ?? emptyUsage(),
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: Date.now()
  };
}

function fromPiMessage(message: AgentMessage): ConversationMessage {
  if (message.role === "compactionSummary") {
    return {
      role: "compactionSummary",
      content: message.summary,
      tokens_before: message.tokensBefore
    };
  }
  if (message.role === "user") {
    return { role: "user", content: contentText(message.content) };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: contentText(message.content),
      tool_call_id: message.toolCallId,
      tool_name: message.toolName
    };
  }
  if (message.role !== "assistant") {
    throw new Error(`Pi compaction returned unsupported message role: ${message.role}`);
  }
  const calls = message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: { name: block.name, arguments: JSON.stringify(block.arguments) }
    }));
  return {
    role: "assistant",
    content: contentText(message.content) || null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(hasUsage(message.usage) ? { usage: message.usage } : {})
  };
}

function toolCalls(value: unknown): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const call = candidate as Record<string, unknown>;
    if (call.type === "toolCall" && typeof call.id === "string" && typeof call.name === "string") {
      return [{ id: call.id, name: call.name, arguments: isRecord(call.arguments) ? call.arguments : {} }];
    }
    const functionValue = isRecord(call.function) ? call.function : undefined;
    if (typeof call.id !== "string" || !functionValue || typeof functionValue.name !== "string") return [];
    let argumentsValue: Record<string, unknown> = {};
    if (typeof functionValue.arguments === "string") {
      try {
        const parsed = JSON.parse(functionValue.arguments);
        if (isRecord(parsed)) argumentsValue = parsed;
      } catch {
        // Pi's model loop will validate the actual arguments; compaction only
        // needs a safe structural representation of the historical call.
      }
    } else if (isRecord(functionValue.arguments)) {
      argumentsValue = functionValue.arguments;
    }
    return [{ id: call.id || `tool-call-${index}`, name: functionValue.name, arguments: argumentsValue }];
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      Boolean(block)
      && typeof block === "object"
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function hasUsage(usage: Usage): boolean {
  return usage.totalTokens > 0 || usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0;
}

function isRebuiltRuntimeContext(content: string): boolean {
  return content.startsWith(RUNTIME_CONTEXT_PREFIX) || content.startsWith(PROJECT_DOCS_CONTEXT_PREFIX);
}

function unwrapSummary(value: string): string {
  if (value.startsWith(SUMMARY_PREFIX)) {
    return value.slice(SUMMARY_PREFIX.length).endsWith(SUMMARY_SUFFIX)
      ? value.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length)
      : value.slice(SUMMARY_PREFIX.length);
  }
  return value;
}

function nextWindow(state: CompactionWindowState = {}): Pick<CompactionCheckpoint, "window_number" | "first_window_id" | "previous_window_id" | "window_id"> {
  const windowId = uuidv7();
  const firstWindowId = state.first_window_id ?? state.window_id ?? uuidv7();
  return {
    window_number: (state.window_number ?? 0) + 1,
    first_window_id: firstWindowId,
    previous_window_id: state.window_id,
    window_id: windowId
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
