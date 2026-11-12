import type { Agent, AgentOptions, StreamFn } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { resolveLlmProfile } from "./llmProfiles.js";
import { adapterFor } from "./modelAdapters/index.js";
import { agentFor, agentOptionsFor, modelFor, modelsFor, streamFnFor } from "./modelAdapters/assemble.js";
import type { AdapterOptions, AgentAdapterOptions, PiModel } from "./modelAdapters/adapter.js";

export type { PiModel } from "./modelAdapters/adapter.js";
export {
  KIMI_DEFAULT_BASE_URL,
  KIMI_MODEL,
  createKimiAgent,
  createKimiAgentOptions,
  createKimiModel,
  createKimiModels,
  createKimiStreamFn,
  normalizeKimiBaseUrl,
  type KimiAdapterOptions,
  type KimiAgentOptions,
  type KimiModel
} from "./modelAdapters/kimi.js";

/** The active profile and the adapter it names; every Pi building block below goes through them. */
function active(options: AdapterOptions) {
  const profile = resolveLlmProfile(options.env ?? process.env);
  return { profile, adapter: adapterFor(profile) };
}

export function createPiModel(options: AdapterOptions = {}): PiModel {
  const { profile, adapter } = active(options);
  return modelFor(adapter, profile, options);
}

export function createPiStreamFn(options: AdapterOptions = {}): StreamFn {
  const { profile, adapter } = active(options);
  return streamFnFor(adapter, profile, options);
}

export function createPiModels(options: AdapterOptions = {}): { models: Models; model: PiModel } {
  const { profile, adapter } = active(options);
  return modelsFor(adapter, profile, options);
}

export function createPiAgentOptions(options: AgentAdapterOptions = {}): AgentOptions {
  const { profile, adapter } = active(options);
  return agentOptionsFor(adapter, profile, options);
}

export function createPiAgent(options: AgentAdapterOptions = {}): Agent {
  const { profile, adapter } = active(options);
  return agentFor(adapter, profile, options);
}

// Compatibility names used by the runtime's Pi lane.
export { createKimiModel as createKimiPiModel, createKimiStreamFn as createKimiPiStream } from "./modelAdapters/kimi.js";
