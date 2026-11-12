import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { errorMessage } from "../chat/modelTurn.js";
import {
  conversationBinding,
  durableConversationId,
  legacyAuthClaims,
  resolveAuthIdentity,
  resolveSessionBinding,
  runtimeNotConfiguredError,
  unconfiguredEntitlementResolver,
  type LegacyHmacAuth,
  type SessionBinding
} from "../chat/sessionBinding.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import {
  assertConversationBinding,
  ConversationRepositoryError,
  type ConversationRepository
} from "../conversationRepository.js";
import { EntitlementError, type AuthIdentityResolver, type EntitlementResolver } from "../entitlements.js";
import { toProblem } from "../errors/problem.js";
import { bearerToken } from "./httpSupport.js";

export async function bindingFromHistoryRequest(
  req: http.IncomingMessage,
  url: URL,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal
): Promise<SessionBinding | undefined> {
  const entitlementId = url.searchParams.get("entitlement_id") ?? undefined;
  const authToken = bearerToken(req);
  const authIdentity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  // Owner REST requests use the same owned-Product authorization as client.hello.
  const selectedProduct = url.searchParams.get("product_id");
  const productMode = Boolean(entitlementResolver || agentCorpusResolver);
  if (entitlementResolver === unconfiguredEntitlementResolver) throw runtimeNotConfiguredError();
  if (productMode && selectedProduct && !entitlementId) {
    return resolveSessionBinding({
      auth_token: authToken,
      product_id: selectedProduct
    }, entitlementResolver, agentCorpusResolver, authIdentityResolver,
    authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth), signal);
  }
  if (productMode) {
    if (!entitlementResolver || !agentCorpusResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Expert Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!entitlementId || !authToken) {
      throw new EntitlementError("entitlement_required", "A Bearer token and Expert Agent entitlement are required.");
    }
    if (authIdentityResolver && !authIdentity) {
      throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
    }
    // HTTP and WebSocket use the same account/access/Product binding. A
    // purchase record authorizes access; it does not select Agent instructions.
    return resolveSessionBinding({
      auth_token: authToken,
      entitlement_id: entitlementId
    }, entitlementResolver, agentCorpusResolver, authIdentityResolver,
    authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth), signal);
  }

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
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal
): Promise<SessionBinding> {
  try {
    const binding = await bindingFromHistoryRequest(
      req,
      url,
      entitlementResolver,
      agentCorpusResolver,
      authIdentityResolver,
      legacyHmacAuth,
      signal
    );
    if (!binding) throw new ConversationHttpError(400, "binding_required", "A signed-in Expert Agent binding is required.");
    return binding;
  } catch (error) {
    if (error instanceof ConversationHttpError) throw error;
    // A Registry outage is a 503, not a refusal of access.
    if (error instanceof EntitlementError && toProblem(error).status === 503) throw error;
    throw new ConversationHttpError(403, "entitlement_required", errorMessage(error));
  }
}

export async function requireBoundConversation(
  repository: ConversationRepository,
  binding: SessionBinding,
  publicId: string
) {
  if (!publicId) throw new ConversationHttpError(400, "conversation_id_required", "A conversation ID is required.");
  const conversation = await repository.getConversation(durableConversationId(binding, publicId));
  if (!conversation) throw new ConversationHttpError(404, "conversation_not_found", `Conversation ${publicId} was not found.`);
  try {
    assertConversationBinding(conversation, conversationBinding(binding));
  } catch (error) {
    if (error instanceof ConversationRepositoryError) {
      throw new ConversationHttpError(403, error.code, error.message);
    }
    throw error;
  }
  return conversation;
}
