import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { creatorAgentView } from "../chat/creatorAgentCatalog.js";
import { GUEST_PREFIX } from "../chat/principal.js";
import { isUuidV4 } from "../identity.js";
import { resolveAuthIdentity } from "../chat/sessionBinding.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import type { ConversationRepository } from "../conversationRepository.js";
import type { AuthIdentityResolver } from "../entitlements.js";
import type { LegacyHmacAuth } from "../chat/sessionBinding.js";
import { bearerToken, parsePositiveInteger, writeJsonBounded } from "./httpSupport.js";
import { requireConversationBinding } from "./requestBinding.js";

export type ProductRouteDeps = {
  repository: ConversationRepository;
  agentCorpusResolver?: AgentCorpusResolver;
  authIdentityResolver?: AuthIdentityResolver;
  legacyHmacAuth: LegacyHmacAuth;
  maxHttpResponseBytes: number;
};

/** What a chatter sees of a live Agent before and while chatting, for any identified visitor: the same shape as an entry of the Agent list. */
export async function handleProductAgentRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ProductRouteDeps, signal?: AbortSignal): Promise<boolean> {
  const match = url.pathname.match(/^\/v1\/products\/([^/]+)\/agent$/);
  if (!match) return false;
  if (req.method !== "GET") throw new ConversationHttpError(405, "method_not_allowed", "Use GET.");
  const bound = new URL(url);
  bound.searchParams.set("product_id", decodeURIComponent(match[1]!));
  const binding = await requireConversationBinding(req, bound, deps.agentCorpusResolver, deps.authIdentityResolver, deps.legacyHmacAuth, signal);
  const corpus = binding.agentCorpus!;
  writeJsonBounded(res, 200, {
    creator_agent: { creator_id: corpus.creator.id, product_id: corpus.product.id, corpus_digest: binding.corpusDigest, effective_corpus_digest: binding.corpusDigest, ...creatorAgentView(corpus) }
  }, deps.maxHttpResponseBytes);
  return true;
}

/**
 * `GET /v1/creator/audience[?product_id=]`: who opened conversations with the signed-in creator's Agents, as counts. A person who signed in is
 * named by account id (the Dashboard knows the name); a visitor and an IM contact are only counted as such.
 */
/** Only a real account id is an account; guests, IM contacts and event-code owners (`code:`) are not (they show as guests), and the dashboard resolves names for accounts only. */
export function audienceIdentity(ownerId: string): { kind: "guest" | "im" } | { kind: "account"; account_id: string } {
  if (ownerId.startsWith(GUEST_PREFIX)) return { kind: "guest" };
  if (ownerId.startsWith("contact:")) return { kind: "im" };
  return isUuidV4(ownerId) ? { kind: "account", account_id: ownerId } : { kind: "guest" };
}

export async function handleAudienceRequest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: ProductRouteDeps, signal?: AbortSignal): Promise<boolean> {
  if (url.pathname !== "/v1/creator/audience") return false;
  if (req.method !== "GET") throw new ConversationHttpError(405, "method_not_allowed", "Use GET.");
  const identity = await resolveAuthIdentity(bearerToken(req), deps.authIdentityResolver, signal);
  if (!identity || identity.sub.startsWith(GUEST_PREFIX)) throw new ConversationHttpError(401, "authentication_required", "Sign in to see who uses your Agents.");
  const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 500);
  const rows = await deps.repository.listAudience(identity.sub, {
    ...(url.searchParams.get("product_id") ? { productId: url.searchParams.get("product_id")! } : {}),
    ...(limit ? { limit } : {})
  });
  writeJsonBounded(res, 200, {
    audience: rows.map((row) => ({
      product_id: row.productId,
      ...audienceIdentity(row.ownerAccountId),
      conversations: row.conversations, messages: row.messages, first_at: row.firstAt, last_at: row.lastAt
    }))
  }, deps.maxHttpResponseBytes);
  return true;
}
