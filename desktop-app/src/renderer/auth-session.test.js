import { describe, expect, it, vi } from "vitest";
import {
  clearAuthSession,
  createTauriAuthStorage,
  fetchAuthAccount,
  hydrateAuthSession,
  isAuthInvalidError,
  isRemoteAuthSessionCleared,
  isNetworkError,
  loadSavedAuthSession,
  revokeAuthSession,
  saveAuthSession,
  signInAuthSession,
  startAuthSessionSignOut
} from "./auth-session.js";

const userId = "6aa7b10c-4db0-4d8a-8c2f-2e2c8cba1000";

describe("account sessions", () => {
  it("adds stable localization metadata to local credential validation errors", async () => {
    const missingEmail = await signInAuthSession({ email: "", password: "secret" }, "https://hatch.example")
      .catch((error) => error);
    expect(missingEmail).toMatchObject({
      message: "Enter your email.",
      i18nKey: "error.auth.emailRequired"
    });

    const missingPassword = await signInAuthSession({ email: "jordan@example.com", password: "" }, "https://hatch.example")
      .catch((error) => error);
    expect(missingPassword).toMatchObject({
      message: "Enter your password.",
      i18nKey: "error.auth.passwordRequired"
    });
  });

  it("signs in against the Registry and accepts an empty Agent library", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      account: { id: userId, role: "user", email: "jordan@example.com", display_name: "Jordan Lee" },
      session: { token: "opaque-token", expires_at: "2026-11-08T00:00:00.000Z" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const signedIn = await signInAuthSession(
      { email: " Jordan@example.com ", password: "password123" },
      "https://hatch.example",
      fetchImpl
    );
    expect(signedIn).toEqual({
      profile: { id: userId, name: "Jordan Lee", role: "user", initials: "JL" },
      accessToken: "opaque-token",
      expiresAt: "2026-11-08T00:00:00.000Z"
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://hatch.example/v1/auth/signin", expect.objectContaining({ method: "POST" }));
  });

  it("stores only the opaque token in the secure storage adapter", async () => {
    const storage = memorySecureStorage();
    const session = {
      profile: { id: "user_123", name: "Jordan Lee", role: "user", initials: "JL" },
      accessToken: "opaque-token"
    };
    await saveAuthSession(session, storage);
    await expect(loadSavedAuthSession(storage)).resolves.toEqual({ accessToken: "opaque-token" });
    expect(storage.value).toBe("opaque-token");
    await clearAuthSession(session, storage);
    await expect(loadSavedAuthSession(storage)).resolves.toBeNull();
  });

  it("hydrates the identity only after Registry /auth/me confirms the session", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: userId,
      role: "user",
      email: "jordan@example.com",
      display_name: "Jordan Lee",
      session_expires_at: "2026-11-08T00:00:00.000Z"
    }), { status: 200 }));
    const account = await fetchAuthAccount("https://hatch.example", "opaque-token", fetchImpl);
    expect(hydrateAuthSession({ accessToken: "opaque-token" }, account)).toMatchObject({
      profile: { id: userId, role: "user" },
      accessToken: "opaque-token",
      expiresAt: "2026-11-08T00:00:00.000Z"
    });
  });

  it("distinguishes an invalid session from a network failure", async () => {
    const invalid = await fetchAuthAccount("https://hatch.example", "expired", async () => new Response(
      JSON.stringify({ detail: "A valid account token is required." }), { status: 401 }
    )).catch((error) => error);
    expect(isAuthInvalidError(invalid)).toBe(true);
    expect(invalid).toMatchObject({
      message: "A valid account token is required.",
      code: "auth_invalid",
      status: 401,
      i18nKey: "error.auth.invalidSession"
    });

    const offline = await fetchAuthAccount("https://hatch.example", "opaque-token", async () => {
      throw new Error("offline");
    }).catch((error) => error);
    expect(isNetworkError(offline)).toBe(true);
    expect(offline).toMatchObject({
      code: "network_error",
      i18nKey: "error.network.unreachable",
      cause: { message: "offline" }
    });
  });

  it("keeps server detail verbatim while attaching a generic sign-in fallback key", async () => {
    const error = await signInAuthSession(
      { email: "jordan@example.com", password: "wrong" },
      "https://hatch.example",
      async () => new Response(JSON.stringify({ detail: "Registry-specific credential detail" }), { status: 401 })
    ).catch((caught) => caught);

    expect(error).toMatchObject({
      message: "Registry-specific credential detail",
      code: "invalid_credentials",
      status: 401,
      i18nKey: "error.auth.invalidCredentials"
    });
  });

  it("makes logout best effort so local sign-out can complete offline", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(revokeAuthSession("https://hatch.example", "opaque-token", fetchImpl)).resolves.toBeUndefined();
  });

  it("does not make local session deletion wait for a hung server revoke", async () => {
    const events = [];
    const storage = {
      async clearToken() { events.push("local-clear"); }
    };
    const fetchImpl = vi.fn(async (_url, options) => {
      events.push("server-revoke-started");
      await new Promise(() => {});
      return new Response(null, { status: 204, signal: options.signal });
    });

    const { serverRevoke, localClear } = startAuthSessionSignOut(
      "https://hatch.example",
      { accessToken: "opaque-token" },
      storage,
      fetchImpl,
      { timeoutMs: 10 }
    );
    await localClear;
    expect(events).toContain("local-clear");
    expect(events.indexOf("local-clear")).toBeLessThanOrEqual(events.indexOf("server-revoke-started"));
    await expect(serverRevoke).resolves.toBeUndefined();
  });

  it("uses the native bridge when available and falls back in a web-only test", async () => {
    const invoke = vi.fn(async (command) => command === "read_auth_token" ? "native-token" : undefined);
    const storage = createTauriAuthStorage(invoke);
    await expect(storage.readToken()).resolves.toBe("native-token");
    await storage.writeToken("next-token");
    await storage.clearToken();
    expect(invoke).toHaveBeenCalledWith("write_auth_token", { token: "next-token", expiresAt: null });
    expect(invoke).toHaveBeenCalledWith("clear_auth_token");
  });

  it("surfaces a packaged session clear failure instead of claiming local sign-out", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "clear_auth_token") throw new Error("Desktop state is locked");
      return command === "read_auth_token" ? "native-token" : undefined;
    });
    const storage = createTauriAuthStorage(invoke, { strict: true });

    const error = await storage.clearToken().catch((caught) => caught);
    expect(error).toMatchObject({
      message: "Desktop state is locked",
      i18nKey: "error.auth.secureSessionClearFailed"
    });
    expect(invoke).toHaveBeenCalledWith("clear_auth_token");
  });

  it("treats packaged session read failures as signed out", async () => {
    const storage = createTauriAuthStorage(async (command) => {
      if (command === "read_auth_token") throw new Error("Desktop state denied access");
    }, { strict: true });

    await expect(loadSavedAuthSession(storage)).resolves.toBeNull();
  });

  it("accepts only a cleared event from another native window", () => {
    expect(isRemoteAuthSessionCleared({ kind: "cleared", sourceWindow: "conversation-2" }, "main")).toBe(true);
    expect(isRemoteAuthSessionCleared({ kind: "cleared", sourceWindow: "main" }, "main")).toBe(false);
    expect(isRemoteAuthSessionCleared({ kind: "cleared" }, "main")).toBe(false);
    expect(isRemoteAuthSessionCleared({ kind: "signed-in", sourceWindow: "conversation-2" }, "main")).toBe(false);
  });

  it("annotates secure storage write failures without replacing their native message", async () => {
    const nativeError = new Error("Desktop state write denied");
    nativeError.code = "native_acl_denied";
    const error = await saveAuthSession(
      { accessToken: "opaque-token" },
      { async writeToken() { throw nativeError; } }
    ).catch((caught) => caught);

    expect(error).toBe(nativeError);
    expect(error).toMatchObject({
      message: "Desktop state write denied",
      code: "native_acl_denied",
      i18nKey: "error.auth.secureSessionWriteFailed"
    });
  });
});

function memorySecureStorage() {
  let value = null;
  return {
    get value() { return value; },
    async readToken() { return value; },
    async writeToken(next) { value = next; },
    async clearToken() { value = null; }
  };
}
