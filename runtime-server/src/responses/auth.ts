import { createHash } from "node:crypto";
import type http from "node:http";
import type { AuthIdentity, AuthIdentityResolver, AuthorizationRequestOptions } from "../entitlements.js";
import { ApiError, invalidApiKey } from "./errors.js";

/** A successful verification is trusted this long: a revoked key stops working within it. */
export const IDENTITY_CACHE_MS = 30_000;
const MAX_CACHED = 10_000;

/**
 * Decorates a resolver so a verification that succeeded is remembered for `ttlMs` (never past the session's own expiry).
 * Only successes are cached: a rejected or failed verification asks the Registry again.
 */
export function cachingIdentityResolver(inner: AuthIdentityResolver, ttlMs = IDENTITY_CACHE_MS, now: () => number = Date.now): AuthIdentityResolver {
  const cache = new Map<string, { identity: AuthIdentity; until: number }>();
  return {
    async resolveIdentity(authToken?: string, options?: AuthorizationRequestOptions): Promise<AuthIdentity | undefined> {
      if (!authToken) return undefined;
      // The token itself is never kept as a key.
      const key = createHash("sha256").update(authToken).digest("hex");
      const hit = cache.get(key);
      if (hit && hit.until > now()) return hit.identity;
      cache.delete(key);
      const identity = await inner.resolveIdentity(authToken, options);
      if (identity) {
        const sessionEnd = identity.exp === undefined ? Infinity : identity.exp * 1000;
        const until = Math.min(now() + ttlMs, sessionEnd);
        if (until > now()) {
          if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
          cache.set(key, { identity, until });
        }
      }
      return identity;
    }
  };
}

/** Who is calling: the account, and the key or session it presented. */
export type ApiCaller = { accountId: string; token: string; sessionId?: string; clientType?: string };

/** Turns `Authorization: Bearer <Hatch API key>` into a caller. A missing, unknown, revoked or expired key is always 401 invalid_api_key. */
export class ApiAuthenticator {
  constructor(private readonly identities: AuthIdentityResolver | undefined) {}

  async authenticate(req: http.IncomingMessage, signal?: AbortSignal): Promise<ApiCaller> {
    const authorization = req.headers.authorization;
    const token = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() : undefined;
    if (!token) throw invalidApiKey();
    if (!this.identities) throw new ApiError(503, "service_unavailable", "service_unavailable", "This Runtime has no account verification configured.");
    const identity = await this.identities.resolveIdentity(token, { signal });
    if (!identity) throw invalidApiKey();
    return {
      accountId: identity.sub, token,
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      ...(identity.clientType ? { clientType: identity.clientType } : {})
    };
  }
}
