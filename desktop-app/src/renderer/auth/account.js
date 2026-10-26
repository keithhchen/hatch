import { HATCH_ORIGIN } from "../config.js";
import { HatchRequestError, requestJson } from "../http.js";
import { isUuidV4 } from "../identity.js";

/**
 * The opaque Registry session token lives only in native secure storage
 * (Keychain via the Rust bridge); the renderer never persists it.
 */
export class NativeTokenStore {
  constructor(invoke) {
    this.invoke = invoke;
  }

  async read() {
    const token = await this.invoke("read_auth_token");
    return typeof token === "string" && token.trim() ? token.trim() : null;
  }

  write(token, expiresAt) {
    return this.invoke("write_auth_token", { token, expiresAt: expiresAt || null });
  }

  clear() {
    return this.invoke("clear_auth_token");
  }
}

/** Registry identity: who the bearer is. Access to Agents is separate. */
export class RegistryAccountClient {
  constructor({ origin = HATCH_ORIGIN, fetchImpl = fetch } = {}) {
    this.origin = origin;
    this.fetchImpl = fetchImpl;
  }

  async me(token) {
    const account = await requestJson(new URL("/v1/auth/me", this.origin), { token, fetchImpl: this.fetchImpl });
    if (!isUuidV4(account?.id)) throw new HatchRequestError("account_invalid", "The account response is invalid.");
    return accountProfile(account);
  }

  /** Best-effort server revoke, bounded so sign-out never waits on the network. */
  async revoke(token, timeoutMs = 1500) {
    await Promise.race([
      requestJson(new URL("/v1/auth/logout", this.origin), { token, method: "POST", fetchImpl: this.fetchImpl }).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, timeoutMs))
    ]);
  }
}

export function accountProfile(account) {
  const name = String(account.display_name ?? account.name ?? "").trim() || String(account.email ?? "").trim();
  return Object.freeze({
    id: account.id,
    name,
    email: account.email ?? "",
    avatarUrl: account.avatar_url ?? null
  });
}
