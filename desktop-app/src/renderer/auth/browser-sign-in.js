import { DESKTOP_SIGN_IN_URL, HATCH_ORIGIN } from "../config.js";
import { HatchRequestError, requestJson } from "../http.js";

const base64Url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const randomToken = (size = 32) => base64Url(crypto.getRandomValues(new Uint8Array(size)));

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/**
 * Sign-in happens in the system browser. Desktop keeps a PKCE verifier and a
 * state nonce in memory, opens the web sign-in page, and receives a one-time
 * code back through the hatch://auth/callback deep link. Only this process
 * can redeem that code, for its own Registry session.
 */
export class BrowserSignIn {
  constructor({ openUrl, signInUrl = DESKTOP_SIGN_IN_URL, tokenUrl = new URL("/v1/auth/desktop/token", HATCH_ORIGIN), fetchImpl = fetch }) {
    Object.assign(this, { openUrl, signInUrl, tokenUrl, fetchImpl });
    this.pending = null;
  }

  get waiting() {
    return Boolean(this.pending);
  }

  async start() {
    const verifier = randomToken();
    const state = randomToken(18);
    this.pending = { verifier, state };
    const url = new URL(this.signInUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", await pkceChallenge(verifier));
    await this.openUrl(url.toString());
  }

  cancel() {
    this.pending = null;
  }

  /** Redeem the deep-link callback. @returns {Promise<{token: string, expiresAt?: string}>} */
  async complete({ code, state }) {
    const pending = this.pending;
    if (!pending || typeof state !== "string" || state !== pending.state || !code) {
      throw new HatchRequestError("sign_in_state_mismatch", "This sign-in did not start in this window.");
    }
    this.pending = null;
    const result = await requestJson(this.tokenUrl, { method: "POST", body: { code, code_verifier: pending.verifier }, fetchImpl: this.fetchImpl });
    if (typeof result?.token !== "string" || !result.token) throw new HatchRequestError("sign_in_failed", "Sign-in returned no session.");
    return { token: result.token, expiresAt: result.expires_at };
  }
}
