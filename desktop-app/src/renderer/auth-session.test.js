import { describe, expect, it } from "vitest";
import {
  accessCodeAuthSession,
  clearAuthSession,
  configuredAuthSession,
  loadSavedAuthSession,
  saveAuthSession,
  sessionStorageKey,
  validateAndSaveAuthSession
} from "./auth-session.js";

describe("configuredAuthSession", () => {
  it("loads an injected session without embedding an identity in the client", () => {
    expect(configuredAuthSession({
      VITE_HATCH_USER_ID: "buyer_fixture",
      VITE_HATCH_USER_NAME: "Fixture Buyer",
      VITE_HATCH_ACCESS_TOKEN: "license_fixture"
    })).toEqual({
      profile: { id: "buyer_fixture", name: "Fixture Buyer", initials: "FB" },
      accessToken: "license_fixture"
    });
  });

  it("does not invent a fallback user or credential", () => {
    expect(configuredAuthSession({})).toBeNull();
  });
});

describe("access-code sessions", () => {
  it("creates a local profile from ordinary sign-in fields without exposing the code in its id", () => {
    const session = accessCodeAuthSession({ name: "  Jordan   Lee ", accessCode: "hatch-secret-code" });
    expect(session.profile).toEqual({ id: expect.stringMatching(/^buyer_/), name: "Jordan Lee", initials: "JL" });
    expect(session.profile.id).not.toContain("secret");
    expect(session.accessToken).toBe("hatch-secret-code");
  });

  it.each([
    [{ name: "", accessCode: "code" }, "Enter your name."],
    [{ name: "Jordan", accessCode: " " }, "Enter your access code."]
  ])("rejects incomplete manual sign-in", (input, message) => {
    expect(() => accessCodeAuthSession(input)).toThrow(message);
  });

  it("saves and restores the active profile while keeping profile records separate", () => {
    const storage = memoryStorage();
    const jordan = accessCodeAuthSession({ name: "Jordan Lee", accessCode: "code-jordan" });
    const taylor = accessCodeAuthSession({ name: "Taylor Kim", accessCode: "code-taylor" });
    saveAuthSession(jordan, storage);
    saveAuthSession(taylor, storage);

    expect(loadSavedAuthSession(storage)).toEqual(taylor);
    expect(storage.getItem(sessionStorageKey(jordan.profile.id))).not.toBeNull();
    expect(storage.getItem(sessionStorageKey(taylor.profile.id))).not.toBeNull();

    clearAuthSession(taylor, storage);
    expect(loadSavedAuthSession(storage)).toBeNull();
    expect(storage.getItem(sessionStorageKey(jordan.profile.id))).not.toBeNull();
    expect(storage.getItem(sessionStorageKey(taylor.profile.id))).toBeNull();
  });

  it("ignores a corrupt saved session", () => {
    const storage = memoryStorage();
    storage.setItem("hatch.auth.activeProfile", "buyer_bad");
    storage.setItem(sessionStorageKey("buyer_bad"), "not-json");
    expect(loadSavedAuthSession(storage)).toBeNull();
  });

  it("does not persist an invalid access code", async () => {
    const storage = memoryStorage();
    const session = accessCodeAuthSession({ name: "Jordan Lee", accessCode: "wrong-code" });

    await expect(validateAndSaveAuthSession(session, async () => [], storage))
      .rejects.toThrow("We couldn't find any purchased agents for that access code.");
    expect(loadSavedAuthSession(storage)).toBeNull();
    expect(storage.getItem(sessionStorageKey(session.profile.id))).toBeNull();
  });

  it("persists only after the purchased-agent check succeeds", async () => {
    const storage = memoryStorage();
    const session = accessCodeAuthSession({ name: "Jordan Lee", accessCode: "valid-code" });
    const agents = [{ entitlement_id: "ent_signal" }];

    await expect(validateAndSaveAuthSession(session, async (code) => {
      expect(code).toBe("valid-code");
      expect(loadSavedAuthSession(storage)).toBeNull();
      return agents;
    }, storage)).resolves.toBe(agents);
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
