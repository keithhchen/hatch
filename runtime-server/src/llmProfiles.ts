import type { ThinkingLevel } from "@earendil-works/pi-ai";

export const LLM_PROFILE_NAMES = ["kimi-k2.6", "deepseek-v4-flash"] as const;
export type LlmProfileName = (typeof LLM_PROFILE_NAMES)[number];

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
  const configured = (env.HATCH_LLM_PROFILE?.trim() || "kimi-k2.6") as LlmProfileName;
  const profile = PROFILES[configured];
  if (!profile) {
    throw new Error(`Unknown HATCH_LLM_PROFILE: ${configured}. Expected one of: ${LLM_PROFILE_NAMES.join(", ")}`);
  }
  return { ...profile };
}

export function requireLlmApiKey(profile: LlmProfile, env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env[profile.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`Missing ${profile.apiKeyEnv} for LLM profile ${profile.name}`);
  return apiKey;
}
