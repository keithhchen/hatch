import {
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  createCompactionSummaryMessage,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
  uuidv7,
  type AgentMessage,
  type SessionTreeEntry
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  renderUserMessageForModel,
  type ContextAttachment,
  type ConversationMessage
} from "./protocol.js";
import { createPiModels } from "./piModel.js";
import { HISTORY_MODEL, type LlmProfile } from "./llmProfiles.js";
import { persistToolMessage, restoreToolMessage } from "./toolMessage.js";
import { CompactionStrategy, policyFor, type CompactionAdapter, type CompactionPolicy, type CompactionMemory, type Entry, type SummarizeInput } from "./compactionStrategy.js";
import { describePiMessage, summarizeWithPi } from "./piCompaction.js";

export const SUMMARY_PREFIX = COMPACTION_SUMMARY_PREFIX;
export const SUMMARY_SUFFIX = COMPACTION_SUMMARY_SUFFIX;
export const RUNTIME_CONTEXT_PREFIX = "HATCH RUNTIME CONTEXT";

export type CompactionPhase = "pre_turn" | "mid_turn" | "standalone_turn" | "background" | "overflow_recovery";
export type CompactionTrigger = "auto" | "manual";
export type CompactionReason = "context_limit" | "user_requested" | "provider_overflow";

export type RuntimeCompactionMessage = {
  role: string;
  content?: string | null;
  attachments?: ContextAttachment[];
  model_images?: ConversationMessage["model_images"];
  tool_calls?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  tool_content?: ConversationMessage["tool_content"];
  tool_is_error?: boolean;
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
  /** One id for the status, the transcript checkpoint and the channel's single notice. */
  compaction_id?: string;
  stage?: "prune" | "summary" | "degraded";
  /** Only set when a failed summary left a bounded tail; the user is told. */
  degraded?: boolean;
  dropped_messages?: number;
};

export function estimateRuntimeMessageTokens(messages: RuntimeCompactionMessage[]): number {
  return estimateContextTokens(messages.map(toPiMessage)).tokens;
}

const BRACKET_SENDER = /^\[([^\]\n]{1,60})\]/;

/** Chat's view of one message for the shared strategy. Images are path labels; who wrote a message is kept. */
export function describeRuntimeMessage(message: RuntimeCompactionMessage): Entry {
  const entry = describePiMessage(toPiMessage(message));
  if (message.role !== "user") return entry;
  const sender = (message as { sender?: string }).sender ?? BRACKET_SENDER.exec(entry.text)?.[1];
  return sender ? { ...entry, sender } : entry;
}

/** Chat's adapter of the shared compaction port. */
export function chatCompactionAdapter(summarize: (input: SummarizeInput<RuntimeCompactionMessage>) => Promise<string>): CompactionAdapter<RuntimeCompactionMessage> {
  return {
    describe: describeRuntimeMessage,
    prune: (message, placeholder) => ({ ...message, content: null, tool_content: [{ type: "text", text: placeholder }] }),
    summaryMessage: (summary, tokensBefore) => ({ role: "compactionSummary", content: summary, tokens_before: tokensBefore }),
    summarize
  };
}

export type ChatCompactionOptions = {
  summarize?: (input: SummarizeInput<RuntimeCompactionMessage>) => Promise<string>;
  /** Defaults to the model's window. */
  contextWindow?: number;
  cacheTtlMs?: number;
  /** A fixed budget in tokens in place of the one the window gives; the window stays the ceiling. */
  budget?: Partial<Pick<CompactionPolicy, "trigger" | "tail" | "prune" | "hard">>;
  /** Chat conversations have no memory layer, so none is wired; the port stays for one that does. */
  memory?: CompactionMemory<RuntimeCompactionMessage>;
};

/** The one strategy with Chat's adapter. The policy comes from the model's window. */
export function chatCompactionStrategy(profile: LlmProfile, options: ChatCompactionOptions = {}): CompactionStrategy<RuntimeCompactionMessage> {
  const cacheTtlMs = options.cacheTtlMs ?? (Number(process.env.HATCH_PROVIDER_CACHE_TTL_MS) || undefined);
  return new CompactionStrategy(
    chatCompactionAdapter(options.summarize ?? summarizeWithPi((message) => toPiMessage({ ...message, model_images: undefined }), () => createPiModels({ profile }), 8_000)),
    { ...policyFor(options.contextWindow ?? profile.contextWindow, { cacheTtlMs }), ...options.budget },
    options.memory
  );
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
      const content = message.role === "user"
        ? renderUserMessageForModel({ content: message.content ?? null, attachments: message.attachments })
        : message.tool_content?.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? message.content;
      if (content) parts.push(String(content));
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
    const text = renderUserMessageForModel({ content: message.content ?? null, attachments: message.attachments });
    return {
      role: "user",
      content: message.model_images?.length
        ? [{ type: "text", text }, ...structuredClone(message.model_images)] : text,
      timestamp: Date.now()
    };
  }
  if (message.role === "tool") {
    return restoreToolMessage({ ...message, content: message.content ?? null });
  }

  const content: AssistantMessage["content"] = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of toolCalls(message.tool_calls)) {
    content.push({ type: "toolCall", id: call.id, name: call.name, arguments: call.arguments });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: HISTORY_MODEL.provider,
    model: HISTORY_MODEL.model,
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
    return persistToolMessage(message);
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
  return content.startsWith(RUNTIME_CONTEXT_PREFIX);
}

function unwrapSummary(value: string): string {
  if (value.startsWith(SUMMARY_PREFIX)) {
    return value.slice(SUMMARY_PREFIX.length).endsWith(SUMMARY_SUFFIX)
      ? value.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length)
      : value.slice(SUMMARY_PREFIX.length);
  }
  return value;
}

export function nextWindow(state: CompactionWindowState = {}): Pick<CompactionCheckpoint, "window_number" | "first_window_id" | "previous_window_id" | "window_id"> {
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
