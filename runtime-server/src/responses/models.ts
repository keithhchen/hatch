import type { AgentCorpusResolverLike, ResolvedAgentCorpus } from "../agentCorpus.js";
import { resolveSessionBinding, type SessionBinding } from "../chat/sessionBinding.js";
import { EntitlementError, type AuthIdentityResolver } from "../entitlements.js";
import { UUID_V4_RE } from "../identity.js";
import { AgentReleaseUnavailableError } from "../runtimeCorpusResolver.js";
import type { ApiCaller } from "./auth.js";
import { notFound } from "./errors.js";

const PREFIX = "hatch:";

export const modelIdOf = (productId: string): string => `${PREFIX}${productId}`;

/** `hatch:<product id>`, or the bare product id: a Product's id, or undefined for anything else. */
export function productIdOf(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const id = model.startsWith(PREFIX) ? model.slice(PREFIX.length) : model;
  return UUID_V4_RE.test(id) ? id : undefined;
}

export type ModelObject = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  name: string;
  description: string;
  task_brief: { fields: Array<{ id: string; label: string; required: boolean }> } | null;
};

/** A Product of the caller as a model. The release time is not part of a Corpus, so `created` is 0. */
export function modelObject(resolved: Pick<ResolvedAgentCorpus, "corpus">): ModelObject {
  const { product, creator } = resolved.corpus;
  return {
    id: modelIdOf(product.id), object: "model", created: 0, owned_by: creator.name || creator.id,
    name: product.name, description: product.description ?? "",
    task_brief: product.brief_spec ? { fields: product.brief_spec.fields.map(({ id, label, required }) => ({ id, label, required })) } : null
  };
}

/**
 * The models a caller may use: the live Products they own. Everything else, whether it does not exist, belongs to someone
 * else or has no live release, is one answer: `model_not_found`.
 */
export class ModelCatalog {
  constructor(private readonly deps: { corpora: AgentCorpusResolverLike | undefined; identities: AuthIdentityResolver | undefined }) {}

  async list(caller: ApiCaller, signal?: AbortSignal): Promise<ModelObject[]> {
    const owned = await this.corpora().list(caller.accountId, signal);
    return owned.filter((resolved) => resolved.corpus.creator.id === caller.accountId).map(modelObject);
  }

  /** The caller's session for one of their Products: what a run is authorized and scoped by. */
  async bind(caller: ApiCaller, model: unknown, signal?: AbortSignal): Promise<SessionBinding> {
    const productId = productIdOf(model);
    if (!productId) throw this.missing(model);
    try {
      const binding = await resolveSessionBinding(
        { auth_token: caller.token, product_id: productId }, undefined, this.corpora(), this.deps.identities,
        { sub: caller.accountId }, signal
      );
      // The run's model calls are the Chat API's, billed to the owner, and to the key that made the request.
      return { ...binding, usageSurface: "responses_api", ...(caller.clientType === "api_key" && caller.sessionId ? { apiKeyId: caller.sessionId } : {}) };
    } catch (error) {
      const gone = error instanceof AgentReleaseUnavailableError
        || (error instanceof EntitlementError && error.code === "entitlement_required")
        || (error instanceof Error && error.message.startsWith("No current Agent Corpus"));
      if (gone) throw this.missing(model);
      throw error;
    }
  }

  async get(caller: ApiCaller, model: unknown, signal?: AbortSignal): Promise<ModelObject> {
    const binding = await this.bind(caller, model, signal);
    return modelObject({ corpus: binding.agentCorpus! });
  }

  private corpora(): AgentCorpusResolverLike {
    if (!this.deps.corpora) throw new EntitlementError("agent_corpus_unavailable", "Models are not available on this Runtime.");
    return this.deps.corpora;
  }

  private missing(model: unknown) {
    return notFound("model_not_found", `The model ${typeof model === "string" ? `\`${model.slice(0, 80)}\` ` : ""}does not exist or you do not have access to it.`);
  }
}
