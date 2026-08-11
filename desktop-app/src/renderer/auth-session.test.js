import { describe, expect, it, vi } from "vitest";
import {
  clearAuthSession,
  createTauriAuthStorage,
  fetchAuthAccount,
  hydrateAuthSession,
  isAuthInvalidError,
  isNetworkError,
  loadSavedAuthSession,
  revokeAuthSession,
  saveAuthSession,
  signInAuthSession,
  startAuthSessionSignOut
} from "./auth-session.js";

describe("account sessions", () => {
  it("signs in against the Registry and accepts an empty Agent library", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      account: { id: "user_123", role: "user", email: "jordan@example.com", display_name: "Jordan Lee" },
      session: { token: "opaque-token", expires_at: "2026-11-08T00:00:00.000Z" }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const signedIn = await signInAuthSession(
      { email: " Jordan@example.com ", password: "password123" },
      "https://hatch.example",
      fetchImpl
    );
    expect(signedIn).toEqual({
      profile: { id: "user_123", name: "Jordan Lee", role: "user", initials: "JL" },
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
      id: "user_123",
      role: "user",
      email: "jordan@example.com",
      display_name: "Jordan Lee",
      session_expires_at: "2026-11-08T00:00:00.000Z"
    }), { status: 200 }));
    const account = await fetchAuthAccount("https://hatch.example", "opaque-token", fetchImpl);
    expect(hydrateAuthSession({ accessToken: "opaque-token" }, account)).toMatchObject({
      profile: { id: "user_123", role: "user" },
      accessToken: "opaque-token",
      expiresAt: "2026-11-08T00:00:00.000Z"
    });
  });

  it("distinguishes an invalid session from a network failure", async () => {
    const invalid = await fetchAuthAccount("https://hatch.example", "expired", async () => new Response(
      JSON.stringify({ detail: "A valid account token is required." }), { status: 401 }
    )).catch((error) => error);
    expect(isAuthInvalidError(invalid)).toBe(true);

    const offline = await fetchAuthAccount("https://hatch.example", "opaque-token", async () => {
      throw new Error("offline");
    }).catch((error) => error);
    expect(isNetworkError(offline)).toBe(true);
  });

  it("makes logout best effort so local sign-out can complete offline", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(revokeAuthSession("https://hatch.example", "opaque-token", fetchImpl)).resolves.toBeUndefined();
  });

  it("does not make local Keychain deletion wait for a hung server revoke", async () => {
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
    expect(invoke).toHaveBeenCalledWith("write_auth_token", { token: "next-token" });
    expect(invoke).toHaveBeenCalledWith("clear_auth_token");
  });

  it("surfaces a packaged Keychain clear failure instead of claiming local sign-out", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "clear_auth_token") throw new Error("Keychain is locked");
      return command === "read_auth_token" ? "native-token" : undefined;
    });
    const storage = createTauriAuthStorage(invoke, { strict: true });

    await expect(storage.clearToken()).rejects.toThrow("Keychain is locked");
    expect(invoke).toHaveBeenCalledWith("clear_auth_token");
  });

  it("treats packaged Keychain read or ACL failures as signed out", async () => {
    const storage = createTauriAuthStorage(async (command) => {
      if (command === "read_auth_token") throw new Error("Keychain ACL denied access");
    }, { strict: true });

    await expect(loadSavedAuthSession(storage)).resolves.toBeNull();
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
