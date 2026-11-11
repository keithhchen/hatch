import { LoginError, OidcClient, type OidcConfig } from "./oidc.js";
import type { IdentityProvider } from "./platformLogin.js";

type Credentials = { clientId: string; clientSecret: string };
type Claims = Record<string, unknown>;

const text = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && value.trim() !== "");
/** The id a platform's bot sees the person by; anything else is not an identity. */
const subjectOf = (pattern: RegExp, value: unknown): string => {
  const subject = String(value ?? "");
  if (!pattern.test(subject)) throw new LoginError("login_failed", "The sign-in did not say who you are.", 401);
  return subject;
};

/** A platform that speaks OpenID Connect: the id_token is checked against its keys, and `read` takes who it names. */
export const oidcIdentity = (oidc: OidcClient, scopes: string[], read: (claims: Claims) => { subject: string; name?: string }): IdentityProvider => ({
  authorizeUrl: input => oidc.authorizeUrl({ ...input, scopes }),
  identify: async input => read(await oidc.verifyIdToken(await oidc.exchange(input), input.nonce, input.now)),
});

export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const telegramOidc = (credentials: Credentials, base = TELEGRAM_ISSUER): OidcConfig => ({
  issuer: TELEGRAM_ISSUER, authorizeUrl: `${base}/auth`, tokenUrl: `${base}/token`, jwksUrl: `${base}/.well-known/jwks.json`, ...credentials,
});
/** Telegram's `id` is the sender id the bot sees. */
export const telegramIdentity = (oidc: OidcClient): IdentityProvider =>
  oidcIdentity(oidc, ["openid", "profile", "telegram:bot_access"], claims => ({ subject: subjectOf(/^\d{1,20}$/, claims.id), name: text(claims.name, claims.preferred_username) }));

export const LINE_ISSUER = "https://access.line.me";
/** LINE Login signs its id_tokens with ES256 and wants the secret in the token request's body. */
export const lineOidc = (credentials: Credentials, base = "https://api.line.me/oauth2/v2.1"): OidcConfig => ({
  issuer: LINE_ISSUER, authorizeUrl: `${LINE_ISSUER}/oauth2/v2.1/authorize`, tokenUrl: `${base}/token`, jwksUrl: `${base}/certs`, tokenAuth: "post", ...credentials,
});
/**
 * The token's `sub` is the person's LINE userId. It is the sender id the shared bot is given by the Messaging API only when the
 * LINE Login channel and the Messaging API channel belong to the same provider; under different providers the ids differ and no claim would match.
 */
export const lineIdentity = (oidc: OidcClient): IdentityProvider =>
  oidcIdentity(oidc, ["openid", "profile"], claims => ({ subject: subjectOf(/^U[0-9a-f]{32}$/, claims.sub), name: text(claims.name) }));

const DISCORD = "https://discord.com";
/** Discord is OAuth2, not OpenID Connect: there is no id_token, so the person is asked of the API with the access token. */
export class DiscordIdentity implements IdentityProvider {
  constructor(private credentials: Credentials, private fetchImpl: typeof fetch = fetch) {}

  authorizeUrl(input: { redirectUri: string; state: string; challenge: string }): string {
    const url = new URL(`${DISCORD}/oauth2/authorize`);
    for (const [key, value] of Object.entries({
      client_id: this.credentials.clientId, redirect_uri: input.redirectUri, response_type: "code", scope: "identify",
      state: input.state, code_challenge: input.challenge, code_challenge_method: "S256",
    })) url.searchParams.set(key, value);
    return url.toString();
  }

  async identify(input: { code: string; verifier: string; redirectUri: string }): Promise<{ subject: string; name?: string }> {
    const { clientId, clientSecret } = this.credentials;
    const refused = () => new LoginError("login_failed", "The sign-in provider did not accept this sign-in.", 401);
    const token = await this.fetchImpl(`${DISCORD}/api/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, code_verifier: input.verifier }),
      signal: AbortSignal.timeout(15_000),
    });
    const { access_token: accessToken } = await token.json().catch(() => ({})) as { access_token?: string };
    if (!token.ok || !accessToken) throw refused();
    const me = await this.fetchImpl(`${DISCORD}/api/users/@me`, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
    const user = await me.json().catch(() => ({})) as Claims;
    if (!me.ok) throw refused();
    return { subject: subjectOf(/^\d{15,25}$/, user.id), name: text(user.global_name, user.username) };
  }
}
