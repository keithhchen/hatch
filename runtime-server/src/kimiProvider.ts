export const KIMI_MODEL = "kimi-k2.6";
// Keep the provider profile in one place so Factory, Runtime, and audits all
// use the same thinking-enabled Kimi contract.
// Kimi K2.6 currently accepts only temperature=1. Thinking remains enabled;
// this is a provider contract, not a user-facing creativity setting.
export const KIMI_TEMPERATURE = 1;
export const KIMI_THINKING = { type: "enabled" } as const;
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

export type KimiProviderConfig = {
  apiKey: string;
  baseURL: string;
  model: typeof KIMI_MODEL;
  temperature: typeof KIMI_TEMPERATURE;
  thinking: typeof KIMI_THINKING;
};

export type KimiModelRuntimeRecord = {
  provider: "moonshot";
  creator_model: typeof KIMI_MODEL;
  reviewer_model: typeof KIMI_MODEL;
  compaction_model: typeof KIMI_MODEL;
  temperature: typeof KIMI_TEMPERATURE;
  thinking_mode: "enabled";
};

/** Send the explicit thinking mode so every runtime role is observable. */
export function kimiThinkingPayload(): { thinking: typeof KIMI_THINKING } {
  return { thinking: KIMI_THINKING };
}

export function kimiModelRuntimeRecord(): KimiModelRuntimeRecord {
  return {
    provider: "moonshot",
    creator_model: KIMI_MODEL,
    reviewer_model: KIMI_MODEL,
    compaction_model: KIMI_MODEL,
    temperature: KIMI_TEMPERATURE,
    thinking_mode: KIMI_THINKING.type
  };
}

/**
 * Spec v1 has one model contract. Creator execution, delivery review, and
 * compaction all use Kimi K2.6 through an official Moonshot endpoint.  Model
 * overrides are validated instead of silently falling back to another model.
 */
export function requireKimiProviderConfig(env: NodeJS.ProcessEnv = process.env): KimiProviderConfig {
  const apiKey = env.LLM_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing LLM_API_KEY for the Kimi-only runtime");

  for (const name of ["HATCH_CREATOR_MODEL", "HATCH_REVIEWER_MODEL", "HATCH_COMPACTION_MODEL"] as const) {
    const configured = env[name]?.trim();
    if (configured && configured !== KIMI_MODEL) {
      throw new Error(`${name} must be ${KIMI_MODEL}; spec v1 does not fall back to another model`);
    }
  }

  const baseURL = (env.OPENAI_BASE_URL ?? KIMI_DEFAULT_BASE_URL).trim().replace(/\/$/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(baseURL);
  } catch {
    throw new Error("OPENAI_BASE_URL must be an absolute official Moonshot API URL");
  }
  const officialMoonshot = endpoint.protocol === "https:"
    && ["api.moonshot.cn", "api.moonshot.ai"].includes(endpoint.hostname);
  const localTestDouble = endpoint.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (!officialMoonshot && !localTestDouble) {
    throw new Error("OPENAI_BASE_URL must use an official Moonshot endpoint for the Kimi-only runtime");
  }

  return {
    apiKey,
    baseURL,
    model: KIMI_MODEL,
    temperature: KIMI_TEMPERATURE,
    thinking: KIMI_THINKING
  };
}
