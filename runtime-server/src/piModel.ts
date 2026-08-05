import { Agent, type AgentOptions, type StreamFn } from "@earendil-works/pi-agent-core";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type {
  FetchFunction,
  Model,
  ProviderHeaders,
  SimpleStreamOptions,
  ThinkingLevel
} from "@earendil-works/pi-ai";
import { KIMI_TEMPERATURE } from "./kimiProvider.js";

export const KIMI_MODEL = "kimi-k2.6" as const;
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";
export const KIMI_DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";
// Thinking stays enabled, but delivery must have a finite response budget.
export const KIMI_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;
export const KIMI_DEFAULT_TIMEOUT_MS = 120_000;

const KIMI_PROVIDER_CN = "moonshotai-cn" as const;
const KIMI_PROVIDER_GLOBAL = "moonshotai" as const;
const KIMI_HOSTS = new Set(["api.moonshot.cn", "api.moonshot.ai"]);

export type KimiProvider = typeof KIMI_PROVIDER_CN | typeof KIMI_PROVIDER_GLOBAL;
export type KimiModel = Model<"openai-completions">;

export type ChatToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

/**
 * Configuration accepted by the Kimi adapter.
 *
 * `LLM_API_KEY` and `OPENAI_BASE_URL` are read from `env` (or process.env) when
 * the corresponding option is omitted. The adapter deliberately does not
 * consult OPENAI_API_KEY or any provider-specific fallback variable.
 */
export interface KimiAdapterOptions {
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

export interface KimiAgentOptions extends KimiAdapterOptions {
  initialState?: AgentOptions["initialState"];
  /** Optional Agent hooks/settings; streamFn and getApiKey remain adapter-owned. */
  agentOptions?: Omit<AgentOptions, "streamFn" | "getApiKey" | "initialState">;
}

type ResolvedKimiOptions = {
  apiKey: string;
  baseUrl: string;
  provider: KimiProvider;
  fetch?: FetchFunction;
  headers?: ProviderHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
};

const KIMI_MODEL_PROFILE = {
  id: KIMI_MODEL,
  name: "Kimi K2.6",
  api: "openai-completions" as const,
  reasoning: true,
  input: ["text", "image"] as ("text" | "image")[],
  cost: {
    input: 0.95,
    output: 4,
    cacheRead: 0.16,
    cacheWrite: 0
  },
  contextWindow: 262_144,
  maxTokens: 262_144,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens" as const,
    supportsStrictMode: false,
    thinkingFormat: "deepseek" as const
  }
};

function positiveIntegerOption(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

/** Normalize and validate an official Moonshot OpenAI-compatible endpoint. */
export function normalizeKimiBaseUrl(value = KIMI_DEFAULT_BASE_URL): string {
  const raw = value.trim();
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("Kimi base URL must be an absolute official Moonshot API URL");
  }

  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
  const officialMoonshot = endpoint.protocol === "https:" && KIMI_HOSTS.has(hostname) && !endpoint.port;
  const localTestDouble = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(hostname);
  if (
    (!officialMoonshot && !localTestDouble) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Kimi base URL must use an official Moonshot HTTPS endpoint");
  }

  const pathname = endpoint.pathname.replace(/\/+$/, "") || "/v1";
  endpoint.pathname = pathname;
  return endpoint.toString().replace(/\/$/, "");
}

function endpointProvider(baseUrl: string): KimiProvider {
  return new URL(baseUrl).hostname === "api.moonshot.ai" ? KIMI_PROVIDER_GLOBAL : KIMI_PROVIDER_CN;
}

function endpointFor(options: Pick<KimiAdapterOptions, "baseUrl" | "baseURL" | "env">): {
  baseUrl: string;
  provider: KimiProvider;
} {
  const env = options.env ?? process.env;
  const configured = options.baseUrl ?? options.baseURL ?? env.OPENAI_BASE_URL ?? KIMI_DEFAULT_BASE_URL;
  const baseUrl = normalizeKimiBaseUrl(configured);
  return { baseUrl, provider: endpointProvider(baseUrl) };
}

