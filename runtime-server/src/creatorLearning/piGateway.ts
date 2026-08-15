import { FACTORY_LLM_MODEL, runFactoryLlmPrompt } from "./factoryLlm.js";
import type { FactoryPromptRunner } from "./types.js";

export const PI_FACTORY_MODEL = {
  provider: "moonshot",
  model: FACTORY_LLM_MODEL
} as const;

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
