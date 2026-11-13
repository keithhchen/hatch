import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";

/** How a provider ended a reply, told in Hatch's own terms. */
export type ProviderFinish = "content_filter" | "length";

// The provider's own words for "I will not say this", by API. Anything else a provider calls an error stays an error.
const REFUSALS: Record<string, ReadonlySet<string>> = {
  "openai-completions": new Set(["content_filter"]),
  "google-generative-ai": new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"])
};

/** Whether the provider stopped this message on purpose (a safety stop, the output limit) rather than by failing. */
export function providerFinish(message: Pick<AssistantMessage, "api" | "stopReason" | "rawStopReason">): ProviderFinish | undefined {
  if (message.stopReason === "length") return "length";
  return message.stopReason === "error" && message.rawStopReason && REFUSALS[message.api]?.has(message.rawStopReason) ? "content_filter" : undefined;
}

const isJson = (text: string): boolean => {
  try { JSON.parse(text); return true; } catch { return false; }
};

/**
 * pi-ai ends a message the way its provider parser decides; two of those decisions let a tool run that must not:
 * Gemini calls any reply that holds a function call `toolUse`, even one cut by the output limit or stopped for safety, and
 * Chat Completions parses a half-written arguments string into an object. This turns each into what it was: a safety stop is
 * an error ending, and a cut call is a `length` message, whose tool calls the Agent reports as not executed.
 */
export const withFinishGuard = (inner: StreamFn, check: { toolArguments?: boolean } = {}): StreamFn => (model, context, options) => {
  const source = inner(model, context, options) as ReturnType<typeof createAssistantMessageEventStream>;
  const out = createAssistantMessageEventStream();
  void (async () => {
    const calls = new Map<number, string>();
    for await (const event of source) {
      if (event.type === "toolcall_delta") calls.set(event.contentIndex, (calls.get(event.contentIndex) ?? "") + event.delta);
      if (event.type !== "done" || !event.message.content.some((block) => block.type === "toolCall")) { out.push(event); continue; }
      const message = event.message;
      const raw = message.rawStopReason;
      const truncated = (message.api === "google-generative-ai" && raw === "MAX_TOKENS")
        || (check.toolArguments && message.api === "openai-completions" && [...calls.values()].some((json) => json.trim() !== "" && !isJson(json)));
      if (truncated) out.push({ type: "done", reason: "length", message: { ...message, stopReason: "length" } });
      else if (message.api === "google-generative-ai" && raw !== undefined && raw !== "STOP") {
        out.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: `Provider stopped with: ${raw}` } });
      } else out.push(event);
    }
    out.end();
  })().catch((error) => {
    out.push({
      type: "error", reason: "error",
      error: {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error), timestamp: Date.now()
      }
    });
    out.end();
  });
  return out;
};
