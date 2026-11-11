import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";

/** A sign-in that cannot proceed. `code` and `status` reach the caller as they are. */
export class LoginError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = "LoginError"; }
}

export type OidcConfig = { issuer: string; authorizeUrl: string; tokenUrl: string; jwksUrl: string; clientId: string; clientSecret: string;
  /** How the client proves itself at the token endpoint: HTTP Basic (default), or `client_secret` in the body. */
  tokenAuth?: "basic" | "post" };

/** PKCE (S256): the verifier stays with us, the challenge goes to the provider. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const SKEW_MS = 60_000;
/** The signatures we accept, and the kind of published key each needs. */
const ALGORITHMS: Record<string, { kty: string; crv?: string }> = { RS256: { kty: "RSA" }, ES256: { kty: "EC", crv: "P-256" } };
const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/** Port to an OpenID Connect provider: Authorization Code with PKCE, and an id_token checked against the provider's published keys. */
export class OidcClient {
  private keys: JsonWebKey[] = [];
  constructor(private config: OidcConfig, private fetchImpl: typeof fetch = fetch) {}

  authorizeUrl(input: { redirectUri: string; scopes: string[]; state: string; nonce: string; challenge: string }): string {
    const url = new URL(this.config.authorizeUrl);
    for (const [key, value] of Object.entries({
      client_id: this.config.clientId, redirect_uri: input.redirectUri, response_type: "code", scope: input.scopes.join(" "),
      state: input.state, nonce: input.nonce, code_challenge: input.challenge, code_challenge_method: "S256",
    })) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Trades the code for the provider's id_token. */
  async exchange(input: { code: string; verifier: string; redirectUri: string }): Promise<string> {
    const { clientId, clientSecret } = this.config;
    const post = this.config.tokenAuth === "post";
    const response = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...(post ? {} : { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` }) },
      body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: clientId, code_verifier: input.verifier, ...(post ? { client_secret: clientSecret } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({})) as { id_token?: string };
    if (!response.ok || !body.id_token) throw new LoginError("login_failed", "The sign-in provider did not accept this sign-in.", 401);
    return body.id_token;
  }

  /** Only RS256 or ES256, only a key the provider publishes under the token's `kid`, and only a token issued to us, now, for this nonce. */
  async verifyIdToken(token: string, nonce: string, now = Date.now()): Promise<Record<string, unknown>> {
    const invalid = () => new LoginError("login_failed", "The sign-in could not be verified.", 401);
    const parts = token.split(".");
    if (parts.length !== 3) throw invalid();
    let header: Record<string, unknown>; let claims: Record<string, unknown>;
    try { header = decode(parts[0]!); claims = decode(parts[1]!); } catch { throw invalid(); }
    const algorithm = typeof header.alg === "string" && Object.hasOwn(ALGORITHMS, header.alg) ? ALGORITHMS[header.alg] : undefined;
    if (!algorithm || typeof header.kid !== "string") throw invalid();
    const jwk = await this.key(header.kid);
    if (!jwk || jwk.kty !== algorithm.kty || jwk.crv !== algorithm.crv) throw invalid();
    // An ES256 signature is the raw r||s pair, not DER.
    if (!verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"))) throw invalid();
    const audience = ([] as unknown[]).concat(claims.aud);
    if (claims.iss !== this.config.issuer || !audience.includes(this.config.clientId)) throw invalid();
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw invalid();
    if (typeof claims.iat !== "number" || claims.iat * 1000 > now + SKEW_MS) throw invalid();
    if (claims.nonce !== nonce) throw invalid();
    return claims;
  }

  /** The key for `kid`; the provider's set is fetched again once when the key is not in the one we hold, so a rotation is followed. */
  private async key(kid: string): Promise<JsonWebKey | undefined> {
    const find = () => this.keys.find(key => (key as { kid?: string }).kid === kid);
    if (find()) return find();
    const response = await this.fetchImpl(this.config.jwksUrl, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new LoginError("login_unavailable", "The sign-in provider is unavailable.", 503);
    this.keys = ((await response.json()) as { keys?: JsonWebKey[] }).keys ?? [];
    return find();
  }
}
