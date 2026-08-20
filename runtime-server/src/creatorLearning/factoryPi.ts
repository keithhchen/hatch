import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  AssistantMessageEventStream,
  FetchFunction,
  Model,
  ProviderHeaders,
  ProviderStreams,
  SimpleStreamOptions,
  ThinkingLevel
} from "@earendil-works/pi-ai";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { requireLlmApiKey, resolveFactoryLlmProfile, type FactoryLlmProfileName, type LlmProfile } from "../llmProfiles.js";

/**
 * Factory's own Pi boundary.
 *
 * This module intentionally does not import Hatch's consumer Runtime, its
 * `PiAgentRuntime`, `piPrompt`, or `piModel`. It uses the Pi packages directly
 * and owns Factory's provider/model contract here.
 */

export const FACTORY_LLM_MODEL = "kimi-k2.6" as const;
export const FACTORY_KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";
export const FACTORY_KIMI_DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
export const FACTORY_KIMI_DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

const FACTORY_KIMI_PROVIDER_CN = "moonshotai-cn" as const;
const FACTORY_KIMI_PROVIDER_GLOBAL = "moonshotai" as const;
const FACTORY_KIMI_HOSTS = new Set(["api.moonshot.cn", "api.moonshot.ai"]);

export type FactoryLlmModel = Model<"openai-completions">;

export type FactoryPiAdapterOptions = {
  apiKey?: string;
  baseUrl?: string;
  baseURL?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
};

export type FactoryPiAgentOptions = FactoryPiAdapterOptions & {
  initialState?: AgentOptions["initialState"];
  agentOptions?: Omit<AgentOptions, "streamFn" | "getApiKey" | "initialState">;
};

type FactoryProfile = LlmProfile & { name: FactoryLlmProfileName };

type ResolvedFactoryPi = {
  profile: FactoryProfile;
  apiKey: string;
  baseUrl: string;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxTokens?: number;
  thinkingLevel: ThinkingLevel;
};

function positiveIntegerOption(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function profileFor(options: FactoryPiAdapterOptions): FactoryProfile {
  return resolveFactoryLlmProfile(options.env ?? process.env) as FactoryProfile;
}

function endpointFor(options: FactoryPiAdapterOptions, profile: FactoryProfile): string {
  const environment = options.env ?? process.env;
  const configured = profile.name === "kimi-k2.6"
    ? options.baseUrl
      ?? options.baseURL
      ?? environment.OPENAI_BASE_URL
      ?? FACTORY_KIMI_DEFAULT_BASE_URL
    : options.baseUrl
      ?? options.baseURL
      ?? profile.baseUrl;
  return profile.name === "kimi-k2.6"
    ? normalizeKimiBaseUrl(configured)
    : normalizeProviderBaseUrl(configured);
}

function resolveFactoryPi(options: FactoryPiAdapterOptions): ResolvedFactoryPi {
  const profile = profileFor(options);
  const thinkingLevel = options.thinkingLevel ?? profile.thinkingLevel;
  if (profile.name === "kimi-k2.6" && (!thinkingLevel || thinkingLevel === ("off" as string))) {
    throw new Error("Factory Kimi thinking must be enabled");
  }
  return {
    profile,
    apiKey: options.apiKey?.trim() || requireLlmApiKey(profile, options.env ?? process.env),
    baseUrl: endpointFor(options, profile),
    fetch: options.fetch,
    headers: options.headers,
    timeoutMs: positiveIntegerOption("timeoutMs", options.timeoutMs),
    maxRetries: positiveIntegerOption("maxRetries", options.maxRetries),
    maxRetryDelayMs: positiveIntegerOption("maxRetryDelayMs", options.maxRetryDelayMs),
    maxTokens: positiveIntegerOption("maxTokens", options.maxTokens),
    thinkingLevel
  };
}

function resolveFactoryModel(options: FactoryPiAdapterOptions): { profile: FactoryProfile; baseUrl: string } {
  const profile = profileFor(options);
  return { profile, baseUrl: endpointFor(options, profile) };
}

/** Build the Factory model profile without requiring an API key. */
export function createFactoryLlmModel(options: FactoryPiAdapterOptions = {}): FactoryLlmModel {
  const { profile, baseUrl } = resolveFactoryModel(options);
  if (profile.name === "kimi-k2.6") {
    return {
      id: FACTORY_LLM_MODEL,
      name: "Kimi K2.6",
      api: "openai-completions",
      provider: endpointProvider(baseUrl),
      baseUrl,
      reasoning: profile.reasoning,
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
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_completion_tokens",
        supportsStrictMode: true,
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true
      }
    };
  }

  return {
    id: profile.model,
    name: profile.model,
    api: "openai-completions",
    provider: profile.provider,
    baseUrl,
    reasoning: profile.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: true,
      thinkingFormat: "deepseek"
    }
  } as FactoryLlmModel;
}

