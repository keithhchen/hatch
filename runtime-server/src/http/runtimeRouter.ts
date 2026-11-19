import type http from "node:http";
import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import type { RuntimeAssetStore } from "../assetStore.js";
import { listCreatorAgents } from "../chat/creatorAgentCatalog.js";
import { errorMessage } from "../chat/modelTurn.js";
import {
  legacyAuthClaims,
  resolveAuthIdentity,
  type LegacyHmacAuth
} from "../chat/sessionBinding.js";
import type { ChatEdge } from "../chat/turnSubmission.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import type { ConversationRepository } from "../conversationRepository.js";
import type { GuestCarryOver } from "../chat/library.js";
import type { GuestTokens } from "../guestToken.js";
import { handleGuestRequest } from "./guestRoutes.js";
import { handleAudienceRequest, handleProductAgentRequest } from "./productRoutes.js";
import { AuthorizationError, type AuthIdentity, type AuthIdentityResolver, type EntitlementResolver } from "../entitlements.js";
import type { RuntimeStore } from "../store.js";
import { ResponsesHttpApi } from "../responses/router.js";
import type { ArtifactMode } from "../artifact/mode.js";
import { handleProductArtifactRequest } from "../artifact/routes.js";
import { handleFileRoute, type BuyerFiles } from "../agentBox/files.js";
import { handleReportAssetRoute } from "../agentBox/reportAssets.js";
import { handleHatchPayRoute, type HatchPay } from "../hatchPay/routes.js";
import { handleHtmlRoute, type HtmlPages } from "../agentBox/htmlPages.js";
import { handleConversationHttpRequest } from "./conversationRoutes.js";
import {
  bearerToken,
  setCorsHeaders,
  writeConversationHttpError,
  writeHttpAuthorizationFailure,
  writeJson,
  writeJsonBounded
} from "./httpSupport.js";

export type ReadinessCheck = "starting" | "ready" | "failed";
export type RuntimeReadiness = {
  /** Set once shutdown begins, so the proxy sends nothing new. */
  draining?: boolean;
  repository: ReadinessCheck;
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
  /** The Responses API (`/responses/v1`), an OpenAI-shaped adapter over the same chat domain. */
  responses?: ResponsesHttpApi;
  readiness?: RuntimeReadiness;
  allowedOrigins: readonly string[];
  /** Report mode: products that offer it, and conversations that are reports. */
  artifact?: ArtifactMode;
  /** Guests: how a visitor's signed id is verified, and what happens to their conversations when they sign in. */
  guests?: GuestTokens;
  carryOver?: Pick<GuestCarryOver, "carry">;
  /** Pages the Agent published (/html/<id>), opened by their signed link. */
  htmlPages?: HtmlPages;
  /** WeChat Pay pages that sell access codes (/hatch-pay/); 503 while not configured. */
  hatchPay?: HatchPay;
  /** Files the Agent saved (/file/<id>), downloaded by their signed link. */
  buyerFiles?: BuyerFiles;
};

export async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: RuntimeHttpDeps,
  signal?: AbortSignal
): Promise<void> {
  const {
    entitlementResolver, agentCorpusResolver, conversationStore, assetStore, authIdentityResolver,
    legacyHmacAuth, maxHttpResponseBytes, conversationRepository, repositoryReady, edge, readiness, allowedOrigins, responses, artifact
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
  if (url.pathname.startsWith("/html/") && await handleHtmlRoute(req, res, url, deps.htmlPages)) return;
  if (url.pathname === "/hatch-pay" || url.pathname.startsWith("/hatch-pay/")) return handleHatchPayRoute(req, res, url, deps.hatchPay);
  if (url.pathname.startsWith("/report-assets/") && await handleReportAssetRoute(req, res, url)) return;
  if (url.pathname.startsWith("/file/") && await handleFileRoute(req, res, url, deps.buyerFiles)) return;
  if (req.method === "GET" && url.pathname === "/readyz") {
    const repository = readiness?.repository ?? "failed";
    const ready = !readiness?.draining && repository === "ready";
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      checks: {
        conversation_repository: repository
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
      writeJson(res, 503, { error: { code: error instanceof AuthorizationError ? error.code : "authentication_unavailable", message: errorMessage(error) } });
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

  if (ResponsesHttpApi.handles(url)) {
    if (!responses) {
      writeJson(res, 503, { error: { message: "The Responses API is unavailable.", type: "service_unavailable", param: null, code: "service_unavailable" } });
      return;
    }
    await responses.handle(req, res, url, signal);
    return;
  }

  if (url.pathname.startsWith("/v1/guest/")) {
    try {
      if (!await handleGuestRequest(req, res, url, { guests: deps.guests, carryOver: deps.carryOver, authIdentityResolver, allowedOrigins, maxHttpResponseBytes })) throw new ConversationHttpError(404, "not_found", "Route was not found.");
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
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        edge,
        maxHttpResponseBytes,
        allowedOrigins,
        artifact
      }, signal);
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  if (conversationRepository && (url.pathname === "/v1/creator/audience" || /^\/v1\/products\/[^/]+\/agent$/.test(url.pathname))) {
    try {
      await repositoryReady;
      const productDeps = { repository: conversationRepository, agentCorpusResolver, authIdentityResolver, legacyHmacAuth, maxHttpResponseBytes };
      if (await handleAudienceRequest(req, res, url, productDeps, signal) || await handleProductAgentRequest(req, res, url, productDeps, signal)) return;
    } catch (error) {
      writeConversationHttpError(req, res, error);
      return;
    }
  }

  if (url.pathname.startsWith("/v1/products/") && artifact && conversationRepository) {
    try {
      await repositoryReady;
      if (await handleProductArtifactRequest(req, res, url, {
        artifact, repository: conversationRepository, agentCorpusResolver, authIdentityResolver,
        legacyHmacAuth, maxHttpResponseBytes, allowedOrigins
      })) return;
    } catch (error) {
      writeConversationHttpError(req, res, error);
      return;
    }
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}
