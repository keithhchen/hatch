import { createHash } from "node:crypto";
import type { AgentCorpus, AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { verifyHatchAuthToken } from "../authToken.js";
import type { BriefSpec } from "../brief.js";
import type { ConversationBinding } from "../conversationRepository.js";
import type { RuntimeCreatorTool } from "../creatorTools.js";
import {
  EntitlementError,
  type AuthIdentity,
  type AuthIdentityResolver,
  type EntitlementResolver,
  type EntitlementVersionHistory
} from "../entitlements.js";
import { bindContext } from "../observability/context.js";
import type { OutboundMessage } from "../protocol.js";
import type { RuntimeStore } from "../store.js";
import { errorMessage } from "./modelTurn.js";
import type { EventProjection } from "./sinks.js";

export type SessionBinding = {
  creatorId: string;
  userId: string;
  productId: string;
  corpusDigest: string;
  runtimeDigest?: string;
  purchasedCorpusDigest?: string;
  /** Free purchases are permanent access; metered accounting is opt-in. */
  accessMode?: "unmetered" | "metered";
  versionPolicy?: "pinned" | "track_current_compatible";
  versionHistory?: EntitlementVersionHistory[];
  briefSpec?: BriefSpec;
  agentCorpus?: AgentCorpus;
  agentCorpusRoot?: string;
  /** Creator tools resolved when the message was authorized; a Run taken over by another instance resolves them again. */
  creatorTools?: RuntimeCreatorTool[];
  entitlementId?: string;
  orderId?: string;
  explicit: boolean;
};

export type SessionBindingRequest = {
  auth_token?: string;
  license_token?: string;
  entitlement_id?: string;
  creator_id?: string;
  user_id?: string;
  product_id?: string;
};

export type LegacyHmacAuth = {
  enabled: boolean;
  signingSecret?: string;
};

export const runtimeNotConfiguredError = () => new EntitlementError(
  "runtime_not_configured",
  "This Runtime has no entitlement or Agent Corpus resolver; set HATCH_ALLOW_INSECURE_LOCAL_MODE=true only for local development."
);

const runtimeNotConfigured = () => Promise.reject(runtimeNotConfiguredError());

export const unconfiguredEntitlementResolver: EntitlementResolver = { list: runtimeNotConfigured, resolve: runtimeNotConfigured };

export const unconfiguredAgentCorpusResolver: AgentCorpusResolver = {
  resolve: runtimeNotConfigured, resolveByProduct: runtimeNotConfigured, list: runtimeNotConfigured
};

export function conversationBinding(binding: SessionBinding): ConversationBinding {
  if (!binding.explicit) {
    // Reachable only with explicit insecureLocalMode (otherwise resolvers always exist). It preserves
    // the historic raw conversation-id behavior across local installations;
    // production bindings always use the server-verified values below.
    return {
      ownerAccountId: "local-development",
      creatorId: "local-development",
      // The repository adapter still has a legacy agent_id field in local
      // mode; it is not part of the Product session identity.
      agentId: "local-agent",
      productId: "local-product",
      corpusDigest: binding.corpusDigest
    };
  }
  return {
    // Product mode always keeps the verified account as the owner.
    ownerAccountId: binding.userId,
    creatorId: binding.creatorId,
    agentId: binding.productId,
    productId: binding.productId,
    corpusDigest: binding.corpusDigest
  };
}

export async function resolveSessionBinding(
  hello: SessionBindingRequest,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  authClaims?: AuthIdentity,
  signal?: AbortSignal
): Promise<SessionBinding> {
  const authToken = hello.auth_token ?? hello.license_token;
  if (authIdentityResolver && !authClaims) {
    throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
  }
  // Owner path: product_id without entitlement_id. The owner is the live
  // release's creator_id as reported by the server; hello.creator_id is never
  // trusted. Everyone else must use the entitlement path below.
  if (hello.product_id && !hello.entitlement_id) {
    if (!agentCorpusResolver) {
      throw new EntitlementError(
        "agent_corpus_unavailable",
        "The requested Expert Agent is not available on this Runtime."
      );
    }
    if (!authClaims) {
      throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
    }
    const resolved = await agentCorpusResolver.resolveByProduct(hello.product_id, signal);
    if (resolved.corpus.product.id !== hello.product_id || resolved.corpus.creator.id !== authClaims.sub) {
      throw new EntitlementError("entitlement_required", "A valid Expert Agent entitlement is required.");
    }
    return {
      creatorId: authClaims.sub,
      userId: authClaims.sub,
      productId: resolved.corpus.product.id,
      corpusDigest: resolved.digest,
      ...(resolved.runtimeDigest ? { runtimeDigest: resolved.runtimeDigest } : {}),
      ...(resolved.corpus.product.brief_spec
        ? { briefSpec: resolved.corpus.product.brief_spec as BriefSpec }
        : {}),
      agentCorpus: resolved.corpus,
      agentCorpusRoot: resolved.root,
      explicit: true
    };
  }
  const productMode = Boolean(entitlementResolver || agentCorpusResolver);
  if (entitlementResolver === unconfiguredEntitlementResolver) throw runtimeNotConfiguredError();
  if (productMode) {
    if (!entitlementResolver || !agentCorpusResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Expert Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!hello.entitlement_id) {
      throw new EntitlementError("entitlement_required", "A valid Expert Agent entitlement is required.");
    }
    const entitlement = await entitlementResolver.resolve({
      authToken,
      licenseToken: authToken,
      entitlementId: hello.entitlement_id,
      signal
    });
    assertEntitlementMatchesIdentity(authClaims, entitlement);
    const resolved = await agentCorpusResolver.resolve(entitlement.creator_id, entitlement.product_id, signal);
    if (resolved.corpus.product.id !== entitlement.product_id || resolved.corpus.creator.id !== entitlement.creator_id) {
      throw new Error("Entitlement does not match its current Agent Corpus");
    }
    const briefSpec = resolved.corpus.product.brief_spec;
    return {
      creatorId: entitlement.creator_id,
      userId: entitlement.user_id,
      productId: entitlement.product_id,
      corpusDigest: resolved.digest,
      ...(resolved.runtimeDigest ? { runtimeDigest: resolved.runtimeDigest } : {}),
      ...(briefSpec ? { briefSpec: briefSpec as BriefSpec } : {}),
      ...(entitlement.purchased_corpus_digest
        ? {
            purchasedCorpusDigest: entitlement.purchased_corpus_digest,
            versionPolicy: entitlement.version_policy ?? "pinned",
            versionHistory: entitlement.version_history ?? []
          }
        : {}),
      accessMode: entitlement.access_mode ?? "unmetered",
      entitlementId: entitlement.entitlement_id,
      orderId: entitlement.order_id,
      agentCorpus: resolved.corpus,
      agentCorpusRoot: resolved.root,
      explicit: true
    };
  }

  // Resolver-free mode is intentionally limited to local development and tests.
  // In product mode all scope is derived from a server-verified entitlement above.
  const creatorId = hello.creator_id ?? `local-${shortHash(authToken ?? "local-creator")}`;
  const userId = authClaims?.sub ?? hello.user_id ?? `local-${shortHash(authToken ?? "local-user")}`;
  const productId = hello.product_id ?? "local-product";
  return {
    creatorId,
    userId,
    productId,
    corpusDigest: `sha256:${"0".repeat(64)}`,
    explicit: Boolean(hello.creator_id || hello.user_id || hello.product_id)
  };
}

export async function resolveHelloAuthClaims(
  hello: Pick<SessionBindingRequest, "auth_token" | "license_token">,
  authIdentityResolver: AuthIdentityResolver | undefined,
  legacyHmacAuth: LegacyHmacAuth,
  signal?: AbortSignal
): Promise<AuthIdentity | undefined> {
  const authToken = hello.auth_token ?? hello.license_token;
  const authIdentity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  const authClaims = authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth);
  if (authIdentityResolver && !authIdentity) {
    throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
  }
  return authClaims;
}

