import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Browser sign-in handoff for Hatch Desktop (authorization code + PKCE over
 * the hatch:// deep link). Desktop opens /desktop/sign-in in the system
 * browser; the signed-in web page asks this endpoint for a one-time code,
 * which the browser hands to Desktop through hatch://auth/callback. Desktop
 * redeems the code with its PKCE verifier for its own Registry session, so
 * the browser session and the Desktop session are revoked independently.
 */
export const DESKTOP_AUTHORIZE_PATH = "/v1/auth/desktop/authorize";
export const DESKTOP_TOKEN_PATH = "/v1/auth/desktop/token";
export const DESKTOP_CALLBACK_URL = "hatch://auth/callback";
const DESKTOP_CLIENT_ID = "hatch-desktop";
const CODE_TTL_MS = 60_000;

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const challengeOf = (verifier) => createHash("sha256").update(verifier).digest("base64url");
const validChallenge = (value) => /^[A-Za-z0-9_-]{43,128}$/.test(String(value ?? ""));
const validVerifier = (value) => /^[A-Za-z0-9._~-]{43,128}$/.test(String(value ?? ""));
const validState = (value) => /^[A-Za-z0-9_-]{16,128}$/.test(String(value ?? ""));

function same(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {object} deps
 * @param {(request) => Promise<{profile?: object, token?: string, error?: {status, body}}>} deps.authenticate cookie session + CSRF
 * @param {(token: string) => Promise<{session: {token: string, expires_at: string}}>} deps.mintSession Registry POST /v1/auth/sessions
 * @param {{ saveOAuthAuthorizationCode, consumeOAuthAuthorizationCode }} deps.codes one-time code store
 * @param {(value: string) => string} deps.seal / deps.open encrypt the Registry token at rest
 */
export function createDesktopSignIn({ authenticate, mintSession, codes, seal, open, readJson, send, clock = Date.now }) {
  async function authorize(request, response) {
    const authentication = await authenticate(request);
    if (authentication.error) return send(response, authentication.error.status, authentication.error.body);
    const body = await readJson(request);
    const state = String(body.state ?? "");
    const codeChallenge = String(body.code_challenge ?? "");
    if (!validState(state) || !validChallenge(codeChallenge)) {
      return send(response, 400, { error: { code: "desktop_sign_in_invalid", message: "Start signing in again from Hatch Desktop." } });
    }
    const issued = await mintSession(authentication.token);
    const code = `hatch_dc_${randomBytes(32).toString("base64url")}`;
    await codes.saveOAuthAuthorizationCode(digest(code), {
      clientId: DESKTOP_CLIENT_ID,
      codeChallenge,
      registryTokenCiphertext: seal(issued.session.token),
      sessionExpiresAt: issued.session.expires_at,
      expiresAt: clock() + CODE_TTL_MS
    });
    const redirect = new URL(DESKTOP_CALLBACK_URL);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    return send(response, 200, { redirect_uri: redirect.toString() });
  }

  async function redeem(request, response) {
    const body = await readJson(request);
    const code = String(body.code ?? "");
    const verifier = String(body.code_verifier ?? "");
    const record = code && validVerifier(verifier) ? await codes.consumeOAuthAuthorizationCode(digest(code)) : undefined;
    if (!record || record.clientId !== DESKTOP_CLIENT_ID || record.expiresAt <= clock() || !same(challengeOf(verifier), record.codeChallenge)) {
      return send(response, 400, { error: { code: "desktop_sign_in_expired", message: "This sign-in link expired. Start again from Hatch Desktop." } });
    }
    response.setHeader("cache-control", "no-store");
    return send(response, 200, { token: open(record.registryTokenCiphertext), expires_at: record.sessionExpiresAt });
  }

  /** @returns {Promise<boolean>|false} whether the request was a Desktop sign-in route */
  return function handle(request, response, url) {
    if (request.method === "POST" && url.pathname === DESKTOP_AUTHORIZE_PATH) return authorize(request, response).then(() => true);
    if (request.method === "POST" && url.pathname === DESKTOP_TOKEN_PATH) return redeem(request, response).then(() => true);
    return false;
  };
}
