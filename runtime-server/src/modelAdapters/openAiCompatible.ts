import type { StreamFn } from "@earendil-works/pi-agent-core";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { LlmProfile } from "../llmProfiles.js";
import { traceProviderStream } from "../langfuse.js";
import { finishAwareFetch } from "./finishAwareFetch.js";
import {
  resolveOptions,
  type AdapterOptions,
  type Endpoint,
  type ModelAdapter,
  type PiModel,
  type ResolvedModelOptions
} from "./adapter.js";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

/**
 * Chat Completions providers (DeepSeek and friends). Subclasses override only what their
 * provider does differently: `endpoint` and `normalizePayload`.
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  endpoint(profile: LlmProfile, _options: AdapterOptions): Endpoint {
    return { baseUrl: profile.baseUrl, provider: profile.provider };
  }

  resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions {
    return resolveOptions(profile, options, this.endpoint(profile, options));
  }

  model(profile: LlmProfile, endpoint: Endpoint): PiModel {
    return {
      id: profile.model,
      name: profile.displayName ?? profile.model,
      api: "openai-completions",
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      reasoning: profile.reasoning,
      input: ["text", "image"],
      cost: { ...(profile.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }) },
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
        thinkingFormat: "deepseek"
      }
    } as Model<"openai-completions">;
  }

  normalizePayload(profile: LlmProfile, payload: unknown): unknown {
    if (!profile.thinkingType || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    return { ...(payload as Record<string, unknown>), thinking: { type: profile.thinkingType } };
  }

  /** Whether the profile's thinking level is sent with every request. */
  protected sendsReasoning(_profile: LlmProfile): boolean { return false; }

  streamFn(profile: LlmProfile, config: ResolvedModelOptions): StreamFn {
    const api = openAICompletionsApi();
    return (model, context, options?: SimpleStreamOptions) => {
      // Agent supplies signal and apiKey on every turn. Keep all other Pi stream options intact
      // so caller aborts, request timeouts, headers and fetch overrides reach pi-ai unchanged.
      const streamOptions: SimpleStreamOptions = {
        ...options,
        apiKey: options?.apiKey ?? config.apiKey,
        fetch: finishAwareFetch(
          options?.fetch ?? config.fetch ?? globalThis.fetch,
          config.timeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS
        ),
        headers: config.headers || options?.headers ? { ...config.headers, ...options?.headers } : undefined,
        maxRetries: options?.maxRetries ?? config.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs ?? config.maxRetryDelayMs,
        ...(options?.maxTokens === undefined && config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        ...(profile.temperature !== undefined ? { temperature: options?.temperature ?? profile.temperature } : {}),
        onPayload: async (payload, payloadModel) => {
          const normalized = this.normalizePayload(profile, payload);
          const transformed = await options?.onPayload?.(normalized, payloadModel);
          return transformed === undefined ? normalized : transformed;
        },
        ...(this.sendsReasoning(profile)
          ? { reasoning: options?.reasoning === ("off" as string) ? config.thinkingLevel : options?.reasoning ?? config.thinkingLevel }
          : {}),
        timeoutMs: options?.timeoutMs ?? config.timeoutMs
      };
      return traceProviderStream(() => api.streamSimple(model, context, streamOptions), model, context, streamOptions);
    };
  }
}
