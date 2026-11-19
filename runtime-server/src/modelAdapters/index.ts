import type { LlmProfile, ModelFamily } from "../llmProfiles.js";
import type { ModelAdapter } from "./adapter.js";
import { GeminiAdapter } from "./gemini.js";
import { KimiAdapter } from "./kimi.js";
import { OpenAICompatibleAdapter } from "./openAiCompatible.js";
import { ReplayAdapter } from "./replay.js";

const ADAPTERS: Record<ModelFamily, ModelAdapter> = {
  kimi: new KimiAdapter(),
  "openai-compatible": new OpenAICompatibleAdapter(),
  gemini: new GeminiAdapter(),
  replay: new ReplayAdapter()
};

/** The adapter a profile names. Selection is by the profile's `family` data, never by its name. */
export function adapterFor(profile: LlmProfile): ModelAdapter {
  return ADAPTERS[profile.family];
}

export { KimiAdapter, GeminiAdapter, OpenAICompatibleAdapter, ReplayAdapter };