export async function resolveAuthIdentity(
  authToken: string | undefined,
  authIdentityResolver?: AuthIdentityResolver,
  signal?: AbortSignal
): Promise<AuthIdentity | undefined> {
  if (!authIdentityResolver) return undefined;
  const identity = await authIdentityResolver.resolveIdentity(authToken, { signal });
  if (identity) bindContext({ account_id: identity.sub });
  return identity;
}

export function legacyAuthClaims(
  authToken: string | undefined,
  authIdentityResolver: AuthIdentityResolver | undefined,
  legacyHmacAuth: LegacyHmacAuth
): AuthIdentity | undefined {
  // HMAC verification is retained only for local fixture/migration mode. A
  // Runtime configured with the Registry verifier never reaches this branch.
  if (authIdentityResolver || !legacyHmacAuth.enabled) return undefined;
  return verifyHatchAuthToken(authToken, legacyHmacAuth.signingSecret);
}

export function assertEntitlementMatchesIdentity(
  identity: AuthIdentity | undefined,
  entitlement: { user_id: string }
): void {
  if (identity && entitlement.user_id !== identity.sub) {
    throw new EntitlementError("agent_entitlement_mismatch", "This Expert Agent is not available for the signed-in account.");
  }
}

/**
 * A successful hello authorizes a connection, not all future turns. Opaque
 * Registry sessions and access grants are revocable, so production-backed
 * sessions must cross both boundaries again before any run state is created.
 */
