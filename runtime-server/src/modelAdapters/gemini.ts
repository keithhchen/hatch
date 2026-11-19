import type { StreamFn } from "@earendil-works/pi-agent-core";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { LlmProfile } from "../llmProfiles.js";
import { traceProviderStream } from "../langfuse.js";
import { withFinishGuard, withToolNameRepair } from "./finish.js";
import {
  resolveOptions,
  type AdapterOptions,
  type Endpoint,
  type ModelAdapter,
  type PiModel,
  type ResolvedModelOptions
} from "./adapter.js";

/** Gemini 4 takes `thinkingLevel` (low | medium | high | xhigh) but pi-ai only sends it for Gemini 3 / Gemma 4 ids and falls back to a dynamic thinkingBudget for the rest, so the level is passed explicitly. */
export const GEMINI_4_MODEL = /^gemini-4/;
const GEMINI_4_LEVELS = { low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" } as const;

/** Google's native Generative AI protocol; its request body is built by pi-ai, so nothing is rewritten. */
export class GeminiAdapter implements ModelAdapter {
  endpoint(profile: LlmProfile, _options: AdapterOptions): Endpoint {
    return { baseUrl: profile.baseUrl, provider: profile.provider };
  }

  resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions {
    return resolveOptions(profile, options, this.endpoint(profile, options));
  }

  model(profile: LlmProfile, endpoint: Endpoint): PiModel {
    return {
      id: profile.model,
      name: profile.model,
      api: "google-generative-ai",
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      reasoning: profile.reasoning,
      input: profile.input ?? ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens
    };
  }

  normalizePayload(_profile: LlmProfile, payload: unknown): unknown {
    return payload;
  }

  streamFn(profile: LlmProfile, config: ResolvedModelOptions): StreamFn {
    const api = googleGenerativeAIApi();
    return (model, context, options?: SimpleStreamOptions) => {
      const streamOptions: SimpleStreamOptions = {
        ...options,
        apiKey: options?.apiKey ?? config.apiKey,
        headers: config.headers || options?.headers ? { ...config.headers, ...options?.headers } : undefined,
        maxRetries: options?.maxRetries ?? config.maxRetries,
        maxRetryDelayMs: options?.maxRetryDelayMs ?? config.maxRetryDelayMs,
        ...(options?.maxTokens === undefined && config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
        reasoning: options?.reasoning ?? config.thinkingLevel,
        timeoutMs: options?.timeoutMs ?? config.timeoutMs
      };
      const level = GEMINI_4_MODEL.test(profile.model) ? GEMINI_4_LEVELS[profile.thinkingLevel as keyof typeof GEMINI_4_LEVELS] : undefined;
      // The same request pi-ai builds for streamSimple, with the level named; thought signatures are replayed by pi-ai's message conversion.
      const call = (m: typeof model, c: typeof context, o?: SimpleStreamOptions) =>
        level ? api.stream(m, c, { ...o, thinking: { enabled: true, level } } as never) : api.streamSimple(m, c, o);
      return withToolNameRepair(withFinishGuard((m, c, o) => traceProviderStream(() => call(m, c, o), m, c, o)))(model, context, streamOptions);
    };
  }
}
