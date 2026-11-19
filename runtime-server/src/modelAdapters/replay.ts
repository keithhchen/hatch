import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ModelProfileError } from "../errors/modelProfile.js";
import type { LlmProfile } from "../llmProfiles.js";
import type { AdapterOptions, Endpoint, ModelAdapter, PiModel, ResolvedModelOptions } from "./adapter.js";

/**
 * Load-test replay: the model call is a recording played back (see loadTestReplay/). There is no endpoint and no key.
 * The recording is handed in as `options.replay` by the one place that checks the Product's `load_test_replay` capability;
 * a call made without it (a Product that merely has the profile set, compaction, a title) fails loudly instead of answering.
 */
export class ReplayAdapter implements ModelAdapter {
  endpoint(profile: LlmProfile, _options: AdapterOptions): Endpoint {
    return { baseUrl: profile.baseUrl, provider: profile.provider };
  }

  resolve(profile: LlmProfile, options: AdapterOptions): ResolvedModelOptions {
    return { apiKey: "load_test_replay", ...this.endpoint(profile, options), thinkingLevel: options.thinkingLevel ?? profile.thinkingLevel, ...options.replay ? { replay: options.replay } : {} };
  }

  model(profile: LlmProfile, endpoint: Endpoint): PiModel {
    return {
      id: profile.model, name: profile.model, api: "openai-completions", provider: endpoint.provider, baseUrl: endpoint.baseUrl,
      reasoning: profile.reasoning, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.contextWindow, maxTokens: profile.maxTokens
    } as PiModel;
  }

  normalizePayload(_profile: LlmProfile, payload: unknown): unknown { return payload; }

  streamFn(profile: LlmProfile, config: ResolvedModelOptions): StreamFn {
    if (config.replay) return config.replay;
    throw new ModelProfileError(`Model profile "${profile.name}" replays a recorded Run and runs only for a Product with the load_test_replay capability`, { profile: profile.name });
  }
}
