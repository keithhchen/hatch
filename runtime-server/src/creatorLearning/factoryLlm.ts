import type { ImageContent } from "@earendil-works/pi-ai";
import { createFactoryPiAgent, type FactoryPiAdapterOptions } from "./factoryPi.js";
import { resolveFactoryLlmProfile } from "../llmProfiles.js";
import { factoryAdapterFor } from "../modelAdapters/factory.js";
import { UpstreamError } from "../errors/upstream.js";
import { createFactorySubmissionProtocol } from "./factorySubmission.js";
import type { FactoryPromptFailureTelemetry, FactoryPromptRunner } from "./types.js";
import { modelRole } from "../modelRoles.js";

const FACTORY_LLM_PROFILE = resolveFactoryLlmProfile({ HATCH_FACTORY_LLM_PROFILE: modelRole("factory") });
/** A single Factory turn must not hold a worker lease indefinitely. */
export const FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS = 15 * 60_000;
/** Total input + preserved multi-turn history + output capacity. */
export const FACTORY_LLM_CONTEXT_WINDOW = FACTORY_LLM_PROFILE.contextWindow;
/** Moonshot's documented Kimi K3.1 default maximum for one completion. */
export const FACTORY_LLM_MAX_COMPLETION_TOKENS = FACTORY_LLM_PROFILE.maxTokens;
/**
 * A provider may end a normal assistant turn without using the host-owned
 * submission tools even though tools are available. Give the protocol one
 * bounded repair turn; never let this become an unbounded model/prompt loop.
 */
const MAX_SUBMISSION_REPAIR_TURNS = 1;
const SUBMISSION_REPAIR_PROMPT = `Protocol repair required: the previous assistant turn ended without an accepted finalize tool call. Do not return the artifact as prose. Continue from the host-retained draft, use the available local submission tool(s), and call the contract's required finalize tool as the last tool call. If no draft was retained, submit the complete result first, then finalize. Stop immediately after the host accepts FINALIZED.`;

type FactoryLlmAdapterOptions = FactoryPiAdapterOptions & {
  /** Hard deadline for one prompt, in addition to the HTTP idle timeout. */
  wallClockTimeoutMs?: number;
};

export { FACTORY_LLM_MODEL, createFactoryLlmModel } from "./factoryPi.js";
export type { FactoryLlmModel } from "./factoryPi.js";

function failureCode(
  error: unknown,
  aborted: boolean
): FactoryPromptFailureTelemetry["code"] {
  if (aborted) return "aborted";
  const message = error instanceof Error ? error.message : String(error);
  if (/exact submission tool cycle|repeated final validation failure/i.test(message)) return "exact_submission_cycle";
  if (/without an accepted finalize/i.test(message)) return "stopped_without_finalize";
  if (/did not complete: length|output token limit/i.test(message)) return "provider_incomplete";
  const upstream = UpstreamError.of(error);
  if (upstream.kind === "quota") return "provider_quota";
  if (/submission|finalize|tool/i.test(message)) return "submission_protocol_error";
  if (upstream.kind !== "unknown") return "provider_error";
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
    const selected = resolveFactoryLlmProfile(adapterOptions.env ?? process.env);
    const adapter = factoryAdapterFor(selected);
    const submission = createFactorySubmissionProtocol(options.purpose, options.outputContract);
    const agent = createFactoryPiAgent({
      ...adapterOptions,
      initialState: {
        systemPrompt: `${options.systemPrompt}\n\n# Local Factory submission protocol\n${submission.systemInstructions}`,
        messages: [],
        tools: submission.tools
      },
      agentOptions: {
        onPayload: async (payload) => adapter.requireToolChoice(selected, payload),
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
    let modelCalls = 0;
    const unsubscribe = agent.subscribe((event) => {
      submission.observeAgentEvent(event);
      if (event.type === "message_end" && event.message.role === "assistant" && event.message.usage?.totalTokens > 0) {
        void options.onModelCall?.({ id: String(modelCalls++), model: event.message.model, usage: event.message.usage });
      }
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
          throw new Error(`Factory Kimi K3.1 prompt timed out after ${wallClockTimeoutMs}ms`);
        }
        if (options.signal?.aborted) {
          throw new Error("Factory Kimi K3.1 prompt aborted");
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
          throw new Error(`Factory Kimi K3.1 prompt timed out after ${wallClockTimeoutMs}ms`);
        }
        if (rejectedStop) {
          throw new Error(rejectedStop.message ?? `Factory Kimi K3.1 prompt did not complete: ${rejectedStop.reason}`);
        }
        throw error;
      }
      if (wallClockTimedOut) {
        throw new Error(`Factory Kimi K3.1 prompt timed out after ${wallClockTimeoutMs}ms`);
      }
      if (rejectedStop) {
        throw new Error(rejectedStop.message ?? `Factory Kimi K3.1 prompt did not complete: ${rejectedStop.reason}`);
      }
      if (options.signal?.aborted) throw new Error("Factory Kimi K3.1 prompt aborted");
      const message = [...agent.state.messages]
        .reverse()
        .find((candidate) => candidate.role === "assistant");
      if (!message || message.role !== "assistant") {
        throw new Error("Factory Kimi K3.1 prompt ended without an assistant response");
      }
      // A finalize-only tool turn can legitimately terminate with toolUse.
      // Every other terminal reason still fails closed unless the side-effect-
      // free host FSM had already atomically committed FINALIZED output.
      if (message.stopReason !== "stop" && message.stopReason !== "toolUse") {
        throw new Error(message.errorMessage ?? `Factory Kimi K3.1 prompt did not complete: ${message.stopReason}`);
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
      if (code === "provider_quota" || code === "provider_error") throw UpstreamError.of(error);
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
