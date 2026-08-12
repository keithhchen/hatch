import type { AgentCorpusResolver, ResolvedAgentCorpus } from "./agentCorpus.js";
import type { CommerceEventSink } from "./delivery.js";
import { EntitlementError, type EntitlementBinding, type EntitlementVersionHistory } from "./entitlements.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_COMPATIBILITY_DEPTH = 128;

export type EntitledAgentCorpus = ResolvedAgentCorpus & {
  purchased_corpus_digest: string;
  effective_corpus_digest: string;
  version_policy: "pinned" | "track_current_compatible";
  version_history: EntitlementVersionHistory[];
};

/**
 * Selects the only release Runtime may execute for an entitlement.
 *
 * `pinned` never consults current. Compatible tracking walks immutable direct
 * predecessor declarations back from current, then advances Commerce one hop
 * at a time. Runtime uses a newer release only after Commerce confirms that
 * exact lineage (or a later hop on the same lineage during an idempotent
 * replay). Any missing declaration, release, command, or confirmation keeps
 * execution on the last confirmed old release.
 */
export async function resolveEntitledAgentCorpus(
  resolver: Pick<AgentCorpusResolver, "resolve">,
  entitlement: EntitlementBinding,
  commerce?: CommerceEventSink
): Promise<EntitledAgentCorpus> {
  const purchased = await requiredRelease(
    resolver,
    entitlement,
    entitlement.purchased_corpus_digest,
    "purchased"
  );
  const versionPolicy = entitlement.version_policy ?? "pinned";
  const originalHistory = entitlement.version_history ?? [];
  if (versionPolicy === "pinned") {
    return selection(purchased, entitlement.purchased_corpus_digest, "pinned", originalHistory);
  }

  const declaredEffectiveDigest = entitlement.effective_corpus_digest
    ?? entitlement.purchased_corpus_digest;
  const declaredEffective = declaredEffectiveDigest === purchased.digest
    ? purchased
    : await requiredRelease(resolver, entitlement, declaredEffectiveDigest, "effective");

  let current: ResolvedAgentCorpus;
  try {
    current = await resolver.resolve(entitlement.creator_id, entitlement.agent_id);
  } catch {
    return selection(declaredEffective, entitlement.purchased_corpus_digest, versionPolicy, originalHistory);
  }
  if (current.digest === declaredEffective.digest
    || current.corpus.product.id !== entitlement.product_id) {
    return selection(declaredEffective, entitlement.purchased_corpus_digest, versionPolicy, originalHistory);
  }

  const lineage = await compatibleLineage(
    resolver,
    entitlement,
    declaredEffective,
    current
  );
  if (!lineage || lineage.length < 2 || !commerce?.advanceEntitlementVersion) {
    return selection(declaredEffective, entitlement.purchased_corpus_digest, versionPolicy, originalHistory);
  }

  let selectedIndex = 0;
  let history = originalHistory;
  while (selectedIndex < lineage.length - 1) {
    const from = lineage[selectedIndex]!;
    const to = lineage[selectedIndex + 1]!;
    try {
      const response = await commerce.advanceEntitlementVersion({
        entitlement_id: entitlement.entitlement_id,
        from_digest: from.digest,
        to_digest: to.digest,
        from_release_id: from.digest,
        to_release_id: to.digest,
        compatibility_declaration_id: compatibilityDeclarationId(entitlement, to.digest),
        reason: "compatible_release_published"
      }, {
        idempotencyKey: versionAdvanceIdempotencyKey(entitlement.entitlement_id, from.digest, to.digest)
      });
      const projection = entitlementProjection(response);
      const confirmedDigest = projection.effective_corpus_digest;
      const confirmedIndex = lineage.findIndex((release) => release.digest === confirmedDigest);
      // A replay can return a projection that has already advanced farther on
      // this same lineage. It may never confirm an older or unrelated digest.
      if (confirmedIndex < selectedIndex + 1) break;
      selectedIndex = confirmedIndex;
      if (projection.version_history) history = projection.version_history;
    } catch {
      break;
    }
  }

  return selection(
    lineage[selectedIndex]!,
    entitlement.purchased_corpus_digest,
    versionPolicy,
    history
  );
}

