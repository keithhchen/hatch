import { FACTORY_KIMI_K3_MODEL, runFactoryKimiK3Prompt } from "./factoryKimiK3.js";
import type { FactoryPromptRunner } from "./types.js";

export const PI_FACTORY_MODEL = {
  provider: "moonshot",
  model: FACTORY_KIMI_K3_MODEL
} as const;

/**
 * Evidence extraction, evaluation, and Corpus compilation use the Factory's
 * dedicated K3 profile through the product-owned Pi Agent primitive.
 */
export const runFactoryPromptWithPi: FactoryPromptRunner = async (call) => {
  return runFactoryKimiK3Prompt({
    purpose: call.purpose,
    systemPrompt: call.systemPrompt,
    prompt: call.prompt,
    ...(call.outputContract ? { outputContract: call.outputContract } : {}),
    ...(call.reportFailureTelemetry ? { reportFailureTelemetry: call.reportFailureTelemetry } : {}),
    ...(call.signal ? { signal: call.signal } : {})
  });
};
