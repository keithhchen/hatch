import { readFile } from "node:fs/promises";
import { z } from "zod";
import { verifyHatchAuthToken } from "./authToken.js";
import { UUID_V4_RE, isUuidV4 } from "./identity.js";

export type AuthIdentity = {
  sub: string;
  role: "user" | "creator";
  exp?: number;
};

export type AuthorizationRequestOptions = { signal?: AbortSignal };

/**
 * Runtime-side identity verification. Production implementations ask the
 * Registry; they do not duplicate the Registry's session-token format.
 */
export interface AuthIdentityResolver {
  resolveIdentity(authToken?: string, options?: AuthorizationRequestOptions): Promise<AuthIdentity | undefined>;
}

const EntitlementCommonSchema = z.object({
  entitlement_id: z.string().min(1),
  order_id: z.string().min(1).optional(),
  user_id: z.string().min(1),
  creator_id: z.string().min(1),
  product_id: z.string().min(1),
  status: z.literal("active")
}).strict();

const AgentCorpusEntitlementBindingSchema = EntitlementCommonSchema.extend({
  creator_id: z.string().min(1),
  agent_id: z.string().min(1),
  purchased_corpus_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  effective_corpus_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  version_policy: z.enum(["pinned", "track_current_compatible"]).optional(),
  version_history: z.array(z.object({
    from_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    to_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    from_release_id: z.string().nullable().optional(),
    to_release_id: z.string().nullable().optional(),
    compatibility_declaration_id: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    actor_id: z.string().nullable().optional(),
    advanced_at: z.string().optional()
  }).strip()).optional(),
}).strict();

// UUID bindings are strict at every authority boundary. Registry verifies the
// account identity; the Access service owns production entitlements.
const CanonicalRegistryEntitlementBindingBaseSchema = AgentCorpusEntitlementBindingSchema.extend({
  entitlement_id: z.string().regex(UUID_V4_RE),
  order_id: z.string().regex(UUID_V4_RE).optional(),
  user_id: z.string().regex(UUID_V4_RE),
  creator_id: z.string().regex(UUID_V4_RE),
  agent_id: z.string().regex(UUID_V4_RE),
  product_id: z.string().regex(UUID_V4_RE)
}).strict();

const matchingProductBinding = (binding: { agent_id: string; product_id: string }, context: z.RefinementCtx) => {
  if (binding.agent_id !== binding.product_id) {
    context.addIssue({ code: "custom", path: ["product_id"], message: "agent_id must equal product_id after the UUID cutover" });
  }
};

const CanonicalRegistryEntitlementBindingSchema = CanonicalRegistryEntitlementBindingBaseSchema
  .superRefine(matchingProductBinding);

export const EntitlementBindingSchema = AgentCorpusEntitlementBindingSchema;

// Keep the application-facing type intentionally flat: callers can inspect
// the optional binding selector without carrying the Zod union through every
// commerce adapter. The schema above remains the runtime authority.
export type EntitlementBinding = {
  entitlement_id: string;
  order_id?: string;
  user_id: string;
  creator_id: string;
  product_id: string;
  status: "active";
  agent_id: string;
  /** Immutable purchase snapshot. Required for Commerce-backed grants. */
  purchased_corpus_digest?: string;
  effective_corpus_digest?: string;
  version_policy?: "pinned" | "track_current_compatible";
  version_history?: EntitlementVersionHistory[];
};

export type EntitlementVersionHistory = {
  from_digest: string;
  to_digest: string;
  from_release_id?: string | null;
  to_release_id?: string | null;
  compatibility_declaration_id?: string | null;
  reason?: string | null;
  actor_id?: string | null;
  advanced_at?: string;
};

const StoredEntitlementSchema = AgentCorpusEntitlementBindingSchema.extend({ license_token: z.string().min(1) }).strict();

export type EntitlementLookup = {
  /** Signed Registry account token. */
  authToken?: string;
  /** Development-only opaque token used by local fixtures. */
  licenseToken?: string;
  entitlementId?: string;
  signal?: AbortSignal;
};

export interface EntitlementResolver {
  list(input: EntitlementLookup): Promise<EntitlementBinding[]>;
  resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding>;
}

/**
 * Development adapter for an exported commerce entitlement projection.
 * The file is server-side and maps opaque license tokens to active bindings;
 * neither the Desktop nor an Agent Corpus can choose a broader scope.
 */
export class FileEntitlementResolver implements EntitlementResolver {
  private readonly hmacSecret?: string;

  constructor(
    private readonly filePath: string,
    options: { enableLegacyHmacAuth: true; hmacSecret: string }
  ) {
    if (options.enableLegacyHmacAuth !== true) {
      throw new Error("File entitlement fixtures require explicit legacy HMAC auth opt-in");
    }
    this.hmacSecret = options.hmacSecret.trim() || undefined;
    if (!this.hmacSecret) {
      throw new Error("File entitlement fixtures require an explicit legacy HMAC signing secret");
    }
  }

