import { describe, expect, it, vi } from "vitest";
import { isNetworkError } from "./auth-session.js";
import {
  CONSUMER_DESKTOP_ROLE_MESSAGE,
  persistedDesktopSessionFromError,
  signInDesktopSession
} from "./desktop-auth-flow.js";

describe("Consumer Desktop authentication flow", () => {
  it("saves an authenticated session before identity/access discovery and retains it offline", async () => {
    const events = [];
    const storage = memoryStorage(events);
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/v1/auth/signin")) {
        events.push("signin");
        return response({
          account: userAccount(),
          session: { token: "opaque-user", expires_at: "2026-11-08T00:00:00.000Z" }
        });
      }
      events.push("me");
      throw new Error("offline");
    });

    const error = await signInDesktopSession(
      { email: "jordan@example.com", password: "password123" },
      "https://hatch.example",
      storage,
      fetchImpl
    ).catch((caught) => caught);

    expect(events).toEqual(["signin", "save", "me"]);
    expect(storage.value).toBe("opaque-user");
    expect(isNetworkError(error)).toBe(true);
    expect(persistedDesktopSessionFromError(error)?.accessToken).toBe("opaque-user");
  });

  it("retains the session when entitlement discovery returns a server error", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/v1/auth/signin")) {
        return response({ account: userAccount(), session: { token: "opaque-user" } });
      }
      if (url.endsWith("/v1/auth/me")) return response(userAccount());
      return response({ detail: "temporarily unavailable" }, 503);
    });

    const error = await signInDesktopSession(
      { email: "jordan@example.com", password: "password123" },
      "https://hatch.example",
      storage,
      fetchImpl
    ).catch((caught) => caught);

    expect(error).toMatchObject({ code: "entitlement_request_failed", status: 503 });
    expect(storage.value).toBe("opaque-user");
    expect(persistedDesktopSessionFromError(error)?.accessToken).toBe("opaque-user");
  });

  it("identifies a valid Creator account without calling the buyer access endpoint", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/v1/auth/signin")) {
        return response({ account: creatorAccount(), session: { token: "opaque-creator" } });
      }
      if (url.endsWith("/v1/auth/me")) return response(creatorAccount());
      throw new Error(`Unexpected buyer access request: ${url}`);
    });

    const result = await signInDesktopSession(
      { email: "maya@example.com", password: "password123" },
      "https://hatch.example",
      storage,
      fetchImpl
    );

    expect(result).toMatchObject({
      state: "unsupported-role",
      session: { profile: { id: "creator_maya", role: "creator" }, accessToken: "opaque-creator" },
      entitlements: []
    });
    expect(storage.value).toBe("opaque-creator");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(CONSUMER_DESKTOP_ROLE_MESSAGE).toMatch(/Creator account is valid/);
  });

  it("keeps an empty buyer access projection as a ready signed-in result", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/v1/auth/signin")) {
        return response({ account: userAccount(), session: { token: "opaque-user" } });
      }
      if (url.endsWith("/v1/auth/me")) return response(userAccount());
      return response([]);
    });

    await expect(signInDesktopSession(
      { email: "jordan@example.com", password: "password123" },
      "https://hatch.example",
      storage,
      fetchImpl
    )).resolves.toMatchObject({ state: "ready", entitlements: [] });
  });
});

function memoryStorage(events = []) {
  let value = null;
  return {
    get value() { return value; },
    async readToken() { return value; },
    async writeToken(token) { events.push("save"); value = token; },
    async clearToken() { value = null; }
  };
}

function userAccount() {
  return { id: "user_jordan", role: "user", email: "jordan@example.com", display_name: "Jordan Lee" };
}

function creatorAccount() {
  return { id: "creator_maya", role: "creator", email: "maya@example.com", display_name: "Maya Chen" };
}

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}
