import type { LlmProfile, ModelFamily } from "../llmProfiles.js";
import type { AdapterOptions, Endpoint, FactoryModelAdapter, PiModel, ResolvedModelOptions } from "./adapter.js";
import { GeminiAdapter } from "./gemini.js";
import { KimiAdapter } from "./kimi.js";
import { OpenAICompatibleAdapter } from "./openAiCompatible.js";

/*
 * Creator Factory runs the same families with its own request rules: it always asks for a
 * completion as long as the profile allows, and it speaks to a provider only over HTTPS.
 * Each family's Factory adapter extends the family's adapter and overrides only what differs.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Factory's endpoint for a provider that is not Moonshot: the profile's, or the caller's, over HTTPS (or loopback). */
function providerEndpoint(profile: LlmProfile, options: AdapterOptions): Endpoint {
  let endpoint: URL;
  try {
    endpoint = new URL((options.baseUrl ?? options.baseURL ?? profile.baseUrl).trim());
  } catch {
    throw new Error("Factory provider base URL must be an absolute URL");
  }
  const local = endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !local) throw new Error("Factory provider base URL must use HTTPS");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("Factory provider base URL cannot contain credentials, query, or hash");
  }
  return { baseUrl: endpoint.toString().replace(/\/$/, ""), provider: profile.provider };
}

/** A Factory call that sets no output limit gets the profile's. */
const withProfileMaxTokens = (profile: LlmProfile, config: ResolvedModelOptions): ResolvedModelOptions =>
  ({ ...config, maxTokens: config.maxTokens ?? profile.maxTokens });

/** Chat Completions providers (DeepSeek and friends). Thinking is off; the thinking level is still sent. */
export class FactoryOpenAICompatibleAdapter extends OpenAICompatibleAdapter implements FactoryModelAdapter {
  override endpoint(profile: LlmProfile, options: AdapterOptions): Endpoint { return providerEndpoint(profile, options); }

  override resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions {
    return withProfileMaxTokens(profile, super.resolve(profile, options));
  }

  override model(profile: LlmProfile, endpoint: Endpoint): PiModel {
    const model = super.model(profile, endpoint);
    return { ...model, compat: { ...(model as { compat: object }).compat, supportsStrictMode: true } } as PiModel;
  }

  protected override sendsReasoning(): boolean { return true; }

  override normalizePayload(_profile: LlmProfile, payload: unknown): unknown {
    return isRecord(payload) ? { ...payload, thinking: { type: "disabled" } } : payload;
  }

  requireToolChoice(_profile: LlmProfile, payload: unknown): unknown {
    return isRecord(payload) ? { ...payload, tool_choice: "required" } : payload;
  }

  recordedProvider(profile: LlmProfile): string { return profile.provider; }
}

/** Moonshot Kimi K2.6: thinking on, tool choice left to the model, and the sampling knobs Moonshot rejects removed. */
export class FactoryKimiAdapter extends KimiAdapter implements FactoryModelAdapter {
  override resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions {
    return withProfileMaxTokens(profile, super.resolve(profile, options));
  }

  override model(profile: LlmProfile, endpoint: Endpoint): PiModel {
    return {
      id: profile.model,
      name: profile.displayName ?? profile.model,
      api: "openai-completions",
      provider: endpoint.provider,
      baseUrl: endpoint.baseUrl,
      reasoning: profile.reasoning,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
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
    } as PiModel;
  }

  override normalizePayload(_profile: LlmProfile, payload: unknown): unknown {
    if (!isRecord(payload)) return payload;
    const body: Record<string, unknown> = { ...payload, thinking: { type: "enabled" }, tool_choice: "auto" };
    for (const key of ["reasoning_effort", "temperature", "top_p", "n", "presence_penalty", "frequency_penalty", "max_tokens"]) delete body[key];
    return body;
  }

  requireToolChoice(_profile: LlmProfile, payload: unknown): unknown { return payload; }

  recordedProvider(): string { return "moonshot"; }
}

/** Google's native protocol: only the endpoint rule and the tool-call requirement differ. */
export class FactoryGeminiAdapter extends GeminiAdapter implements FactoryModelAdapter {
  override endpoint(profile: LlmProfile, options: AdapterOptions): Endpoint { return providerEndpoint(profile, options); }

  override resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions {
    return withProfileMaxTokens(profile, super.resolve(profile, options));
  }

  requireToolChoice(_profile: LlmProfile, payload: unknown): unknown {
    if (!isRecord(payload)) return payload;
    const config = isRecord(payload.config) ? payload.config : {};
    return { ...payload, config: { ...config, toolConfig: { functionCallingConfig: { mode: "ANY" } } } };
  }

  recordedProvider(profile: LlmProfile): string { return profile.provider; }
}

const FACTORY_ADAPTERS: Record<ModelFamily, FactoryModelAdapter> = {
  kimi: new FactoryKimiAdapter(),
  "openai-compatible": new FactoryOpenAICompatibleAdapter(),
  gemini: new FactoryGeminiAdapter()
};

/** The adapter Creator Factory uses for a profile, chosen by the profile's family data. */
export function factoryAdapterFor(profile: LlmProfile): FactoryModelAdapter {
  return FACTORY_ADAPTERS[profile.factoryFamily ?? profile.family];
}