/**
 * Factory's Pi stream boundary. Pi still owns message conversion, tool
 * execution, retries, and the inner turn loop; this function only adapts the
 * selected Factory provider to Pi's StreamFn contract.
 */
export function createFactoryPiStreamFn(options: FactoryPiAdapterOptions = {}): StreamFn {
  const config = resolveFactoryPi(options);
  const api = openAICompletionsApi();
  return (model, context, streamOptions?: SimpleStreamOptions) => {
    const profile = config.profile;
    const requestOptions: SimpleStreamOptions = {
      ...streamOptions,
      apiKey: streamOptions?.apiKey ?? config.apiKey,
      fetch: finishAwareFetch(
        streamOptions?.fetch ?? config.fetch ?? globalThis.fetch,
        config.timeoutMs ?? FACTORY_KIMI_DEFAULT_HTTP_IDLE_TIMEOUT_MS
      ),
      headers: config.headers || streamOptions?.headers
        ? { ...config.headers, ...streamOptions?.headers }
        : undefined,
      maxRetries: streamOptions?.maxRetries ?? config.maxRetries,
      maxRetryDelayMs: streamOptions?.maxRetryDelayMs ?? config.maxRetryDelayMs,
      ...(streamOptions?.maxTokens === undefined && (config.maxTokens ?? profile.maxTokens) !== undefined
        ? { maxTokens: config.maxTokens ?? profile.maxTokens }
        : {}),
      ...(profile.name === "kimi-k2.6" && streamOptions?.temperature === undefined
        ? { temperature: 1 }
        : profile.temperature !== undefined && streamOptions?.temperature === undefined
          ? { temperature: profile.temperature }
          : {}),
      onPayload: async (payload, payloadModel) => {
        const normalized = normalizeFactoryLlmPayload(payload, profile.name);
        const transformed = await streamOptions?.onPayload?.(normalized, payloadModel);
        return transformed === undefined ? normalized : transformed;
      },
      reasoning: streamOptions?.reasoning === ("off" as string)
        ? config.thinkingLevel
        : streamOptions?.reasoning ?? config.thinkingLevel,
      timeoutMs: streamOptions?.timeoutMs ?? config.timeoutMs
    };
    return api.streamSimple(model, context, requestOptions);
  };
}

/** Build a Factory-owned Pi Agent using the low-level Pi Agent class. */
export function createFactoryPiAgent(options: FactoryPiAgentOptions = {}): Agent {
  const config = resolveFactoryPi(options);
  const model = createFactoryLlmModel(options);
  return new Agent({
    ...(options.agentOptions ?? {}),
    initialState: {
      ...(options.initialState ?? {}),
      model,
      thinkingLevel: config.thinkingLevel
    },
    streamFn: createFactoryPiStreamFn(options),
    getApiKey: () => config.apiKey
  });
}

/** Factory provider payload rules live here, next to the Factory adapter. */
export function normalizeFactoryLlmPayload(payload: unknown, profileName: FactoryLlmProfileName): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  if (profileName !== "kimi-k2.6") {
    return {
      ...(payload as Record<string, unknown>),
      thinking: { type: "disabled" }
    };
  }
  const normalized = { ...(payload as Record<string, unknown>) };
  normalized.thinking = { type: "enabled" };
  normalized.tool_choice = "auto";
  delete normalized.reasoning_effort;
  delete normalized.temperature;
  delete normalized.top_p;
  delete normalized.n;
  delete normalized.presence_penalty;
  delete normalized.frequency_penalty;
  delete normalized.max_tokens;
  return normalized;
}

/** DeepSeek can require a tool turn; Kimi K2.6 must remain on `auto`. */
export function requireFactoryToolChoice(payload: unknown, profileName: FactoryLlmProfileName): unknown {
  if (profileName === "kimi-k2.6" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...(payload as Record<string, unknown>), tool_choice: "required" };
}

function normalizeKimiBaseUrl(value: string): string {
  const raw = value.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Factory Kimi base URL must be an absolute Moonshot API URL");
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const officialMoonshot = endpoint.protocol === "https:"
    && FACTORY_KIMI_HOSTS.has(hostname)
    && !endpoint.port;
  const localTestDouble = endpoint.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if ((!officialMoonshot && !localTestDouble) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Factory Kimi base URL must use an official Moonshot HTTPS endpoint");
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, "") || "/v1";
  return endpoint.toString().replace(/\/$/, "");
}

