import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDesktopSignIn, DESKTOP_AUTHORIZE_PATH, DESKTOP_TOKEN_PATH } from "../desktopSignIn.mjs";

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = "state_abcdefghijklmnop";

/** In-memory collaborators for this unit test only. */
function harness({ signedIn = true } = {}) {
  const stored = new Map();
  const minted = [];
  let body = {};
  const handle = createDesktopSignIn({
    authenticate: async () => signedIn ? { token: "web-session", profile: {} } : { error: { status: 401, body: { error: { code: "unauthorized" } } } },
    mintSession: async (token) => { minted.push(token); return { session: { token: "desktop-session", expires_at: "2027-01-01T00:00:00Z" } }; },
    codes: {
      saveOAuthAuthorizationCode: async (key, record) => { stored.set(key, record); },
      consumeOAuthAuthorizationCode: async (key) => { const record = stored.get(key); stored.delete(key); return record; }
    },
    seal: (value) => `sealed:${value}`,
    open: (value) => value.replace(/^sealed:/, ""),
    readJson: async () => body,
    send: (response, status, payload) => { response.status = status; response.payload = payload; }
  });
  const call = async (path, payload) => {
    body = payload;
    const response = { setHeader() {} };
    await handle({ method: "POST" }, response, new URL(path, "http://dashboard.local"));
    return response;
  };
  return { call, minted, stored };
}

test("a signed-in browser hands Desktop a one-time code only its PKCE verifier can redeem", async () => {
  const { call, minted } = harness();
  const authorized = await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge });
  assert.equal(authorized.status, 200);
  assert.deepEqual(minted, ["web-session"]);
  const redirect = new URL(authorized.payload.redirect_uri);
  assert.equal(`${redirect.protocol}//${redirect.host}${redirect.pathname}`, "hatch://auth/callback");
  assert.equal(redirect.searchParams.get("state"), state);
  const code = redirect.searchParams.get("code");

  const wrongVerifier = await call(DESKTOP_TOKEN_PATH, { code, code_verifier: "w".repeat(43) });
  assert.equal(wrongVerifier.status, 400);
  const reused = await call(DESKTOP_TOKEN_PATH, { code, code_verifier: verifier });
  assert.equal(reused.status, 400, "a failed redemption consumes the code");
});

test("the code is redeemed once for Desktop's own session", async () => {
  const { call } = harness();
  const authorized = await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge });
  const code = new URL(authorized.payload.redirect_uri).searchParams.get("code");
  const redeemed = await call(DESKTOP_TOKEN_PATH, { code, code_verifier: verifier });
  assert.equal(redeemed.status, 200);
  assert.deepEqual(redeemed.payload, { token: "desktop-session", expires_at: "2027-01-01T00:00:00Z" });
  assert.equal((await call(DESKTOP_TOKEN_PATH, { code, code_verifier: verifier })).status, 400);
});

test("authorization requires the browser session and a well-formed request", async () => {
  assert.equal((await harness({ signedIn: false }).call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge })).status, 401);
  assert.equal((await harness().call(DESKTOP_AUTHORIZE_PATH, { state: "x", code_challenge: challenge })).status, 400);
  assert.equal((await harness().call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: "short" })).status, 400);
});
