import type { AgentCorpus, AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { AgentReleaseUnavailableError } from "../runtimeCorpusResolver.js";
import type { AuthIdentity, EntitlementResolver } from "../entitlements.js";
import { assertEntitlementMatchesIdentity } from "./sessionBinding.js";

/** What a client sees of an Expert Agent: its Creator, the Product's public face, and how it presents. */
export function creatorAgentView(corpus: AgentCorpus) {
  return {
    creator: corpus.creator,
    product: {
      id: corpus.product.id,
      name: corpus.product.name,
      description: corpus.product.description ?? "",
      ...(corpus.product.brief_spec ? { brief_spec: corpus.product.brief_spec } : {}),
      ...(corpus.product.promise ? { promise: corpus.product.promise } : {}),
      ...(corpus.product.boundaries.length ? { boundaries: corpus.product.boundaries } : {})
    },
    presentation: corpus.product.presentation
  };
}

/** The Expert Agents an account may open: the Products it owns, then every entitlement it holds. */
export async function listCreatorAgents(input: {
  claims: AuthIdentity | undefined;
  authToken: string;
  entitlementResolver: EntitlementResolver | undefined;
  agentCorpusResolver: AgentCorpusResolver | undefined;
  signal?: AbortSignal;
}): Promise<Array<Record<string, unknown>>> {
  const { claims, authToken, entitlementResolver, agentCorpusResolver, signal } = input;
  // Access is relational: owned rows are the account's own published
  // Products (addressed by product_id, no entitlement_id); every other
  // row is an entitlement grant.
  const creatorAgents: Array<Record<string, unknown>> = claims && agentCorpusResolver
    ? (await agentCorpusResolver.list(claims.sub, signal)).map(({ corpus, digest }) => ({
      creator_id: corpus.creator.id,
      product_id: corpus.product.id,
      corpus_digest: digest,
      effective_corpus_digest: digest,
      ...creatorAgentView(corpus)
    }))
    : [];
  if (entitlementResolver) {
    const entitlements = await entitlementResolver.list({
      authToken,
      licenseToken: authToken,
      signal
    });
    // Resolve Corpus digests sequentially. A buyer can own many grants and
    // each digest walks bounded assets; unbounded Promise.all multiplies
    // transient memory by the full grant count.
    for (const entitlement of entitlements) {
      signal?.throwIfAborted();
      assertEntitlementMatchesIdentity(claims, entitlement);
      if (!agentCorpusResolver) throw new Error("Current Agent Corpus resolver is unavailable");
      let resolved: Awaited<ReturnType<AgentCorpusResolver["resolve"]>>;
      try {
        resolved = await agentCorpusResolver.resolve(entitlement.creator_id, entitlement.product_id, signal);
      } catch (error) {
        // A withdrawn Agent is not chat-able; it leaves the list like it
        // leaves the Web library. Every other failure still fails the call.
        if (error instanceof AgentReleaseUnavailableError) continue;
        throw error;
      }
      if (resolved.corpus.product.id !== entitlement.product_id || resolved.corpus.creator.id !== entitlement.creator_id) {
        throw new Error(`Entitlement ${entitlement.entitlement_id} does not match its current Agent Corpus`);
      }
      creatorAgents.push({
        entitlement_id: entitlement.entitlement_id,
        creator_id: entitlement.creator_id,
        product_id: entitlement.product_id,
        corpus_digest: resolved.digest,
        purchased_corpus_digest: entitlement.purchased_corpus_digest ?? resolved.digest,
        effective_corpus_digest: resolved.digest,
        ...creatorAgentView(resolved.corpus)
      });
    }
  }
  return creatorAgents;
}