export async function revalidateTurnAuthorization(
  hello: Pick<SessionBindingRequest, "auth_token" | "license_token">,
  binding: SessionBinding,
  entitlementResolver?: EntitlementResolver,
  authIdentityResolver?: AuthIdentityResolver,
  signal?: AbortSignal
): Promise<void> {
  const authToken = hello.auth_token ?? hello.license_token;
  const identity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  if (authIdentityResolver && (!identity || identity.sub !== binding.userId)) {
    throw new EntitlementError("authentication_required", "The Hatch session binding is no longer valid.");
  }

  if (!binding.entitlementId) {
    // An owner operates their own Agent without an entitlement, but their
    // opaque session is still re-introspected on every turn.
    if (authIdentityResolver
      && binding.agentCorpus
      && identity?.sub !== binding.creatorId) {
      throw new EntitlementError("authentication_required", "The Hatch session binding is no longer valid.");
    }
  } else {
    if ((authIdentityResolver && !identity) || !entitlementResolver) {
      throw new EntitlementError("entitlement_required", "The Expert Agent access binding is no longer valid.");
    }
    const entitlement = await entitlementResolver.resolve({
      authToken,
      licenseToken: authToken,
      entitlementId: binding.entitlementId,
      signal
    });
    assertEntitlementMatchesIdentity(identity, entitlement);
    if (entitlement.entitlement_id !== binding.entitlementId
      || entitlement.user_id !== binding.userId
      || entitlement.creator_id !== binding.creatorId
      || entitlement.product_id !== binding.productId) {
      throw new EntitlementError("entitlement_required", "The Expert Agent access binding is no longer valid.");
    }
  }

}

export async function resolveTurnAgentBinding(
  binding: SessionBinding,
  agentCorpusResolver: AgentCorpusResolver | undefined,
  signal?: AbortSignal
): Promise<SessionBinding> {
  if (!agentCorpusResolver) {
    throw new EntitlementError("agent_corpus_unavailable", "The current Expert Agent is unavailable.");
  }
  const current = await agentCorpusResolver.resolve(binding.creatorId, binding.productId, signal);
  if (current.corpus.creator.id !== binding.creatorId
    || current.corpus.agent_id !== binding.productId
    || current.corpus.product.id !== binding.productId) {
    throw new EntitlementError("agent_entitlement_mismatch", "The current Expert Agent does not match this session.");
  }
  return {
    ...binding,
    corpusDigest: current.digest,
    runtimeDigest: current.runtimeDigest,
    briefSpec: current.corpus.product.brief_spec as BriefSpec | undefined,
    agentCorpus: current.corpus,
    agentCorpusRoot: current.root
  };
}

