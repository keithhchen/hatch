import { readFile } from "node:fs/promises";
import { z } from "zod";
import { verifyHatchAuthToken } from "./authToken.js";

export type AuthIdentity = {
  sub: string;
  role: "user" | "creator";
  exp?: number;
};

/**
 * Runtime-side identity verification. Production implementations ask the
 * Registry; they do not duplicate the Registry's session-token format.
 */
export interface AuthIdentityResolver {
  resolveIdentity(authToken?: string): Promise<AuthIdentity | undefined>;
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
}).strict();

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
};

const StoredEntitlementSchema = AgentCorpusEntitlementBindingSchema.extend({ license_token: z.string().min(1) }).strict();

export type EntitlementLookup = {
  /** Signed Registry account token. */
  authToken?: string;
  /** Development-only opaque token used by local fixtures. */
  licenseToken?: string;
  entitlementId?: string;
  installationId?: string;
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
  constructor(private readonly filePath: string) {}

  async list(input: EntitlementLookup): Promise<EntitlementBinding[]> {
    const registry = await this.readRegistry();
    const claims = verifyHatchAuthToken(input.authToken);
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

/** Production adapter: access grants are owned by the Registry, not a local file. */
export class RegistryEntitlementResolver implements EntitlementResolver, AuthIdentityResolver {
  constructor(
    private readonly registryUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async list(input: EntitlementLookup): Promise<EntitlementBinding[]> {
    if (!input.authToken) return [];
    const response = await this.fetchImpl(new URL("/v1/user/agent-access", this.registryUrl).toString(), {
      headers: { authorization: `Bearer ${input.authToken}`, accept: "application/json" },
    });
    if (response.status === 401) throw new EntitlementError("auth_invalid", "Your Hatch session is no longer valid.");
    if (!response.ok) throw new EntitlementError("entitlement_registry_unavailable", "Creator Agent access is temporarily unavailable.");
    const payload = await response.json();
    // Registry grants carry bookkeeping fields (for example `granted_at`) that
    // are not part of the runtime entitlement binding. Parse the contract
    // fields we need and strip the rest rather than rejecting a valid grant.
    return z.array(
      EntitlementCommonSchema.extend({ agent_id: z.string().min(1) }).strip()
    ).parse(payload);
  }

  async resolve(input: EntitlementLookup & { entitlementId: string }): Promise<EntitlementBinding> {
    const binding = (await this.list(input)).find((entry) => entry.entitlement_id === input.entitlementId);
    if (!binding) throw new EntitlementError("entitlement_not_found", "This Creator Agent is not available for the signed-in account.");
    return binding;
  }

  async resolveIdentity(authToken?: string): Promise<AuthIdentity | undefined> {
    if (!authToken) return undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(new URL("/v1/auth/me", this.registryUrl).toString(), {
        headers: { authorization: `Bearer ${authToken}`, accept: "application/json" },
      });
    } catch {
      throw new EntitlementError("auth_registry_unavailable", "Hatch account verification is temporarily unavailable.");
    }
    if (response.status === 401) return undefined;
    if (!response.ok) throw new EntitlementError("auth_registry_unavailable", "Hatch account verification is temporarily unavailable.");
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof payload.id !== "string" || !payload.id || (payload.role !== "user" && payload.role !== "creator")) {
      throw new EntitlementError("auth_registry_invalid", "The Registry returned an invalid account identity.");
    }
    const expiresAt = typeof payload.session_expires_at === "string" ? Date.parse(payload.session_expires_at) : Number.NaN;
    return {
      sub: payload.id,
      role: payload.role,
      ...(Number.isFinite(expiresAt) ? { exp: Math.floor(expiresAt / 1000) } : {})
    };
  }
}

export class EntitlementError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EntitlementError";
  }
}
