import type { FactoryLlmProfileName, RuntimeLlmProfileName } from "./llmProfiles.js";

/** Which model plays which role. The one place to change a choice. */
export const MODEL_ROLES = {
  /** The Studio Assistant's own chat (`HATCH_LLM_PROFILE`). */
  assistant: "kimi-k3.1-pro" satisfies RuntimeLlmProfileName,
  /** The Assistant's background workers (`HATCH_FACTORY_LLM_PROFILE`). */
  worker: "kimi-k2.6" satisfies FactoryLlmProfileName,
  /** Creator Factory's default (`HATCH_FACTORY_LLM_PROFILE`). */
  factory: "kimi-k2.6" satisfies FactoryLlmProfileName,
  /** Hosted ingest's Kimi agent model (`HATCH_INGEST_MODEL`). */
  ingest: "kimi-k3.1-pro"
} as const;

/** The environment variable that overrides each role. */
const ROLE_ENV = { assistant: "HATCH_LLM_PROFILE", worker: "HATCH_FACTORY_LLM_PROFILE", factory: "HATCH_FACTORY_LLM_PROFILE", ingest: "HATCH_INGEST_MODEL" } as const satisfies Record<keyof typeof MODEL_ROLES, string>;

/** The one rule: a non-empty environment override wins over the MODEL_ROLES default. Every use of a role goes through here. */
export function modelRole(role: keyof typeof MODEL_ROLES, env: NodeJS.ProcessEnv = process.env): string {
  return env[ROLE_ENV[role]]?.trim() || MODEL_ROLES[role];
}
