import { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  KIMI_DEFAULT_BASE_URL,
  createKimiStreamFn,
  normalizeKimiBaseUrl,
  type KimiAdapterOptions
} from "../piModel.js";
import { resolveFactoryLlmProfile } from "../llmProfiles.js";
import { createFactorySubmissionProtocol } from "./factorySubmission.js";
import type { FactoryPromptFailureTelemetry, FactoryPromptRunner } from "./types.js";

export const FACTORY_KIMI_K3_MODEL = "kimi-k3" as const;
const FACTORY_KIMI_K3_PROFILE = resolveFactoryLlmProfile();
/** Total input + preserved multi-turn history + output capacity. */
export const FACTORY_KIMI_K3_CONTEXT_WINDOW = FACTORY_KIMI_K3_PROFILE.contextWindow;
/** Moonshot's documented Kimi K3 default maximum for one completion. */
export const FACTORY_KIMI_K3_MAX_COMPLETION_TOKENS = FACTORY_KIMI_K3_PROFILE.maxTokens;
export const FACTORY_PROVIDER_QUOTA_MESSAGE =
  "Factory LLM provider quota is unavailable; recharge or increase the provider quota, then retry this stage";
export const FACTORY_PROVIDER_TRANSIENT_MESSAGE =
  "Factory LLM provider request failed temporarily; retry this stage";
export const FACTORY_PROVIDER_CONFIGURATION_MESSAGE =
  "Factory LLM provider rejected the request; verify provider credentials and configuration, then retry this stage";

export type FactoryProviderFailure = {
  code: "provider_quota" | "provider_error";
  retryability: "immediate" | "after_operator_action";
  message: string;
};

type FactoryKimiK3AdapterOptions = Pick<
  KimiAdapterOptions,
  | "apiKey"
  | "baseUrl"
  | "baseURL"
  | "env"
  | "fetch"
  | "headers"
  | "timeoutMs"
  | "maxRetries"
  | "maxRetryDelayMs"
>;

export type FactoryKimiK3Model = Model<"openai-completions">;

function factoryBaseUrl(options: FactoryKimiK3AdapterOptions): string {
  const env = options.env ?? process.env;
  return normalizeKimiBaseUrl(
    options.baseUrl
      ?? options.baseURL
      ?? env.OPENAI_BASE_URL
      ?? KIMI_DEFAULT_BASE_URL
  );
}

/**
 * Creator Factory's dedicated K3 profile. This is intentionally separate from
 * createKimiModel(), whose K2.6 profile is owned by Hatch Runtime.
 */
export function createFactoryKimiK3Model(
  options: FactoryKimiK3AdapterOptions = {}
): FactoryKimiK3Model {
  const baseUrl = factoryBaseUrl(options);
  return {
    id: FACTORY_KIMI_K3_MODEL,
    name: "Kimi K3",
    api: "openai-completions",
    provider: new URL(baseUrl).hostname === "api.moonshot.ai" ? "moonshotai" : "moonshotai-cn",
    baseUrl,
    reasoning: FACTORY_KIMI_K3_PROFILE.reasoning,
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max"
    },
    input: ["text", "image"],
    cost: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 0
    },
    contextWindow: FACTORY_KIMI_K3_PROFILE.contextWindow,
    maxTokens: FACTORY_KIMI_K3_PROFILE.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_completion_tokens",
      supportsStrictMode: true,
      thinkingFormat: "openai",
      requiresReasoningContentOnAssistantMessages: true
    }
  };
}

/** K3 fixes these sampling values server-side, so the request must omit them. */
function normalizeFactoryKimiK3Payload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const normalized = { ...(payload as Record<string, unknown>) };
  normalized.reasoning_effort = FACTORY_KIMI_K3_PROFILE.thinkingLevel;
  // Every Factory node has exactly one valid handoff channel: its local
  // submission tools. `auto` previously allowed a long prose-only response
  // that the host necessarily discarded as stopped_without_finalize.
  normalized.tool_choice = "required";
  delete normalized.thinking;
  delete normalized.temperature;
  delete normalized.top_p;
  delete normalized.n;
  delete normalized.presence_penalty;
  delete normalized.frequency_penalty;
  delete normalized.max_tokens;
  return normalized;
}

function providerErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function providerHttpStatus(message: string): number | undefined {
  const match = /^\s*([45]\d\d)\b/.exec(message)
    ?? /\b(?:http(?:\s+error)?|status(?:\s+code)?)\s*[:=]?\s*([45]\d\d)\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

/**
 * Classify an untrusted provider failure without carrying any provider-authored
 * body into durable Factory state. In particular, Moonshot quota responses can
 * contain organization and API-key identifiers in their JSON message.
 */
export function classifyFactoryProviderFailure(error: unknown): FactoryProviderFailure | undefined {
  const message = providerErrorText(error);
  const status = providerHttpStatus(message);
  const quota = /(?:exceeded[\s_-]*(?:current[\s_-]*)?quota|insufficient[\s_-]*(?:balance|quota|credits?)|(?:balance|credits?|quota).{0,64}(?:exhausted|depleted|insufficient)|(?:exhausted|depleted).{0,32}(?:balance|credits?|quota))/i.test(message);
  if (quota) {
    return {
      code: "provider_quota",
      retryability: "after_operator_action",
      message: FACTORY_PROVIDER_QUOTA_MESSAGE
    };
  }

  const carriesCredentialOrAccountIdentifier = /(?:\borg-[a-z0-9][a-z0-9_-]*\b|<?\bak-[a-z0-9][a-z0-9_-]*\b>?|\bsk-[a-z0-9][a-z0-9_-]*\b)/i.test(message);
  const providerShaped = status !== undefined
    || carriesCredentialOrAccountIdentifier
    || /(?:provider|moonshot|openai|api[\s_-]*key|network|fetch|request|response|rate[\s_-]*limit|too many requests|timeout|timed out|socket|connection|econn[a-z]*|eai_again)/i.test(message);
  if (!providerShaped) return undefined;

  const transient = status === 408
    || status === 409
    || status === 425
    || status === 429
    || (status !== undefined && status >= 500)
    || /(?:rate[\s_-]*limit|too many requests|temporar|timeout|timed out|network|fetch|socket|connection|econn[a-z]*|eai_again)/i.test(message);
  return transient
    ? {
        code: "provider_error",
        retryability: "immediate",
        message: FACTORY_PROVIDER_TRANSIENT_MESSAGE
      }
    : {
        code: "provider_error",
        retryability: "after_operator_action",
        message: FACTORY_PROVIDER_CONFIGURATION_MESSAGE
      };
}

function failureCode(
  error: unknown,
  aborted: boolean
): FactoryPromptFailureTelemetry["code"] {
  if (aborted) return "aborted";
  const message = error instanceof Error ? error.message : String(error);
  if (/exact submission tool cycle|repeated final validation failure/i.test(message)) return "exact_submission_cycle";
  if (/without an accepted finalize/i.test(message)) return "stopped_without_finalize";
  if (/did not complete: length|output token limit/i.test(message)) return "provider_incomplete";
  const providerFailure = classifyFactoryProviderFailure(error);
  if (providerFailure?.code === "provider_quota") return "provider_quota";
  if (/submission|finalize|tool/i.test(message)) return "submission_protocol_error";
  if (providerFailure) return "provider_error";
  return "unknown";
}

/**
 * Build a one-shot Factory prompt runner on the same Pi Agent/stream primitive
 * as Hatch, but with the Factory-owned K3 profile and no global model mutation.
 */
export function createFactoryKimiK3PromptRunner(
  adapterOptions: FactoryKimiK3AdapterOptions = {}
): FactoryPromptRunner {
  return async (options): Promise<string> => {
    const submission = createFactorySubmissionProtocol(options.purpose, options.outputContract);
    const agent = new Agent({
      initialState: {
        systemPrompt: `${options.systemPrompt}\n\n# Local Factory submission protocol\n${submission.systemInstructions}`,
        messages: [],
        tools: submission.tools,
        model: createFactoryKimiK3Model(adapterOptions),
        thinkingLevel: FACTORY_KIMI_K3_PROFILE.thinkingLevel
      },
      streamFn: createKimiStreamFn({ ...adapterOptions, thinkingLevel: FACTORY_KIMI_K3_PROFILE.thinkingLevel }),
      onPayload: async (payload) => normalizeFactoryKimiK3Payload(payload),
      transformContext: async (messages) => submission.sanitizeContext(messages),
      toolExecution: "sequential",
      beforeToolCall: (context) => submission.beforeToolCall(context),
      afterToolCall: (context) => submission.afterToolCall(context)
    });
    let rejectedStop: { reason: string; message?: string } | undefined;
    const unsubscribe = agent.subscribe((event) => {
      submission.observeAgentEvent(event);
      if (
        event.type === "message_update"
        && event.assistantMessageEvent.type === "done"
        && event.assistantMessageEvent.reason !== "stop"
        && event.assistantMessageEvent.reason !== "toolUse"
      ) {
        rejectedStop ??= { reason: event.assistantMessageEvent.reason };
        agent.abort();
        return;
      }
      // message_end is an awaited barrier before Pi preflights tool calls.
      // Abort a partial/non-standard assistant batch there: no tool in that
      // batch may execute, and Pi must not auto-continue from salvaged args.
      if (
        event.type === "message_end"
        && event.message.role === "assistant"
        && event.message.stopReason !== "stop"
        && event.message.stopReason !== "toolUse"
      ) {
        rejectedStop ??= {
          reason: event.message.stopReason,
          // `agent.abort()` can mutate the same message object's error text to
          // "Request aborted". Length is a provider completeness failure, so
          // preserve that stable cause instead of the local cancellation text.
          ...(event.message.stopReason !== "length" && event.message.errorMessage
            ? { message: event.message.errorMessage }
            : {})
        };
        agent.abort();
      }
    });
    const abort = (): void => agent.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    // Recheck after registration so a lease-loss abort cannot land between an
    // earlier precheck and listener installation during a very long K3 call.
    if (options.signal?.aborted) abort();

    try {
      try {
        await agent.prompt(options.prompt);
      } catch (error) {
        if (rejectedStop) {
          throw new Error(rejectedStop.message ?? `Factory Kimi K3 prompt did not complete: ${rejectedStop.reason}`);
        }
        throw error;
      }
      if (rejectedStop) {
        throw new Error(rejectedStop.message ?? `Factory Kimi K3 prompt did not complete: ${rejectedStop.reason}`);
      }
      if (options.signal?.aborted) throw new Error("Factory Kimi K3 prompt aborted");
      const message = [...agent.state.messages]
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      if (!message || message.role !== "assistant") {
        throw new Error("Factory Kimi K3 prompt ended without an assistant response");
      }
      // A finalize-only tool turn can legitimately terminate with toolUse.
      // Every other terminal reason still fails closed unless the side-effect-
      // free host FSM had already atomically committed FINALIZED output.
      if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
        throw new Error(message.errorMessage ?? `Factory Kimi K3 prompt did not complete: ${message.stopReason}`);
      }
      return submission.finalizedOutput();
    } catch (error) {
      const code = failureCode(error, options.signal?.aborted === true);
      try {
        options.reportFailureTelemetry?.(submission.failureTelemetry(code));
      } catch {
        // Diagnostics must never replace or mask the execution failure.
      }
      // Never let a provider-authored body cross the adapter boundary. Pi's
      // OpenAI-compatible adapter intentionally includes that body in its
      // display error, and Moonshot may place org/key identifiers in it.
      const providerFailure = classifyFactoryProviderFailure(error);
      if (providerFailure && (code === "provider_quota" || code === "provider_error")) {
        throw new Error(providerFailure.message);
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      agent.abort();
    }
  };
}

export const runFactoryKimiK3Prompt = createFactoryKimiK3PromptRunner();
