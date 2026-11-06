import { describe, expect, it, vi } from "vitest";
import { BrowserSignIn } from "./browser-sign-in.js";
import { DesktopSession } from "./desktop-session.js";
import { HatchRequestError } from "../http.js";

describe("browser sign-in", () => {
  it("opens the web sign-in with state + PKCE challenge and redeems only its own callback", async () => {
    const openUrl = vi.fn(async () => {});
    const fetchImpl = vi.fn(async (_url, init) => ({ ok: true, status: 200, json: async () => ({ token: "session", expires_at: "2027-01-01T00:00:00Z", echo: JSON.parse(init.body) }) }));
    const signIn = new BrowserSignIn({ openUrl, signInUrl: "https://hatch.example/desktop/sign-in", tokenUrl: "https://hatch.example/v1/auth/desktop/token", fetchImpl });
    await signIn.start();
    const opened = new URL(openUrl.mock.calls[0][0]);
    const state = opened.searchParams.get("state");
    expect(opened.pathname).toBe("/desktop/sign-in");
    expect(state).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(opened.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    await expect(signIn.complete({ code: "c", state: "forged" })).rejects.toMatchObject({ code: "sign_in_state_mismatch" });
    await signIn.start();
    const fresh = new URL(openUrl.mock.calls[1][0]).searchParams.get("state");
    expect(await signIn.complete({ code: "code-1", state: fresh })).toEqual({ token: "session", expiresAt: "2027-01-01T00:00:00Z" });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.code).toBe("code-1");
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(signIn.complete({ code: "code-1", state: fresh })).rejects.toMatchObject({ code: "sign_in_state_mismatch" });
  });
});

/** Token store / Registry doubles for this unit test only. */
function session({ token = "tok", me = async () => ({ id: "a", name: "Ada" }), agents = async () => [] } = {}) {
  const tokens = { read: vi.fn(async () => token), clear: vi.fn(async () => {}) };
  const accounts = { me: vi.fn(me), revoke: vi.fn(async () => {}) };
  return { tokens, accounts, session: new DesktopSession({ tokens, accounts, fetchAgentsImpl: vi.fn(agents) }) };
}

describe("desktop session", () => {
  it("without a saved token is signed out", async () => {
    const { session: desktop } = session({ token: null });
    await desktop.launch();
    expect(desktop.getState().phase).toBe("signed-out");
  });

  it("with a token shows the shell at once and loads account and Agents", async () => {
    const { session: desktop } = session({ agents: async () => [{ key: "product:p" }] });
    const launching = desktop.launch();
    await Promise.resolve();
    expect(desktop.getState()).toMatchObject({ phase: "signed-in", agentsStatus: "loading" });
    await launching;
    expect(desktop.getState()).toMatchObject({ phase: "signed-in", account: { id: "a" }, agentsStatus: "ready", agents: [{ key: "product:p" }] });
  });

  it("keeps the shell when the service is unreachable, and signs out on 401", async () => {
    const offline = session({ me: async () => { throw new HatchRequestError("network_error"); } });
    await offline.session.launch();
    expect(offline.session.getState()).toMatchObject({ phase: "signed-in", agentsStatus: "error", error: { code: "network_error" } });
    expect(offline.tokens.clear).not.toHaveBeenCalled();

    const expired = session({ me: async () => { throw new HatchRequestError("auth_invalid", "x", 401); } });
    await expired.session.launch();
    expect(expired.session.getState().phase).toBe("signed-out");
    expect(expired.tokens.clear).toHaveBeenCalled();
  });

  it("signs out locally without waiting for the server revoke", async () => {
    const { session: desktop, tokens, accounts } = session();
    accounts.revoke.mockImplementation(() => new Promise(() => {}));
    await desktop.launch();
    await desktop.signOut();
    expect(tokens.clear).toHaveBeenCalled();
    expect(desktop.getState().phase).toBe("signed-out");
  });
});
