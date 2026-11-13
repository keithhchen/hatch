import { createFactoryLlmPromptRunner } from "./factoryLlm.js";
import { factoryAdapterFor } from "../modelAdapters/factory.js";
import type { ModelRoleResolver } from "../modelRoles.js";
import type { FactoryPromptRunner } from "./types.js";

/**
 * Evidence extraction, evaluation, and Corpus compilation use the Factory's
 * provider-neutral prompt seam through the product-owned Pi Agent primitive.
 * Each prompt runs on whatever model the `factory` role names when it starts.
 */
export function factoryPromptRunner(models: ModelRoleResolver, environment: NodeJS.ProcessEnv = process.env): FactoryPromptRunner {
  return createFactoryLlmPromptRunner(models, { env: environment });
}

/** The durable metadata for the model the `factory` role names now: recorded with each Factory call. */
export function factoryModelRecord(models: ModelRoleResolver): () => Promise<{ provider: string; model: string }> {
  return async () => {
    const profile = await models.resolve("factory");
    return { provider: factoryAdapterFor(profile).recordedProvider(profile), model: profile.model };
  };
}