  async list(input: EntitlementLookup): Promise<EntitlementBinding[]> {
    const registry = await this.readRegistry();
    const claims = verifyHatchAuthToken(input.authToken, this.hmacSecret);
    if (claims) {
      return registry
        .filter((entry) => claims.role === "user" && entry.user_id === claims.sub)
        .map(({ license_token: _licenseToken, ...binding }) => binding);
    }
    if (!input.licenseToken) return [];
    return registry
      .filter((entry) => entry.license_token === input.licenseToken)
      .map(({ license_token: _licenseToken, ...binding }) => binding);
  }

  async resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding> {
    const binding = (await this.list(input)).find((entry) => entry.entitlement_id === input.entitlementId);
    if (!binding) throw new EntitlementError("entitlement_not_found", "This Creator Agent is not available for the signed-in account.");
    return binding;
  }

  private async readRegistry(): Promise<Array<EntitlementBinding & { license_token: string }>> {
    const payload = JSON.parse(await readFile(this.filePath, "utf8"));
    return z.array(StoredEntitlementSchema).parse(payload);
  }
}

/** Production adapter: Registry verifies identity; Access owns entitlements. */
export class RegistryEntitlementResolver implements EntitlementResolver, AuthIdentityResolver {
  private readonly timeoutMs: number;
  private readonly commerceUrl?: string;
  private readonly commerceServiceToken?: string;

  constructor(
    private readonly registryUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    options: {
      timeoutMs?: number;
      serviceToken?: string;
      commerceUrl?: string;
      commerceServiceToken?: string;
    } = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.serviceToken = options.serviceToken?.trim() || undefined;
    this.commerceUrl = options.commerceUrl?.trim() || undefined;
    this.commerceServiceToken = options.commerceServiceToken?.trim() || undefined;
    if (Boolean(this.commerceUrl) !== Boolean(this.commerceServiceToken)) {
      throw new Error("Commerce access URL and service token must be configured together");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 60_000) {
      throw new Error("Registry authorization timeout must be an integer between 1 and 60000 milliseconds");
    }
  }

  private readonly serviceToken: string | undefined;

