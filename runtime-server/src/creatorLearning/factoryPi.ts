import type { Agent, AgentOptions, StreamFn } from "@earendil-works/pi-agent-core";
import { KIMI_MODEL, resolveFactoryLlmProfile } from "../llmProfiles.js";
import { factoryAdapterFor } from "../modelAdapters/factory.js";
import { agentFor, modelFor, modelsFor, streamFnFor } from "../modelAdapters/assemble.js";
import type { AdapterOptions, AgentAdapterOptions, PiModel } from "../modelAdapters/adapter.js";

/**
 * Factory's Pi boundary. It does not use Hatch's consumer Runtime, `PiAgentRuntime`, `piPrompt`
 * or `piModel`: it picks the Factory profile and hands every provider rule to that profile's
 * Factory adapter (`modelAdapters/factory.ts`).
 */

export const FACTORY_LLM_MODEL = KIMI_MODEL;

export type FactoryLlmModel = PiModel;
export type FactoryPiAdapterOptions = AdapterOptions;
export type FactoryPiAgentOptions = AgentAdapterOptions & {
  /** Optional provider-native structured-output contract for one Agent. */
  responseFormat?: unknown;
};

/** The Factory profile the environment selects, and the adapter that owns its rules. */
function selected(options: FactoryPiAdapterOptions) {
  const profile = resolveFactoryLlmProfile(options.env ?? process.env);
  return { profile, adapter: factoryAdapterFor(profile) };
}

/** Build the Factory model profile without requiring an API key. */
export function createFactoryLlmModel(options: FactoryPiAdapterOptions = {}): FactoryLlmModel {
  const { profile, adapter } = selected(options);
  return modelFor(adapter, profile, options);
}

/** Pi still owns message conversion, tool execution, retries and the turn loop; the adapter shapes each request. */
export function createFactoryPiStreamFn(options: FactoryPiAdapterOptions = {}): StreamFn {
  const { profile, adapter } = selected(options);
  return streamFnFor(adapter, profile, options);
}

/** Build a Factory-owned Pi Agent using the low-level Pi Agent class. */
export function createFactoryPiAgent(options: FactoryPiAgentOptions = {}): Agent {
  const { profile, adapter } = selected(options);
  const { responseFormat, ...rest } = options;
  const agentOptions = responseFormat === undefined
    ? rest.agentOptions
    : { ...(rest.agentOptions ?? {}), onPayload: structuredOutputPayload(responseFormat, rest.agentOptions?.onPayload) };
  return agentFor(adapter, profile, { ...rest, ...(agentOptions ? { agentOptions } : {}) });
}

function structuredOutputPayload(
  responseFormat: unknown,
  existing?: NonNullable<AgentOptions["onPayload"]>
): NonNullable<AgentOptions["onPayload"]> {
  return async (payload, payloadModel) => {
    const transformed = existing ? await existing(payload, payloadModel) : payload;
    if (!transformed || typeof transformed !== "object" || Array.isArray(transformed)) return transformed;
    return {
      ...(transformed as Record<string, unknown>),
      response_format: responseFormat
    };
  };
}

/** Expose a Pi provider collection for Factory diagnostics/compaction callers. */
export function createFactoryPiModels(options: FactoryPiAdapterOptions = {}) {
  const { profile, adapter } = selected(options);
  return modelsFor(adapter, profile, options);
}