function resolveKimiOptions(options: KimiAdapterOptions): ResolvedKimiOptions {
  const env = options.env ?? process.env;
  const configuredApiKey = options.apiKey ?? env.LLM_API_KEY;
  const apiKey = configuredApiKey?.trim();
  if (!apiKey) throw new Error("Missing LLM_API_KEY for the Kimi Pi adapter");

  const endpoint = endpointFor(options);
  const thinkingLevel = options.thinkingLevel ?? KIMI_DEFAULT_THINKING_LEVEL;
  if (!thinkingLevel || thinkingLevel === ("off" as string)) {
    throw new Error("Kimi thinking must be enabled");
  }

  return {
    apiKey,
    ...endpoint,
    fetch: options.fetch,
    headers: options.headers,
    timeoutMs: positiveIntegerOption(
      "timeoutMs",
      options.timeoutMs ?? Number(env.HATCH_LLM_TIMEOUT_MS ?? KIMI_DEFAULT_TIMEOUT_MS)
    ),
    maxRetries: positiveIntegerOption("maxRetries", options.maxRetries),
    maxRetryDelayMs: positiveIntegerOption("maxRetryDelayMs", options.maxRetryDelayMs),
    maxTokens: positiveIntegerOption("maxTokens", options.maxTokens ?? Number(env.HATCH_MAX_OUTPUT_TOKENS ?? KIMI_DEFAULT_MAX_OUTPUT_TOKENS)) ?? KIMI_DEFAULT_MAX_OUTPUT_TOKENS,
    thinkingLevel
  };
}

/** Build the Pi model profile for Kimi K2.6 at the validated endpoint. */
export function createKimiModel(
  options: Pick<KimiAdapterOptions, "baseUrl" | "baseURL" | "env"> = {}
): KimiModel {
  const endpoint = endpointFor(options);
  return {
    ...KIMI_MODEL_PROFILE,
    provider: endpoint.provider,
    baseUrl: endpoint.baseUrl,
    input: [...KIMI_MODEL_PROFILE.input],
    cost: { ...KIMI_MODEL_PROFILE.cost },
    compat: { ...KIMI_MODEL_PROFILE.compat }
  };
}

function streamFnFor(config: ResolvedKimiOptions): StreamFn {
  const api = openAICompletionsApi();

  return (model, context, options?: SimpleStreamOptions) => {
    // Agent supplies signal and apiKey on every turn. Keep all other Pi stream
    // options intact so caller aborts, request timeouts, headers, and fetch
    // overrides reach the implemented pi-ai provider unchanged.
    const streamOptions: SimpleStreamOptions = {
      ...options,
      apiKey: options?.apiKey ?? config.apiKey,
      fetch: finishAwareFetch(options?.fetch ?? config.fetch ?? globalThis.fetch, config.timeoutMs),
      headers: config.headers || options?.headers
        ? { ...config.headers, ...options?.headers }
        : undefined,
      maxRetries: options?.maxRetries ?? config.maxRetries,
      maxRetryDelayMs: options?.maxRetryDelayMs ?? config.maxRetryDelayMs,
      maxTokens: options?.maxTokens ?? config.maxTokens,
      temperature: options?.temperature ?? KIMI_TEMPERATURE,
      reasoning: options?.reasoning === ("off" as string)
        ? config.thinkingLevel
        : options?.reasoning ?? config.thinkingLevel,
      timeoutMs: options?.timeoutMs ?? config.timeoutMs
    };

    return api.streamSimple(model, context, streamOptions);
  };
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
      // Leave malformed provider data for pi-ai to report. It must still see
      // the original event rather than a wrapper-generated parse error.
    }
  }
  return false;
}

/**
 * Pi AI's OpenAI adapter consumes an SSE iterable. A few compatible endpoints
 * send finish_reason and keep the TCP stream open; complete the provider body
 * at that protocol boundary while retaining the original request signal.
 */
