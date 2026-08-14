import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const RUNTIME_LLM_PROFILE_NAMES = ["kimi-k2.6", "kimi-k2.6-no-thinking", "deepseek-v4-flash"] as const;
export const FACTORY_LLM_PROFILE_NAME = "kimi-k2.6" as const;
export const LLM_PROFILE_NAMES = RUNTIME_LLM_PROFILE_NAMES;
export type LlmProfileName = (typeof LLM_PROFILE_NAMES)[number];
export type RuntimeLlmProfileName = (typeof RUNTIME_LLM_PROFILE_NAMES)[number];

export type LlmProfile = {
  name: LlmProfileName;
  provider: string;
  providerName: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: "LLM_API_KEY" | "DEEPSEEK_API_KEY";
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
  temperature?: number;
  thinkingType?: "enabled" | "disabled";
  normalizeEmptyToolCallContent: boolean;
};

const PROFILES: Record<LlmProfileName, LlmProfile> = {
  "kimi-k2.6": {
    name: "kimi-k2.6",
    provider: "moonshotai-cn",
    providerName: "Moonshot Kimi",
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
    model: "deepseek-v4-flash",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    reasoning: false,
    thinkingLevel: "minimal",
    normalizeEmptyToolCallContent: false
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
export function resolveFactoryLlmProfile(): LlmProfile {
  return { ...PROFILES[FACTORY_LLM_PROFILE_NAME] };
}

export function requireLlmApiKey(profile: LlmProfile, env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env[profile.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`Missing ${profile.apiKeyEnv} for LLM profile ${profile.name}`);
  return apiKey;
}