async function compatibleLineage(
  resolver: Pick<AgentCorpusResolver, "resolve">,
  entitlement: EntitlementBinding,
  effective: ResolvedAgentCorpus,
  current: ResolvedAgentCorpus
): Promise<ResolvedAgentCorpus[] | undefined> {
  const reverse: ResolvedAgentCorpus[] = [current];
  const seen = new Set([current.digest]);
  let cursor = current;
  for (let depth = 0; depth < MAX_COMPATIBILITY_DEPTH && cursor.digest !== effective.digest; depth += 1) {
    const predecessorDigest = cursor.corpus.release?.backward_compatible_with;
    if (!predecessorDigest || seen.has(predecessorDigest)) return undefined;
    let predecessor: ResolvedAgentCorpus;
    try {
      predecessor = await resolver.resolve(
        entitlement.creator_id,
        entitlement.agent_id,
        predecessorDigest
      );
    } catch {
      return undefined;
    }
    if (predecessor.digest !== predecessorDigest
      || predecessor.corpus.creator.id !== entitlement.creator_id
      || predecessor.corpus.agent_id !== entitlement.agent_id
      || predecessor.corpus.product.id !== entitlement.product_id) {
      return undefined;
    }
    seen.add(predecessorDigest);
    reverse.push(predecessor);
    cursor = predecessor;
  }
  if (cursor.digest !== effective.digest) return undefined;
  return reverse.reverse();
}

async function requiredRelease(
  resolver: Pick<AgentCorpusResolver, "resolve">,
  entitlement: EntitlementBinding,
  digest: string,
  kind: "purchased" | "effective"
): Promise<ResolvedAgentCorpus> {
  try {
    const resolved = await resolver.resolve(entitlement.creator_id, entitlement.agent_id, digest);
    if (resolved.digest !== digest
      || resolved.corpus.creator.id !== entitlement.creator_id
      || resolved.corpus.agent_id !== entitlement.agent_id
      || resolved.corpus.product.id !== entitlement.product_id) {
      throw new Error("release binding mismatch");
    }
    return resolved;
  } catch {
    throw new EntitlementError(
      "entitlement_release_unavailable",
      `The ${kind} Creator Agent release is not available on this Runtime.`
    );
  }
}

function selection(
  resolved: ResolvedAgentCorpus,
  purchasedDigest: string,
  versionPolicy: "pinned" | "track_current_compatible",
  versionHistory: EntitlementVersionHistory[]
): EntitledAgentCorpus {
  return {
    ...resolved,
    purchased_corpus_digest: purchasedDigest,
    effective_corpus_digest: resolved.digest,
    version_policy: versionPolicy,
    version_history: versionHistory
  };
}

function entitlementProjection(value: unknown): {
  effective_corpus_digest?: string;
  version_history?: EntitlementVersionHistory[];
} {
  const outer = record(value);
  const projection = Object.keys(record(outer.entitlement)).length > 0
    ? record(outer.entitlement)
    : outer;
  const effectiveDigest = projection.effective_corpus_digest;
  const history = Array.isArray(projection.version_history)
    ? projection.version_history.map(versionHistoryItem).filter((item): item is EntitlementVersionHistory => Boolean(item))
    : undefined;
  return {
    ...(typeof effectiveDigest === "string" && DIGEST.test(effectiveDigest)
      ? { effective_corpus_digest: effectiveDigest }
      : {}),
    ...(history ? { version_history: history } : {})
  };
}

function versionHistoryItem(value: unknown): EntitlementVersionHistory | undefined {
  const item = record(value);
  if (typeof item.from_digest !== "string"
    || !DIGEST.test(item.from_digest)
    || typeof item.to_digest !== "string"
    || !DIGEST.test(item.to_digest)) return undefined;
  return {
    from_digest: item.from_digest,
    to_digest: item.to_digest,
    ...(typeof item.from_release_id === "string" ? { from_release_id: item.from_release_id } : {}),
    ...(typeof item.to_release_id === "string" ? { to_release_id: item.to_release_id } : {}),
    ...(typeof item.compatibility_declaration_id === "string"
      ? { compatibility_declaration_id: item.compatibility_declaration_id }
      : {}),
    ...(typeof item.reason === "string" ? { reason: item.reason } : {}),
    ...(typeof item.actor_id === "string" ? { actor_id: item.actor_id } : {}),
    ...(typeof item.advanced_at === "string" ? { advanced_at: item.advanced_at } : {})
  };
}

function compatibilityDeclarationId(entitlement: EntitlementBinding, targetDigest: string): string {
  return `corpus-compatibility:${entitlement.creator_id}:${entitlement.agent_id}:${targetDigest}`;
}

function versionAdvanceIdempotencyKey(entitlementId: string, fromDigest: string, toDigest: string): string {
  return `runtime:entitlement-version:${entitlementId}:${fromDigest}:${toDigest}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
