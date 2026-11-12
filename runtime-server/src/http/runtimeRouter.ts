import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import type { RuntimeAssetStore } from "../assetStore.js";
import { listCreatorAgents } from "../chat/creatorAgentCatalog.js";
import { errorMessage } from "../chat/modelTurn.js";
import {
  durableConversationId,
  legacyAuthClaims,
  resolveAuthIdentity,
  sanitizeBoundHistory,
  scopedConversationId,
  type LegacyHmacAuth,
  type SessionBinding
} from "../chat/sessionBinding.js";
import type { ChatEdge } from "../chat/turnSubmission.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import type { ConversationRepository } from "../conversationRepository.js";
import { EntitlementError, type AuthIdentity, type AuthIdentityResolver, type EntitlementResolver } from "../entitlements.js";
import type { RuntimeStore } from "../store.js";
import { handleConversationHttpRequest, serveConversationAsset } from "./conversationRoutes.js";
import {
  bearerToken,
  setCorsHeaders,
  writeConversationHttpError,
  writeHttpAuthorizationFailure,
  writeJson,
  writeJsonBounded
} from "./httpSupport.js";
import { bindingFromHistoryRequest } from "./requestBinding.js";

export type ReadinessCheck = "starting" | "ready" | "failed";
export type RuntimeReadiness = {
  /** Set once shutdown begins, so the proxy sends nothing new. */
  draining?: boolean;
  repository: ReadinessCheck;
  deliveryAccounting: ReadinessCheck | "disabled";
};

/** What the Runtime's HTTP surface needs from the rest of the Runtime; the composition root supplies it. */
export type RuntimeHttpDeps = {
  entitlementResolver?: EntitlementResolver;
  agentCorpusResolver?: AgentCorpusResolver;
  conversationStore: RuntimeStore;
  assetStore?: RuntimeAssetStore;
  authIdentityResolver?: AuthIdentityResolver;
  legacyHmacAuth: LegacyHmacAuth;
  maxHttpResponseBytes: number;
  conversationRepository?: ConversationRepository;
  repositoryReady?: Promise<unknown>;
  edge?: ChatEdge;
  readiness?: RuntimeReadiness;
  allowedOrigins: readonly string[];
};

