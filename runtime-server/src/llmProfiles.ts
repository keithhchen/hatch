import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { StallLimits } from "./providerStall.js";
import { ModelProfileError } from "./errors/modelProfile.js";

/** The catalogue of usable models. Which role runs on which profile is data (`hatch_model_roles`), not code: see modelRoles.ts. */
export const RUNTIME_LLM_PROFILE_NAMES = ["deepseek-v4-flash", "gemini-api", "gemini-3.1-pro", "kimi-k3.1-pro", "deepseek-v4-pro", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen"] as const;
export const FACTORY_LLM_PROFILE_NAMES = ["deepseek-v4-flash", "gemini-api", "gemini-3.1-pro", "kimi-k3.1-pro", "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen"] as const;
export type FactoryLlmProfileName = (typeof FACTORY_LLM_PROFILE_NAMES)[number];
export const LLM_PROFILE_NAMES = RUNTIME_LLM_PROFILE_NAMES;
export type LlmProfileName = RuntimeLlmProfileName | FactoryLlmProfileName;
export type RuntimeLlmProfileName = (typeof RUNTIME_LLM_PROFILE_NAMES)[number];

/** The model every Kimi use runs; the one place its name is spelled outside the profile table. */
export const KIMI_MODEL = "kimi-k3.1-pro" as const;

/** Which provider adapter owns a profile's endpoint, model object and request normalization. */
export type ModelFamily = "kimi" | "openai-compatible" | "gemini";

export type LlmProfile = {
  name: LlmProfileName;
  family: ModelFamily;
  provider: string;
  providerName: string;
  api: "openai-completions" | "google-generative-ai";
  model: string;
  baseUrl: string;
  apiKeyEnv: "LLM_API_KEY" | "DEEPSEEK_API_KEY" | "GEMINI_API_KEY";
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
  temperature?: number;
  /** Env var that may override baseUrl (validated by the adapter). */
  endpointEnv?: string;
  displayName?: string;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingType?: "enabled" | "disabled";
  /** Moonshot's top-level `reasoning_effort`, sent on every request in place of a `thinking` field. */
  reasoningEffort?: "low" | "high" | "max";
  /** What the model reads; both text and images when absent. */
  input?: Array<"text" | "image">;
  /** How long a call may stay silent; the default of providerStall when absent. */
  stall?: StallLimits;
};

const PROFILES: Record<LlmProfileName, LlmProfile> = {
  "deepseek-v4-flash": {
    name: "deepseek-v4-flash",
    family: "openai-compatible",
    provider: "deepseek",
    providerName: "DeepSeek",
    api: "openai-completions",
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: false,
    thinkingLevel: "minimal",
    thinkingType: "disabled",
  },
  // DeepSeek's flagship, run without thinking: on the Assistant's real request (58k tokens, 21 tools) its first token comes
  // in about 1-2 s once the prefix is cached, against 3-5 s for Kimi K3.1, and it chose the same tools with valid arguments.
  "deepseek-v4-pro": {
    name: "deepseek-v4-pro",
    family: "openai-compatible",
    provider: "deepseek",
    providerName: "DeepSeek",
    api: "openai-completions",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: false,
    thinkingLevel: "minimal",
    thinkingType: "disabled",
    input: ["text"],
  },
  "gemini-api": {
    name: "gemini-api",
    family: "gemini",
    provider: "google",
    providerName: "Google Gemini API",
    api: "google-generative-ai",
    model: "gemini-3.8-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: true,
    thinkingLevel: "low",
    // Same policy as gemini-3.1-pro: a hung or overloaded (503) call that said nothing is asked again.
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  },
  // The one Kimi profile (plain pro, not -highspeed). K3.1 always reasons and rejects the `thinking` field; depth is the top-level
  // `reasoning_effort`, which defaults to "max" and then took 150 s+ for a non-stream call. "low" keeps the reasoning in
  // `reasoning_content` (rendered as thinking) and short. Reasoning tokens count against max_tokens. temperature is fixed at 1.
  "kimi-k3.1-pro": {
    name: "kimi-k3.1-pro",
    family: "kimi",
    provider: "moonshotai-cn",
    providerName: "Moonshot Kimi",
    api: "openai-completions",
    model: KIMI_MODEL,
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "LLM_API_KEY",
    endpointEnv: "OPENAI_BASE_URL",
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
    thinkingLevel: "low",
    reasoningEffort: "low",
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  },
  "gemini-3.1-pro": {
    name: "gemini-3.1-pro",
    family: "gemini",
    provider: "google",
    providerName: "Google Gemini API",
    api: "google-generative-ai",
    model: "gemini-3.1-pro-preview",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: true,
    thinkingLevel: "low",
    // Real Assistant path, about 100 calls: first event 3-15s (thought summaries arrive as one chunk, so the first event ends the
    // thinking). Three simultaneous first calls once got nothing for 120s+ while a new call at that moment answered in 11s: a hung
    // request does not recover, so wait 45s and ask again instead of waiting longer.
    // A connection that drops before any output ("fetch failed") is asked again too, after a backoff, within the same restarts.
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  },
  "gemini-4-argon": {
    name: "gemini-4-argon",
    family: "gemini",
    provider: "google",
    providerName: "Google Gemini API",
    api: "google-generative-ai",
    model: "gemini-4-argon",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    reasoning: true,
    // The API rejects "minimal" for Gemini 4 (400); low, medium and high are accepted.
    thinkingLevel: "low",
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  },
  "gemini-4-carbon": {
    name: "gemini-4-carbon",
    family: "gemini",
    provider: "google",
    providerName: "Google Gemini API",
    api: "google-generative-ai",
    model: "gemini-4-carbon",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 32_768,
    reasoning: true,
    // The API rejects "minimal" for Gemini 4 (400); low, medium and high are accepted.
    thinkingLevel: "low",
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  },
  "gemini-4-hydrogen": {
    name: "gemini-4-hydrogen",
    family: "gemini",
    provider: "google",
    providerName: "Google Gemini API",
    api: "google-generative-ai",
    model: "gemini-4-hydrogen",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKeyEnv: "GEMINI_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: true,
    // The API rejects "minimal" for Gemini 4 (400); low, medium and high are accepted.
    thinkingLevel: "low",
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  }
};

export function llmProfile(name: LlmProfileName): LlmProfile {
  return { ...PROFILES[name] };
}

/** What a stored assistant message with no model record was written by: those predate recorded models and came from Kimi. */
export const HISTORY_MODEL = { provider: PROFILES["kimi-k3.1-pro"].provider, model: KIMI_MODEL } as const;

export function requireLlmApiKey(profile: LlmProfile, env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env[profile.apiKeyEnv]?.trim();
  if (!apiKey) throw new ModelProfileError(`Missing ${profile.apiKeyEnv} for LLM profile ${profile.name}`);
  return apiKey;
}
