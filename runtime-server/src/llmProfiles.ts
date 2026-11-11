import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { StallLimits } from "./providerStall.js";

export const RUNTIME_LLM_PROFILE_NAMES = ["kimi-k2.6", "kimi-k2.6-no-thinking", "deepseek-v4-flash", "gemini-api", "gemini-3.1-pro", "kimi-k3.1-pro"] as const;
export const FACTORY_LLM_PROFILE_NAMES = ["kimi-k2.6", "deepseek-v4-flash", "gemini-api", "gemini-3.1-pro", "kimi-k3.1-pro"] as const;
export type FactoryLlmProfileName = (typeof FACTORY_LLM_PROFILE_NAMES)[number];
export const LLM_PROFILE_NAMES = RUNTIME_LLM_PROFILE_NAMES;
export type LlmProfileName = RuntimeLlmProfileName | FactoryLlmProfileName;
export type RuntimeLlmProfileName = (typeof RUNTIME_LLM_PROFILE_NAMES)[number];

export type LlmProfile = {
  name: LlmProfileName;
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
  thinkingType?: "enabled" | "disabled";
  normalizeEmptyToolCallContent: boolean;
  /** How long a call may stay silent; the default of providerStall when absent. */
  stall?: StallLimits;
};

const PROFILES: Record<LlmProfileName, LlmProfile> = {
  "kimi-k2.6": {
    name: "kimi-k2.6",
    provider: "moonshotai-cn",
    providerName: "Moonshot Kimi",
    api: "openai-completions",
    model: "kimi-k2.6",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "LLM_API_KEY",
    contextWindow: 262_144,
    maxTokens: 262_144,
    reasoning: true,
    thinkingLevel: "high",
    temperature: 1,
    normalizeEmptyToolCallContent: true
  },
  "kimi-k2.6-no-thinking": {
    name: "kimi-k2.6-no-thinking",
    provider: "moonshotai-cn",
    providerName: "Moonshot Kimi",
    api: "openai-completions",
    model: "kimi-k2.6",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "LLM_API_KEY",
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: false,
    thinkingLevel: "minimal",
    thinkingType: "disabled",
    normalizeEmptyToolCallContent: true
  },
  "deepseek-v4-flash": {
    name: "deepseek-v4-flash",
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
    normalizeEmptyToolCallContent: false
  },
  "gemini-api": {
    name: "gemini-api",
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
    normalizeEmptyToolCallContent: false
  },
  // The plain pro, not -highspeed: that is the variant the user picked. K3.1 reasons either way: with `thinking: disabled` and
  // a tool-heavy prompt it writes thousands of characters of reasoning into `content`, which the chat shows as the reply.
  // Enabled, the reasoning goes to `reasoning_content` (rendered as thinking) and stays short.
  "kimi-k3.1-pro": {
    name: "kimi-k3.1-pro",
    provider: "moonshotai-cn",
    providerName: "Moonshot Kimi",
    api: "openai-completions",
    model: "kimi-k3.1-pro",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "LLM_API_KEY",
    contextWindow: 262_144,
    maxTokens: 32_768,
    reasoning: true,
    thinkingLevel: "low",
    thinkingType: "enabled",
    normalizeEmptyToolCallContent: true,
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  },
  "gemini-3.1-pro": {
    name: "gemini-3.1-pro",
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
    normalizeEmptyToolCallContent: false,
    // Real Assistant path, about 100 calls: first event 3-15s (thought summaries arrive as one chunk, so the first event ends the
    // thinking). Three simultaneous first calls once got nothing for 120s+ while a new call at that moment answered in 11s: a hung
    // request does not recover, so wait 45s and ask again instead of waiting longer.
    // A connection that drops before any output ("fetch failed") is asked again too, after a backoff, within the same restarts.
    stall: { firstEventMs: 45_000, silenceMs: 60_000, restarts: 2, backoffMs: 1_000 }
  }
};

export function resolveLlmProfile(env: NodeJS.ProcessEnv = process.env): LlmProfile {
  const configured = (env.HATCH_LLM_PROFILE?.trim() || "kimi-k2.6-no-thinking") as RuntimeLlmProfileName;
  const profile = PROFILES[configured];
  if (!profile || !RUNTIME_LLM_PROFILE_NAMES.includes(configured)) {
    throw new Error(`Unknown Runtime HATCH_LLM_PROFILE: ${configured}. Expected one of: ${RUNTIME_LLM_PROFILE_NAMES.join(", ")}`);
  }
  return { ...profile };
}

/** Creator Factory is pinned to the same provider-neutral Kimi K2.6 profile. */
/**
 * Resolve the provider used by Creator Factory. Kimi remains the default and
 * the profile is an explicit deployment choice, never an implicit fallback.
 * This lets production switch to a configured provider when an account is
 * paused for quota/billing without changing the Product/Factory contract.
 */
export function resolveFactoryLlmProfile(env: NodeJS.ProcessEnv = process.env): LlmProfile {
  const configured = (env.HATCH_FACTORY_LLM_PROFILE?.trim() || "kimi-k2.6") as FactoryLlmProfileName;
  const profile = PROFILES[configured];
  if (!profile || !FACTORY_LLM_PROFILE_NAMES.includes(configured)) {
    throw new Error(`Unknown Factory HATCH_FACTORY_LLM_PROFILE: ${configured}. Expected one of: ${FACTORY_LLM_PROFILE_NAMES.join(", ")}`);
  }
  return { ...profile };
}

export function requireLlmApiKey(profile: LlmProfile, env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env[profile.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`Missing ${profile.apiKeyEnv} for LLM profile ${profile.name}`);
  return apiKey;
}