  async list(input: EntitlementLookup): Promise<EntitlementBinding[]> {
    if (!input.authToken) return [];
    if (this.commerceUrl && this.commerceServiceToken) {
      const identity = await this.resolveIdentity(input.authToken, { signal: input.signal });
      if (!identity || identity.role !== "user") return [];
      const { response, body } = await this.requestCommerce(
        `/v1/internal/access/users/${encodeURIComponent(identity.sub)}/entitlements`,
        input.signal
      );
      if (!response.ok) throw new EntitlementError("access_service_unavailable", "Creator Agent access is temporarily unavailable.");
      try {
        const payload = JSON.parse(body) as { entitlements?: unknown };
        return parseCommerceEntitlements(payload.entitlements);
      } catch (error) {
        if (error instanceof EntitlementError) throw error;
        throw new EntitlementError("access_service_invalid", "The access service returned invalid entitlement data.");
      }
    }
    const { response, body } = await this.request(
      "/v1/user/product-access",
      { headers: { authorization: `Bearer ${input.authToken}`, accept: "application/json" } },
      input.signal,
      "entitlement"
    );
    if (response.status === 401) throw new EntitlementError("auth_invalid", "Your Hatch session is no longer valid.");
    if (!response.ok) throw new EntitlementError("entitlement_registry_unavailable", "Creator Agent access is temporarily unavailable.");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new EntitlementError("entitlement_registry_unavailable", "Creator Agent access is temporarily unavailable.");
    }
    return parseRegistryEntitlements(payload);
  }

  async resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding> {
    if (!input.authToken) throw new EntitlementError("auth_invalid", "Your Hatch session is no longer valid.");
    if (this.commerceUrl && this.commerceServiceToken) {
      const identity = await this.resolveIdentity(input.authToken, { signal: input.signal });
      if (!identity || identity.role !== "user") {
        throw new EntitlementError("auth_invalid", "Your Hatch session is no longer valid.");
      }
      const { response, body } = await this.requestCommerce(
        `/v1/internal/access/entitlements/${encodeURIComponent(input.entitlementId)}?user_id=${encodeURIComponent(identity.sub)}`,
        input.signal
      );
      if (response.status === 404) {
        throw new EntitlementError("entitlement_not_found", "This Creator Agent is not available for the signed-in account.");
      }
      if (!response.ok) throw new EntitlementError("access_service_unavailable", "Creator Agent access is temporarily unavailable.");
      try {
        const payload = JSON.parse(body) as { entitlement?: unknown };
        const [binding] = parseCommerceEntitlements([payload.entitlement]);
        if (!binding || binding.entitlement_id !== input.entitlementId || binding.user_id !== identity.sub) {
          throw new EntitlementError("entitlement_not_found", "This Creator Agent is not available for the signed-in account.");
        }
        return binding;
      } catch (error) {
        if (error instanceof EntitlementError) throw error;
        throw new EntitlementError("access_service_invalid", "The access service returned invalid entitlement data.");
      }
    }
    const { response, body } = await this.request(
      `/v1/user/product-access?entitlement_id=${encodeURIComponent(input.entitlementId)}`,
      { headers: { authorization: `Bearer ${input.authToken}`, accept: "application/json" } },
      input.signal,
      "entitlement",
    );
    if (response.status === 401) throw new EntitlementError("auth_invalid", "Your Hatch session is no longer valid.");
    if (!response.ok) throw new EntitlementError("entitlement_registry_unavailable", "Creator Agent access is temporarily unavailable.");
    let payload: unknown;
    try { payload = JSON.parse(body); }
    catch { throw new EntitlementError("entitlement_registry_unavailable", "Creator Agent access is temporarily unavailable."); }
    const binding = parseRegistryEntitlements(payload).find((entry) => entry.entitlement_id === input.entitlementId);
    if (!binding) throw new EntitlementError("entitlement_not_found", "This Creator Agent is not available for the signed-in account.");
    return binding;
  }

  async resolveIdentity(authToken?: string, options: AuthorizationRequestOptions = {}): Promise<AuthIdentity | undefined> {
    if (!authToken) return undefined;
    const { response, body } = await this.request(
      "/v1/auth/me",
      { headers: { authorization: `Bearer ${authToken}`, accept: "application/json" } },
      options.signal,
      "identity"
    );
    if (response.status === 401) return undefined;
    if (!response.ok) throw new EntitlementError("auth_registry_unavailable", "Hatch account verification is temporarily unavailable.");
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(body) as unknown;
      payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      payload = {};
    }
    if (typeof payload.id !== "string" || !isUuidV4(payload.id) || (payload.role !== "user" && payload.role !== "creator")) {
      throw new EntitlementError("auth_registry_invalid", "The Registry returned an invalid account identity.");
    }
    const expiresAt = typeof payload.session_expires_at === "string" ? Date.parse(payload.session_expires_at) : Number.NaN;
    return {
      sub: payload.id,
      role: payload.role,
      ...(Number.isFinite(expiresAt) ? { exp: Math.floor(expiresAt / 1000) } : {})
    };
  }

  private async request(
    path: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    boundary: "identity" | "entitlement"
  ): Promise<{ response: Response; body: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Registry authorization request timed out"));
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.registryUrl).toString(), {
        ...init,
        headers: this.requestHeaders(init.headers),
        signal: controller.signal
      });
      const body = await readBoundedResponseBody(response, boundary === "identity" ? 64 * 1024 : 2 * 1024 * 1024);
      if (controller.signal.aborted) throw controller.signal.reason;
      return { response, body };
    } catch {
      if (externalSignal?.aborted && !timedOut) {
        throw new EntitlementError("authorization_cancelled", "Authorization verification was cancelled.");
      }
      if (boundary === "identity") {
        throw new EntitlementError("auth_registry_unavailable", "Hatch account verification is temporarily unavailable.");
      }
      throw new EntitlementError("entitlement_registry_unavailable", "Creator Agent access is temporarily unavailable.");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private requestHeaders(input: HeadersInit | undefined): Headers {
    const headers = new Headers(input);
    if (this.serviceToken) headers.set("x-hatch-runtime-service-token", this.serviceToken);
    return headers;
  }

  private async requestCommerce(path: string, externalSignal?: AbortSignal): Promise<{ response: Response; body: string }> {
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Access authorization request timed out")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.commerceUrl).toString(), {
        headers: {
          authorization: `Bearer ${this.commerceServiceToken}`,
          accept: "application/json"
        },
        signal: controller.signal
      });
      return { response, body: await readBoundedResponseBody(response, 2 * 1024 * 1024) };
    } catch {
      if (externalSignal?.aborted) {
        throw new EntitlementError("authorization_cancelled", "Authorization verification was cancelled.");
      }
      throw new EntitlementError("access_service_unavailable", "Creator Agent access is temporarily unavailable.");
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

function parseRegistryEntitlements(payload: unknown): EntitlementBinding[] {
  // Registry grants carry bookkeeping/presentation fields that are not part of
  // the runtime authority. Parse only the binding contract and strip the rest.
  return z.array(CanonicalRegistryEntitlementBindingSchema.strip()).max(50).parse(payload);
}

function parseCommerceEntitlements(payload: unknown): EntitlementBinding[] {
  return z.array(CanonicalRegistryEntitlementBindingBaseSchema.extend({
    order_id: z.string().regex(UUID_V4_RE),
    purchased_corpus_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    effective_corpus_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/)
  }).strict().superRefine(matchingProductBinding)).max(50).parse(payload);
}

async function readBoundedResponseBody(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const parsed = Number(declared);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
      throw new Error("Registry authorization response is too large");
    }
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("Registry authorization response is too large");
        throw new Error("Registry authorization response is too large");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export function registryAuthorizationTimeoutMs(
  environment: NodeJS.ProcessEnv = process.env
): number {
  const raw = environment.HATCH_REGISTRY_AUTH_TIMEOUT_MS?.trim();
  if (!raw) return 5_000;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 30_000) {
    throw new Error("HATCH_REGISTRY_AUTH_TIMEOUT_MS must be an integer between 100 and 30000");
  }
  return value;
}

export class EntitlementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EntitlementError";
  }
}
