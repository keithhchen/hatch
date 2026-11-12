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
