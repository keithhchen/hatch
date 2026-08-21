import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createFactoryPiAgent,
  requireFactoryToolChoice,
  type FactoryPiAdapterOptions
} from "./factoryPi.js";
import { resolveFactoryLlmProfile, type FactoryLlmProfileName, type LlmProfile } from "../llmProfiles.js";
import { createFactorySubmissionProtocol } from "./factorySubmission.js";
import type { FactoryPromptFailureTelemetry, FactoryPromptRunner } from "./types.js";

const FACTORY_LLM_PROFILE = resolveFactoryLlmProfile({ HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" });
/** A single Factory turn must not hold a worker lease indefinitely. */
export const FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS = 15 * 60_000;
/** Total input + preserved multi-turn history + output capacity. */
export const FACTORY_LLM_CONTEXT_WINDOW = FACTORY_LLM_PROFILE.contextWindow;
/** Moonshot's documented Kimi K2.6 default maximum for one completion. */
export const FACTORY_LLM_MAX_COMPLETION_TOKENS = FACTORY_LLM_PROFILE.maxTokens;
export const FACTORY_PROVIDER_QUOTA_MESSAGE =
  "Factory LLM provider quota is unavailable; recharge or increase the provider quota, then retry this stage";
export const FACTORY_PROVIDER_TRANSIENT_MESSAGE =
  "Factory LLM provider request failed temporarily; retry this stage";
export const FACTORY_PROVIDER_CONFIGURATION_MESSAGE =
  "Factory LLM provider rejected the request; verify provider credentials and configuration, then retry this stage";
/**
 * A provider may end a normal assistant turn without using the host-owned
 * submission tools even though tools are available. Give the protocol one
 * bounded repair turn; never let this become an unbounded model/prompt loop.
 */
const MAX_SUBMISSION_REPAIR_TURNS = 1;
const SUBMISSION_REPAIR_PROMPT = `Protocol repair required: the previous assistant turn ended without an accepted finalize tool call. Do not return the artifact as prose. Continue from the host-retained draft, use the available local submission tool(s), and call the contract's required finalize tool as the last tool call. If no draft was retained, submit the complete result first, then finalize. Stop immediately after the host accepts FINALIZED.`;

export type FactoryProviderFailure = {
  code: "provider_quota" | "provider_error";
  retryability: "immediate" | "after_operator_action";
  message: string;
};

type FactoryLlmAdapterOptions = FactoryPiAdapterOptions & {
  /** Hard deadline for one prompt, in addition to the HTTP idle timeout. */
  wallClockTimeoutMs?: number;
};

export { FACTORY_LLM_MODEL, createFactoryLlmModel } from "./factoryPi.js";
export type { FactoryLlmModel } from "./factoryPi.js";

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
    // Keep this allow-list narrow. Generic words such as "request" and
    // "response" also occur in the private Factory harness/runtime boundary;
    // classifying those as provider failures hides the actionable local error
    // behind a misleading credentials message.
    || /(?:provider|moonshot|openai|api[\s_-]*key|network|fetch|rate[\s_-]*limit|too many requests|timeout|timed out|socket|connection|econn[a-z]*|eai_again)/i.test(message);
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
 * as Hatch, without leaking provider selection into Factory workflow code.
 */
export function createFactoryLlmPromptRunner(
  adapterOptions: FactoryLlmAdapterOptions = {}
): FactoryPromptRunner {
  return async (options): Promise<string> => {
    const selected = resolveFactoryLlmProfile(adapterOptions.env ?? process.env) as LlmProfile & { name: FactoryLlmProfileName };
    const submission = createFactorySubmissionProtocol(options.purpose, options.outputContract);
    const agent = createFactoryPiAgent({
      ...adapterOptions,
      initialState: {
        systemPrompt: `${options.systemPrompt}\n\n# Local Factory submission protocol\n${submission.systemInstructions}`,
        messages: [],
        tools: submission.tools
      },
      agentOptions: {
        onPayload: async (payload) => requireFactoryToolChoice(payload, selected.name),
        transformContext: async (messages) => submission.sanitizeContext(messages),
        toolExecution: "sequential",
        beforeToolCall: (context) => submission.beforeToolCall(context),
        afterToolCall: (context) => submission.afterToolCall(context)
      }
    });
    let rejectedStop: { reason: string; message?: string } | undefined;
    let wallClockTimedOut = false;
    const wallClockTimeoutMs = adapterOptions.wallClockTimeoutMs ?? FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS;
    if (!Number.isInteger(wallClockTimeoutMs) || wallClockTimeoutMs < 1) {
      throw new Error("Factory LLM wallClockTimeoutMs must be a positive integer");
    }
    const wallClockTimer = setTimeout(() => {
      wallClockTimedOut = true;
      agent.abort();
    }, wallClockTimeoutMs);
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
    // earlier precheck and listener installation during a very long model call.
    if (options.signal?.aborted) abort();

    try {
      try {
        const images: ImageContent[] = (options.images ?? []).map((image) => ({
          type: "image",
          data: image.base64,
          mimeType: image.mediaType
        }));
        await agent.prompt(options.prompt, images);
        // The first prompt may return a provider-level aborted message after
        // the hard deadline fires. Never start a protocol-repair turn after
        // that deadline (or after the caller has lost its lease); doing so
        // would create a fresh Agent run with a fresh abort signal.
        if (wallClockTimedOut) {
          throw new Error(`Factory Kimi K2.6 prompt timed out after ${wallClockTimeoutMs}ms`);
        }
        if (options.signal?.aborted) {
          throw new Error("Factory Kimi K2.6 prompt aborted");
        }
        let repairTurns = 0;
        while (
          !submission.isFinalized()
          && submission.canRepair()
          && repairTurns < MAX_SUBMISSION_REPAIR_TURNS
        ) {
          repairTurns += 1;
          await agent.prompt(SUBMISSION_REPAIR_PROMPT);
        }
      } catch (error) {
        if (wallClockTimedOut) {
          throw new Error(`Factory Kimi K2.6 prompt timed out after ${wallClockTimeoutMs}ms`);
        }
        if (rejectedStop) {
          throw new Error(rejectedStop.message ?? `Factory Kimi K2.6 prompt did not complete: ${rejectedStop.reason}`);
        }
        throw error;
      }
      if (wallClockTimedOut) {
        throw new Error(`Factory Kimi K2.6 prompt timed out after ${wallClockTimeoutMs}ms`);
      }
      if (rejectedStop) {
        throw new Error(rejectedStop.message ?? `Factory Kimi K2.6 prompt did not complete: ${rejectedStop.reason}`);
      }
      if (options.signal?.aborted) throw new Error("Factory Kimi K2.6 prompt aborted");
      const message = [...agent.state.messages]
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      if (!message || message.role !== "assistant") {
        throw new Error("Factory Kimi K2.6 prompt ended without an assistant response");
      }
      // A finalize-only tool turn can legitimately terminate with toolUse.
      // Every other terminal reason still fails closed unless the side-effect-
      // free host FSM had already atomically committed FINALIZED output.
      if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
        throw new Error(message.errorMessage ?? `Factory Kimi K2.6 prompt did not complete: ${message.stopReason}`);
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
      clearTimeout(wallClockTimer);
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      agent.abort();
    }
  };
}

export const runFactoryLlmPrompt = createFactoryLlmPromptRunner();
