import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { errorMessage } from "../chat/modelTurn.js";
import {
  conversationBinding,
  legacyAuthClaims,
  resolveAuthIdentity,
  resolveSessionBinding,
  type LegacyHmacAuth,
  type SessionBinding
} from "../chat/sessionBinding.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import {
  assertConversationBinding,
  ConversationRepositoryError,
  type ConversationRepository
} from "../conversationRepository.js";
import { AuthorizationError, type AuthIdentityResolver } from "../entitlements.js";
import { toProblem } from "../errors/problem.js";
import { AgentReleaseUnavailableError } from "../runtimeCorpusResolver.js";
import { sessionTokenFromCookie } from "../chat/originPolicy.js";
import { bearerToken } from "./httpSupport.js";

export async function bindingFromHistoryRequest(
  req: http.IncomingMessage,
  url: URL,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal
): Promise<SessionBinding | undefined> {
  const authToken = bearerToken(req);
  const authIdentity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  const selectedProduct = url.searchParams.get("product_id");
  if (agentCorpusResolver && selectedProduct) {
    return resolveSessionBinding({
      auth_token: authToken,
      product_id: selectedProduct
    }, agentCorpusResolver, authIdentityResolver,
    authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth), signal);
  }
  if (agentCorpusResolver) throw new AuthorizationError("product_required", "A product_id is required.");

  // Self-reported scope is accepted only when no product resolver is configured.
  // This keeps resolver-free local development usable without creating a
  // production authorization bypass.
  const value = (name: string): string | undefined => url.searchParams.get(name) ?? (typeof req.headers[`x-hatch-${name.replaceAll("_", "-")}`] === "string" ? String(req.headers[`x-hatch-${name.replaceAll("_", "-")}`]) : undefined);
  const [creatorId, userId, productId, corpusDigestValue] = [value("creator_id"), value("user_id"), value("product_id"), value("corpus_digest")];
  if (!creatorId || !userId || !productId || !corpusDigestValue || !/^sha256:[a-f0-9]{64}$/.test(corpusDigestValue)) return undefined;
  return { creatorId, userId, productId, corpusDigest: corpusDigestValue, explicit: true };
}

export async function requireConversationBinding(
  req: http.IncomingMessage,
  url: URL,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal
): Promise<SessionBinding> {
  try {
    const binding = await bindingFromHistoryRequest(
      req,
      url,
      agentCorpusResolver,
      authIdentityResolver,
      legacyHmacAuth,
      signal
    );
    if (!binding) throw new ConversationHttpError(400, "binding_required", "A product_id is required.");
    return binding;
  } catch (error) {
    if (error instanceof ConversationHttpError) throw error;
    // A Registry outage is a 503, not a refusal of access.
    if (error instanceof AuthorizationError && toProblem(error).status === 503) throw error;
    if (error instanceof AgentReleaseUnavailableError) throw new ConversationHttpError(404, "agent_unavailable", "This Agent is not available.");
    const problem = toProblem(error);
    throw new ConversationHttpError(problem.status === 500 ? 403 : problem.status, problem.status === 500 ? "access_denied" : problem.code, errorMessage(error));
  }
}

export async function requireBoundConversation(
  repository: ConversationRepository,
  binding: SessionBinding,
  publicId: string
) {
  if (!publicId) throw new ConversationHttpError(400, "conversation_id_required", "A conversation ID is required.");
  // By the owner and the id the client knows: a conversation that moved to an account when its visitor signed in keeps its id.
  const owner = conversationBinding(binding);
  const conversation = await repository.findOwnedConversation({ ownerAccountId: owner.ownerAccountId, creatorId: owner.creatorId }, publicId);
  if (!conversation) throw new ConversationHttpError(404, "conversation_not_found", `Conversation ${publicId} was not found.`);
  try {
    assertConversationBinding(conversation, conversationBinding(binding));
  } catch (error) {
    if (error instanceof ConversationRepositoryError) {
      // Another Product's conversation is not in this Product's scope: not found, as before the owner lookup.
      if (error.code === "conversation_binding_mismatch") throw new ConversationHttpError(404, "conversation_not_found", `Conversation ${publicId} was not found.`);
      throw new ConversationHttpError(403, error.code, error.message);
    }
    throw error;
  }
  return conversation;
}

/** A cookie is sent by the browser on any cross-site request, so changing anything with one needs an allowed Origin. */
export function requireAllowedOrigin(req: http.IncomingMessage, allowedOrigins: readonly string[]): void {
  if (typeof req.headers.authorization !== "string" && sessionTokenFromCookie(req.headers.cookie)
    && !(typeof req.headers.origin === "string" && allowedOrigins.includes(req.headers.origin))) {
    throw new ConversationHttpError(403, "origin_not_allowed", "This origin may not use a browser session.");
  }
}
