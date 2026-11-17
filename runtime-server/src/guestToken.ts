import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthIdentity, AuthIdentityResolver, AuthorizationRequestOptions } from "./entitlements.js";
import { GUEST_PREFIX } from "./chat/principal.js";

const TOKEN_PREFIX = "hatch_guest.";

/**
 * A guest is a browser that has not signed in. The dashboard issues its id as a signed cookie and presents it here as a bearer token
 * `hatch_guest.<id>.<signature>`; only a holder of the shared secret can make one, so the id is as trustworthy as an account session.
 */
export class GuestTokens {
  private readonly key: Buffer;
  constructor(secret: string) {
    if (!secret.trim()) throw new Error("Guest tokens need a signing secret");
    this.key = createHmac("sha256", secret).update("hatch-guest-token-v1").digest();
  }

  private sign(id: string): string { return createHmac("sha256", this.key).update(id).digest("base64url"); }

  issue(id: string): string { return `${TOKEN_PREFIX}${id}.${this.sign(id)}`; }

  /** The guest's identity, or undefined when the token is not a valid guest token. */
  verify(token: string | undefined): AuthIdentity | undefined {
    if (!token?.startsWith(TOKEN_PREFIX)) return undefined;
    const [id, signature, ...rest] = token.slice(TOKEN_PREFIX.length).split(".");
    if (!id || !signature || rest.length || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return undefined;
    const expected = Buffer.from(this.sign(id));
    const supplied = Buffer.from(signature);
    return expected.length === supplied.length && timingSafeEqual(expected, supplied) ? { sub: `${GUEST_PREFIX}${id}` } : undefined;
  }

  /** The guest id inside a token, when it is valid. */
  idOf(token: string | undefined): string | undefined { return this.verify(token)?.sub.slice(GUEST_PREFIX.length); }
}

/** Identifies guests itself and leaves every other token to the Registry. */
export class GuestAwareIdentityResolver implements AuthIdentityResolver {
  constructor(private readonly guests: GuestTokens, private readonly accounts: AuthIdentityResolver | undefined) {}

  async resolveIdentity(authToken?: string, options?: AuthorizationRequestOptions): Promise<AuthIdentity | undefined> {
    if (authToken?.startsWith(TOKEN_PREFIX)) return this.guests.verify(authToken);
    return this.accounts?.resolveIdentity(authToken, options);
  }
}