function normalizeProviderBaseUrl(value: string): string {
  const raw = value.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Factory provider base URL must be an absolute URL");
  }
  const local = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !local) {
    throw new Error("Factory provider base URL must use HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Factory provider base URL cannot contain credentials, query, or hash");
  }
  return endpoint.toString().replace(/\/$/, "");
}

function endpointProvider(baseUrl: string): typeof FACTORY_KIMI_PROVIDER_CN | typeof FACTORY_KIMI_PROVIDER_GLOBAL {
  return new URL(baseUrl).hostname === "api.moonshot.ai"
    ? FACTORY_KIMI_PROVIDER_GLOBAL
    : FACTORY_KIMI_PROVIDER_CN;
}

function sseEventHasFinishReason(event: string): boolean {
  for (const line of event.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data) as { choices?: Array<{ finish_reason?: unknown }> };
      if (payload.choices?.some((choice) => typeof choice.finish_reason === "string" && choice.finish_reason.length > 0)) {
        return true;
      }
    } catch {
      // Let pi-ai parse malformed provider data and report the real error.
    }
  }
  return false;
}

/** Finish an SSE response once the provider has emitted its terminal choice. */
function finishAwareFetch(baseFetch: FetchFunction, timeoutMs?: number): FetchFunction {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (
      !response.ok
      || !response.body
      || !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ) return response;

    const upstream = response.body;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    let streamClosed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = (error: Error): void => {
          if (streamClosed) return;
          streamClosed = true;
          cancelled = true;
          void reader?.cancel(error);
          controller.error(error);
        };
        const arm = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (timeoutMs !== undefined && timeoutMs > 0) {
            timeoutHandle = setTimeout(() => fail(new Error(`Factory provider stream idle timeout after ${timeoutMs}ms`)), timeoutMs);
          }
        };
        arm();
        void (async () => {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffer = "";
          const emit = (): boolean => {
            while (true) {
              const match = buffer.match(/\r?\n\r?\n/);
              if (!match || match.index === undefined) return false;
              const end = match.index + match[0].length;
              const event = buffer.slice(0, end);
              buffer = buffer.slice(end);
              controller.enqueue(encoder.encode(event));
              if (sseEventHasFinishReason(event)) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                streamClosed = true;
                cancelled = true;
                void reader?.cancel();
                controller.close();
                return true;
              }
            }
          };
          try {
            reader = upstream.getReader();
            while (!cancelled) {
              const next = await reader.read();
              if (next.done) {
                buffer += decoder.decode();
                if (buffer.length > 0) controller.enqueue(encoder.encode(buffer));
                if (!cancelled) {
                  streamClosed = true;
                  controller.close();
                }
                return;
              }
              buffer += decoder.decode(next.value, { stream: true });
              arm();
              if (emit()) return;
            }
          } catch (error) {
            if (!streamClosed && !cancelled) {
              streamClosed = true;
              controller.error(error);
            }
          } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            reader?.releaseLock();
          }
        })();
      },
      cancel(reason) {
        streamClosed = true;
        cancelled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        return reader?.cancel(reason);
      }
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

/** Expose a Pi provider collection for Factory diagnostics/compaction callers. */
export function createFactoryPiModels(options: FactoryPiAdapterOptions = {}): { models: ReturnType<typeof createModels>; model: FactoryLlmModel } {
  const config = resolveFactoryPi(options);
  const model = createFactoryLlmModel(options);
  const stream = createFactoryPiStreamFn(options) as (
    requestModel: FactoryLlmModel,
    context: Parameters<StreamFn>[1],
    streamOptions?: SimpleStreamOptions
  ) => AssistantMessageEventStream;
  const api: ProviderStreams = {
    stream: (requestModel, context, streamOptions) => stream(requestModel as FactoryLlmModel, context, streamOptions),
    streamSimple: (requestModel, context, streamOptions) => stream(requestModel as FactoryLlmModel, context, streamOptions)
  };
  const provider = createProvider({
    id: model.provider,
    name: "Factory provider",
    baseUrl: model.baseUrl,
    auth: { apiKey: envApiKeyAuth("Factory LLM API key", [config.profile.apiKeyEnv]) },
    models: [model],
    api
  });
  const models = createModels();
  models.setProvider(provider);
  return { models, model };
}