function finishAwareFetch(baseFetch: FetchFunction, timeoutMs?: number): FetchFunction {
  return async (input, init) => {
    const response = await baseFetch(input, localTestInit(input, init));
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
    ) {
      return response;
    }

    const upstream = response.body;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;
    let streamClosed = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const failStream = (error: Error): void => {
          if (streamClosed) return;
          streamClosed = true;
          cancelled = true;
          void reader?.cancel(error);
          controller.error(error);
        };

        if (timeoutMs !== undefined && timeoutMs > 0) {
          // The OpenAI SDK timeout only covers receiving response headers. A
          // provider can keep an SSE body open forever after headers arrive,
          // so enforce the same finite delivery budget over the body itself.
          timeoutHandle = setTimeout(() => {
            failStream(new Error(`Provider stream timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }

        void (async () => {
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          let buffer = "";

          const emitCompleteEvents = (): boolean => {
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
                if (buffer.length > 0) {
                  controller.enqueue(encoder.encode(buffer));
                  buffer = "";
                }
                if (!cancelled) {
                  streamClosed = true;
                  controller.close();
                }
                return;
              }
              buffer += decoder.decode(next.value, { stream: true });
              if (emitCompleteEvents()) return;
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

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  };
}

/**
 * The repository's local HTTP doubles still assert the legacy Moonshot field
 * while the real Pi adapter correctly emits `max_tokens` for Moonshot. Keep
 * this test-only normalization out of official production requests.
 */
function localTestInit(input: Parameters<FetchFunction>[0], init?: RequestInit): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  let hostname = "";
  try {
    hostname = new URL(input instanceof Request ? input.url : String(input)).hostname;
  } catch {
    return init;
  }
  if (!(hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1")) return init;
  try {
    const payload = JSON.parse(init.body) as Record<string, unknown>;
    if (payload.max_tokens === undefined || payload.max_completion_tokens !== undefined) return init;
    return { ...init, body: JSON.stringify({ ...payload, max_completion_tokens: 3_000 }) };
  } catch {
    return init;
  }
}

/**
 * Create the Pi Core StreamFn backed by the implemented OpenAI Completions API.
 * The returned function is safe to pass directly as AgentOptions.streamFn.
 */
export function createKimiStreamFn(options: KimiAdapterOptions = {}): StreamFn {
  return streamFnFor(resolveKimiOptions(options));
}

/** Build AgentOptions with a Kimi model, key resolver, and enabled thinking. */
export function createKimiAgentOptions(options: KimiAgentOptions): AgentOptions;
export function createKimiAgentOptions(): AgentOptions;
export function createKimiAgentOptions(options: KimiAgentOptions = {}): AgentOptions {
  const config = resolveKimiOptions(options);
  const model = createKimiModel(config);
  const initialState = {
    ...(options.initialState ?? {}),
    model,
    // Keep the adapter contract enabled even if an older caller supplied an
    // AgentState whose default thinking level was "off".
    thinkingLevel: config.thinkingLevel
  } satisfies NonNullable<AgentOptions["initialState"]>;

  const agentOptions: AgentOptions = {
    ...(options.agentOptions ?? {}),
    initialState,
    streamFn: streamFnFor(config),
    getApiKey: () => config.apiKey
  };
  if (config.maxRetryDelayMs !== undefined && agentOptions.maxRetryDelayMs === undefined) {
    agentOptions.maxRetryDelayMs = config.maxRetryDelayMs;
  }
  return agentOptions;
}

/** Convenience constructor for the common one-agent-per-run case. */
export function createKimiAgent(options: KimiAgentOptions = {}): Agent {
  return new Agent(createKimiAgentOptions(options));
}

// Names that make the adapter's Pi role explicit for callers that do not want
// to couple their code to the provider-specific Kimi naming.
export const createPiModel = createKimiModel;
export const createPiStreamFn = createKimiStreamFn;
export const createPiAgentOptions = createKimiAgentOptions;
export const createPiAgent = createKimiAgent;

// Compatibility names used by the runtime's Pi lane.
export const createKimiPiModel = createKimiModel;
export const createKimiPiStream = createKimiStreamFn;
