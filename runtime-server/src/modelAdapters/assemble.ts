import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { AssistantMessageEventStream, Models, ProviderStreams, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { LlmProfile } from "../llmProfiles.js";
import type { AdapterOptions, AgentAdapterOptions, ModelAdapter, PiModel } from "./adapter.js";

/** Pi building blocks for one (adapter, profile): the model, its stream function, a models registry, AgentOptions. */
export function modelFor(adapter: ModelAdapter, profile: LlmProfile, options: AdapterOptions): PiModel {
  return adapter.model(profile, adapter.endpoint(profile, options));
}

export function streamFnFor(adapter: ModelAdapter, profile: LlmProfile, options: AdapterOptions): StreamFn {
  return adapter.streamFn(profile, adapter.resolve(profile, options));
}

export function modelsFor(adapter: ModelAdapter, profile: LlmProfile, options: AdapterOptions): { models: Models; model: PiModel } {
  const config = adapter.resolve(profile, options);
  const model = adapter.model(profile, config);
  const stream = adapter.streamFn(profile, config) as (
    requestModel: PiModel,
    context: Parameters<StreamFn>[1],
    streamOptions?: SimpleStreamOptions
  ) => AssistantMessageEventStream;
  const api: ProviderStreams = {
    stream: (requestModel, context, streamOptions) => stream(requestModel as PiModel, context, streamOptions),
    streamSimple: (requestModel, context, streamOptions) => stream(requestModel as PiModel, context, streamOptions)
  };
  const provider = createProvider({
    id: model.provider,
    name: profile.providerName,
    baseUrl: model.baseUrl,
    auth: { apiKey: envApiKeyAuth("LLM API key", [profile.apiKeyEnv]) },
    models: [model],
    api
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}

export function agentOptionsFor(adapter: ModelAdapter, profile: LlmProfile, options: AgentAdapterOptions): AgentOptions {
  const config = adapter.resolve(profile, options);
  const agentOptions: AgentOptions = {
    ...(options.agentOptions ?? {}),
    initialState: {
      ...(options.initialState ?? {}),
      model: adapter.model(profile, config),
      thinkingLevel: config.thinkingLevel
    },
    streamFn: adapter.streamFn(profile, config),
    getApiKey: () => config.apiKey
  };
  if (config.maxRetryDelayMs !== undefined && agentOptions.maxRetryDelayMs === undefined) agentOptions.maxRetryDelayMs = config.maxRetryDelayMs;
  return agentOptions;
}

export function agentFor(adapter: ModelAdapter, profile: LlmProfile, options: AgentAdapterOptions): Agent {
  return new Agent(agentOptionsFor(adapter, profile, options));
}