export function controlledTurnAuthorizationError(error: unknown): { code: string; message: string } {
  const code = error instanceof EntitlementError ? error.code : "authorization_unavailable";
  if (code === "authentication_required" || code === "auth_invalid") {
    return {
      code: "authentication_required",
      message: "Your Hatch session is no longer valid. Sign in again."
    };
  }
  if (code === "entitlement_required"
    || code === "entitlement_not_found"
    || code === "agent_entitlement_mismatch") {
    return {
      code: "entitlement_required",
      message: "Access to this Expert Agent is no longer available. Refresh your Expert Agents and choose an available Agent."
    };
  }
  return {
    code: "authorization_unavailable",
    message: errorMessage(error)
  };
}

/**
 * P2 durable Conversation identity. It intentionally excludes corpusDigest: corpus revision is recorded on
 * each Run, while a Conversation remains bound to the same Account and Creator
 * Agent across Agent Corpus updates.
 */
export function durableConversationId(
  binding: Pick<SessionBinding, "creatorId" | "userId" | "productId">,
  conversationId: string
): string {
  return `conversation:${shortHash([binding.creatorId, binding.userId, binding.productId, binding.productId].join("\u0000"))}:${conversationId}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/**
 * The one projection standing before every transport's sink (WebSocket, SSE): what a buyer sees of an
 * event never reveals the Expert's private corpus. The binding is read per event, as it can change.
 */
export function privateBoundaryProjection(current: () => { agentCorpusRoot?: string; productId?: string } | undefined): EventProjection {
  return (event) => {
    const binding = current();
    return protectPrivateAgentBoundary(event as unknown as OutboundMessage, binding?.agentCorpusRoot, binding?.productId) as unknown as Record<string, unknown>;
  };
}

const protectedSkillPath = (agentId: string, name: string): string =>
  `agent://${encodeURIComponent(agentId)}/protected-skill/${encodeURIComponent(name)}`;

const redactedTrigger = <T extends { path?: string }>(trigger: T): T => ({ ...trigger, path: trigger.path ? "agent://private" : undefined });

const redactedToolOutput = (result: unknown) => ({ arguments: {}, result: result !== undefined ? { private_result_redacted: true } : undefined });

export function protectPrivateAgentBoundary(
  message: OutboundMessage,
  agentCorpusRoot?: string,
  agentId = "creator-agent"
): OutboundMessage {
  if (!agentCorpusRoot) return message;
  if (message.type === "skill.activated" || message.type === "skill.invoked") {
    return {
      ...message,
      path: protectedSkillPath(agentId, message.name),
      ...(message.type === "skill.activated" ? { resource_paths: [], resource_manifest_truncated: false } : {}),
      ...(message.type === "skill.invoked" ? { trigger: redactedTrigger(message.trigger) } : {})
    } as OutboundMessage;
  }
  if (message.type === "tool_call.delta" && message.locality === "server") {
    const serializedArguments = JSON.stringify(message.arguments ?? {});
    if (serializedArguments.includes(agentCorpusRoot)) return { ...message, ...redactedToolOutput(message.result) };
  }
  return message;
}

export function sanitizeBoundHistory<T extends Awaited<ReturnType<RuntimeStore["readVisibleConversation"]>>[number]>(messages: T[], productId: string): T[] {
  return messages.map((message) => ({
    ...message,
    ...(message.skill_events ? {
      skill_events: message.skill_events.map((event) => ({
        ...event,
        path: protectedSkillPath(productId, event.name),
        resource_paths: event.resource_paths ? [] : undefined,
        resource_manifest_truncated: event.resource_manifest_truncated === undefined ? undefined : false,
        trigger: event.trigger ? redactedTrigger(event.trigger) : undefined
      }))
    } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((tool) => tool.locality === "server" && /^file[._]/.test(tool.name)
        ? { ...tool, ...redactedToolOutput(tool.result) }
        : tool)
    } : {})
  }));
}
