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

/**
 * Roles a deployment may override, and the variable that does it. The Assistant and worker are fixed:
 * compose always sets HATCH_LLM_PROFILE / HATCH_FACTORY_LLM_PROFILE for other services, so letting them
 * override these roles would silently swap the Assistant's model.
 */
const ROLE_ENV: Partial<Record<keyof typeof MODEL_ROLES, string>> = { factory: "HATCH_FACTORY_LLM_PROFILE", ingest: "HATCH_INGEST_MODEL" };

/** The one rule: an overridable role takes its non-empty environment override, otherwise the MODEL_ROLES default. Every use of a role goes through here. */
export function modelRole(role: keyof typeof MODEL_ROLES, env: NodeJS.ProcessEnv = process.env): string {
  const variable = ROLE_ENV[role];
  return (variable && env[variable]?.trim()) || MODEL_ROLES[role];
}
