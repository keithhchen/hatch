import { FACTORY_LLM_MODEL, runFactoryLlmPrompt } from "./factoryLlm.js";
import { resolveFactoryLlmProfile } from "../llmProfiles.js";
import type { FactoryPromptRunner } from "./types.js";

export const PI_FACTORY_MODEL = {
  provider: "moonshot",
  model: FACTORY_LLM_MODEL
} as const;

/** Return the durable metadata for the explicitly selected Factory profile. */
export function factoryModelForEnvironment(environment: NodeJS.ProcessEnv = process.env): { provider: string; model: string } {
  const profile = resolveFactoryLlmProfile(environment);
  return {
    provider: profile.name === "kimi-k2.6" ? "moonshot" : profile.provider,
    model: profile.model
  };
}

/**
 * Evidence extraction, evaluation, and Corpus compilation use the Factory's
 * provider-neutral prompt seam through the product-owned Pi Agent primitive.
 */
export const runFactoryPromptWithPi: FactoryPromptRunner = async (call) => {
  return runFactoryLlmPrompt({
    purpose: call.purpose,
    systemPrompt: call.systemPrompt,
    prompt: call.prompt,
    ...(call.images ? { images: call.images } : {}),
    ...(call.outputContract ? { outputContract: call.outputContract } : {}),
    ...(call.reportFailureTelemetry ? { reportFailureTelemetry: call.reportFailureTelemetry } : {}),
    ...(call.signal ? { signal: call.signal } : {})
  });
};
