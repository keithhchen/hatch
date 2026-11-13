import type { AgentOptions, StreamFn } from "@earendil-works/pi-agent-core";
import type { FetchFunction, Model, ProviderHeaders, ThinkingLevel } from "@earendil-works/pi-ai";
import { requireLlmApiKey, type LlmProfile } from "../llmProfiles.js";

export type PiModel = Model<"openai-completions"> | Model<"google-generative-ai">;

/** Caller-supplied overrides. Credentials and endpoints otherwise come from the profile. */
export interface AdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  /** OpenAI SDK spelling accepted for callers that already use that config. */
  baseURL?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentAdapterOptions extends AdapterOptions {
  initialState?: AgentOptions["initialState"];
  /** Optional Agent hooks/settings; streamFn and getApiKey remain adapter-owned. */
  agentOptions?: Omit<AgentOptions, "streamFn" | "getApiKey" | "initialState">;
}

export type Endpoint = { baseUrl: string; provider: string };

export type ResolvedModelOptions = Endpoint & {
  apiKey: string;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxTokens?: number;
  thinkingLevel: ThinkingLevel;
};

/**
 * Port for one model-provider family. It owns everything family-specific: the endpoint,
 * the model object, the request-body normalization and the stream function. The profile
 * only names the family and carries data.
 */
export interface ModelAdapter {
  endpoint(profile: LlmProfile, options: AdapterOptions): Endpoint;
  model(profile: LlmProfile, endpoint: Endpoint): PiModel;
  streamFn(profile: LlmProfile, config: ResolvedModelOptions): StreamFn;
  /** Provider-boundary rewrite of the request body, applied before the caller's own onPayload. */
  normalizePayload(profile: LlmProfile, payload: unknown): unknown;
  resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions;
}

/**
 * What Creator Factory needs beyond a model call: its own request rules live on the adapter,
 * next to the family's other rules, instead of in name checks at the call sites.
 */
export interface FactoryModelAdapter extends ModelAdapter {
  /** Rewrites a request body so the model must answer with a tool call, where the family can be made to. */
  requireToolChoice(profile: LlmProfile, payload: unknown): unknown;
  /** The provider label Factory records with its work. */
  recordedProvider(profile: LlmProfile): string;
}

export function nonNegativeIntegerOption(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

/** The option resolution every family shares; families differ only in `endpoint`. */
export function resolveOptions(profile: LlmProfile, options: AdapterOptions, endpoint: Endpoint): ResolvedModelOptions {
  const env = options.env ?? process.env;
  const thinkingLevel = options.thinkingLevel ?? profile.thinkingLevel;
  return {
    apiKey: options.apiKey?.trim() || requireLlmApiKey(profile, env),
    ...endpoint,
    fetch: options.fetch,
    headers: options.headers,
    timeoutMs: nonNegativeIntegerOption("timeoutMs", options.timeoutMs),
    maxRetries: nonNegativeIntegerOption("maxRetries", options.maxRetries),
    maxRetryDelayMs: nonNegativeIntegerOption("maxRetryDelayMs", options.maxRetryDelayMs),
    maxTokens: nonNegativeIntegerOption("maxTokens", options.maxTokens),
    thinkingLevel
  };
}