export async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RuntimeHttpDeps,
  signal?: AbortSignal
): Promise<void> {
  const {
    entitlementResolver, agentCorpusResolver, conversationStore, assetStore, authIdentityResolver,
    legacyHmacAuth, maxHttpResponseBytes, conversationRepository, repositoryReady, edge, readiness, allowedOrigins
  } = deps;
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/healthz") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    const repository = readiness?.repository ?? "failed";
    const deliveryAccounting = readiness?.deliveryAccounting ?? "disabled";
    const ready = !readiness?.draining && repository === "ready"
      && (deliveryAccounting === "ready" || deliveryAccounting === "disabled");
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      checks: {
        conversation_repository: repository,
        delivery_accounting: deliveryAccounting
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/me/creator-agents") {
    const authToken = bearerToken(req);
    if (!authToken) {
      writeJson(res, 401, { error: { code: "authentication_required", message: "Sign in to view purchased Expert Agents." } });
      return;
    }
    let identity: AuthIdentity | undefined;
    try {
      identity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
    } catch (error) {
      writeJson(res, 503, { error: { code: error instanceof EntitlementError ? error.code : "authentication_unavailable", message: errorMessage(error) } });
      return;
    }
    const claims = identity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth);
    if (authIdentityResolver && !identity) {
      writeJson(res, 401, { error: { code: "authentication_required", message: "Your Hatch session is no longer valid." } });
      return;
    }
    if (!claims && !entitlementResolver) {
      writeJson(res, 503, { error: { code: "entitlements_unavailable", message: "Expert Agent purchases are temporarily unavailable." } });
      return;
    }
    try {
      const creatorAgents = await listCreatorAgents({ claims, authToken, entitlementResolver, agentCorpusResolver, signal });
      writeJsonBounded(res, 200, { creator_agents: creatorAgents }, maxHttpResponseBytes);
    } catch (error) {
      writeHttpAuthorizationFailure(res, error, "entitlement_lookup_failed");
    }
    return;
  }

  if (url.pathname.startsWith("/v1/service/chat/")) {
    try {
      await repositoryReady;
      if (!await edge?.serviceApi?.handle(req, res, url)) throw new ConversationHttpError(404, "not_found", "Route was not found.");
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  if (url.pathname === "/v1/conversations" || url.pathname.startsWith("/v1/conversations/")) {
    if (!conversationRepository) {
      writeJson(res, 503, { error: { code: "conversation_repository_unavailable", message: "Conversation storage is unavailable." } });
      return;
    }
    try {
      await repositoryReady;
      await handleConversationHttpRequest(req, res, url, {
        repository: conversationRepository,
        store: conversationStore,
        assetStore,
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        edge,
        maxHttpResponseBytes,
        allowedOrigins
      }, signal);
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  const match = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (req.method === "GET" && match) {
    const conversationId = decodeURIComponent(match[1] ?? "");
    let binding: SessionBinding | undefined;
    try {
      binding = await bindingFromHistoryRequest(
        req,
        url,
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        signal
      );
    } catch (error) {
      writeHttpAuthorizationFailure(res, error, "entitlement_required");
      return;
    }
    if (!binding) {
      writeJson(res, 400, { error: { code: "binding_required", message: "A signed-in entitlement binding is required." } });
      return;
    }
    const store = conversationStore;
    const durableHistoryId = durableConversationId(binding, conversationId);
    const durableMessages = await store.readVisibleConversation(durableHistoryId);
    // Keep old Desktop builds readable during the migration from the
    // corpus-digest-scoped transcript key. New WS runs always write to the
    // durable identity so an Agent Corpus update cannot orphan history.
    const legacyHistoryId = scopedConversationId(binding, conversationId);
    const storageConversationId = durableMessages.length > 0 || durableHistoryId === legacyHistoryId
      ? durableHistoryId
      : legacyHistoryId;
    const messages = durableMessages.length > 0 || durableHistoryId === legacyHistoryId
      ? durableMessages
      : await store.readVisibleConversation(legacyHistoryId);
    const historyTruncated = typeof (store as RuntimeStore & {
      visibleConversationTruncated?: (id: string) => Promise<boolean>;
    }).visibleConversationTruncated === "function"
      ? await (store as RuntimeStore & {
        visibleConversationTruncated: (id: string) => Promise<boolean>;
      }).visibleConversationTruncated(storageConversationId)
      : false;
    writeJsonBounded(res, 200, {
      conversation_id: conversationId,
      product_id: binding.productId,
      creator_id: binding.creatorId,
      messages: sanitizeBoundHistory(
        messages,
        binding.productId
      ),
      history_truncated: historyTruncated
    }, maxHttpResponseBytes);
    return;
  }

  const legacyAssetMatch = url.pathname.match(/^\/conversations\/([^/]+)\/assets\/([^/]+)$/);
  if (req.method === "GET" && legacyAssetMatch) {
    const conversationId = decodeURIComponent(legacyAssetMatch[1] ?? "");
    let binding: SessionBinding | undefined;
    try {
      binding = await bindingFromHistoryRequest(
        req,
        url,
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        signal
      );
    } catch (error) {
      writeHttpAuthorizationFailure(res, error, "entitlement_required");
      return;
    }
    if (!binding) {
      writeJson(res, 400, { error: { code: "binding_required", message: "A signed-in entitlement binding is required." } });
      return;
    }
    const store = conversationStore;
    const durableHistoryId = durableConversationId(binding, conversationId);
    const durableMessages = await store.readVisibleConversation(durableHistoryId);
    const legacyHistoryId = scopedConversationId(binding, conversationId);
    const storageConversationId = durableMessages.length > 0 || durableHistoryId === legacyHistoryId
      ? durableHistoryId
      : legacyHistoryId;
    try {
      await serveConversationAsset(
        res,
        store,
        assetStore,
        storageConversationId,
        decodeURIComponent(legacyAssetMatch[2] ?? "")
      );
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}
