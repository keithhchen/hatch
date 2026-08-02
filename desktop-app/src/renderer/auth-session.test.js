import { describe, expect, it, vi } from "vitest";
import {
  clearAuthSession,
  configuredAuthSession,
  loadSavedAuthSession,
  saveAuthSession,
  sessionStorageKey,
  signInAuthSession,
  validateAndSaveAuthSession
} from "./auth-session.js";

describe("account sessions", () => {
  it("loads an injected signed account token", () => {
    expect(configuredAuthSession({
      VITE_HATCH_ACCOUNT_ID: "maya-chen",
      VITE_HATCH_DISPLAY_NAME: "Maya Chen",
      VITE_HATCH_ACCOUNT_ROLE: "creator",
      VITE_HATCH_AUTH_TOKEN: "signed-token"
    })).toEqual({
      profile: { id: "maya-chen", name: "Maya Chen", role: "creator", initials: "MC" },
      accessToken: "signed-token"
    });
  });

  it("signs in against the Registry without inventing a local identity", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        token: "signed-token",
        account: { id: "maya-chen", role: "creator", email: "maya@example.com", display_name: "Maya Chen" }
      })
    }));
    await expect(signInAuthSession(
      { email: " Maya@example.com ", password: "password123" },
      "https://hatch.example",
      fetchImpl
    )).resolves.toEqual({
      profile: { id: "maya-chen", name: "Maya Chen", role: "creator", initials: "MC" },
      accessToken: "signed-token"
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://hatch.example/v1/auth/signin", expect.objectContaining({ method: "POST" }));
  });

  it("saves and restores separate account profiles", () => {
    const storage = memoryStorage();
    const maya = { profile: { id: "maya-chen", name: "Maya Chen", role: "creator", initials: "MC" }, accessToken: "maya-token" };
    const jordan = { profile: { id: "user_123", name: "Jordan Lee", role: "user", initials: "JL" }, accessToken: "jordan-token" };
    saveAuthSession(maya, storage);
    saveAuthSession(jordan, storage);
    expect(loadSavedAuthSession(storage)).toEqual(jordan);
    clearAuthSession(jordan, storage);
    expect(storage.getItem(sessionStorageKey(maya.profile.id))).not.toBeNull();
    expect(loadSavedAuthSession(storage)).toBeNull();
  });

  it("persists only after the account agent library check succeeds", async () => {
    const storage = memoryStorage();
    const session = { profile: { id: "user_123", name: "Jordan", role: "user", initials: "J" }, accessToken: "signed-token" };
    await expect(validateAndSaveAuthSession(session, async (token) => {
      expect(token).toBe("signed-token");
      return [{ entitlement_id: "ent_signal" }];
    }, storage)).resolves.toEqual([{ entitlement_id: "ent_signal" }]);
    expect(loadSavedAuthSession(storage)).toEqual(session);
  });
});

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}
