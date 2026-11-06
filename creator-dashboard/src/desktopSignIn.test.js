import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDesktopSignIn, DESKTOP_AUTHORIZE_PATH, DESKTOP_TOKEN_PATH, DESKTOP_CALLBACK_URL, RedirectPolicy } from "../desktopSignIn.mjs";

const verifier = "v".repeat(43);
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = "state_abcdefghijklmnop";

/** In-memory collaborators for this unit test only. */
function harness({ signedIn = true } = {}) {
  const stored = new Map();
  const minted = [];
  const kinds = [];
  let body = {};
  const handle = createDesktopSignIn({
    authenticate: async () => signedIn ? { token: "web-session", profile: {} } : { error: { status: 401, body: { error: { code: "unauthorized" } } } },
    mintSession: async (token, clientType) => { minted.push(token); kinds.push(clientType); return { session: { token: "desktop-session", expires_at: "2027-01-01T00:00:00Z" } }; },
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
  return { call, minted, kinds, stored };
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

const loopback = "http://127.0.0.1:53682/callback";

test("the CLI signs in through an allowed loopback redirect and gets a cli session", async () => {
  const { call, kinds } = harness();
  const authorized = await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge, redirect_uri: loopback });
  assert.equal(authorized.status, 200);
  assert.deepEqual(kinds, ["cli"]);
  const redirect = new URL(authorized.payload.redirect_uri);
  assert.equal(`${redirect.origin}${redirect.pathname}`, "http://127.0.0.1:53682/callback");
  assert.equal(redirect.searchParams.get("state"), state);
  const code = redirect.searchParams.get("code");
  assert.equal((await call(DESKTOP_TOKEN_PATH, { code, code_verifier: verifier, redirect_uri: loopback })).status, 200);
});

test("Desktop is the default client and keeps its deep link", async () => {
  const { call, kinds } = harness();
  await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge });
  const explicit = await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge, redirect_uri: DESKTOP_CALLBACK_URL });
  assert.deepEqual(kinds, ["desktop", "desktop"]);
  assert.ok(explicit.payload.redirect_uri.startsWith(DESKTOP_CALLBACK_URL));
});

test("redirect policy allows only the deep link and exact loopback callbacks", () => {
  const policy = new RedirectPolicy();
  for (const ok of ["http://localhost:1024/callback", "http://127.0.0.1:65535/callback", loopback]) assert.equal(policy.resolve(ok)?.client, "cli", ok);
  assert.equal(policy.resolve(undefined)?.client, "desktop");
  for (const bad of [
    "http://127.0.0.1:1023/callback", "http://127.0.0.1:65536/callback", "http://127.0.0.1/callback",
    "http://127.0.0.1:53682/other", "http://127.0.0.1:53682/callback/", "http://127.0.0.1:53682/callback?x=1",
    "https://127.0.0.1:53682/callback", "http://evil.com:53682/callback", "http://127.0.0.1.evil.com:53682/callback",
    "http://user@127.0.0.1:53682/callback", "http://[::1]:53682/callback", "https://example.com/cb", "hatch-evil://auth/callback"
  ]) assert.equal(policy.resolve(bad), undefined, bad);
  assert.equal(new RedirectPolicy([() => "x"]).resolve("anything")?.client, "x", "rules are pluggable");
});

test("authorize rejects a disallowed redirect and redeem rejects a mismatched one", async () => {
  const bad = await harness().call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge, redirect_uri: "https://evil.example/cb" });
  assert.equal(bad.status, 400);
  for (const redeemWith of [undefined, "http://127.0.0.1:53683/callback", "http://localhost:53682/callback"]) {
    const { call } = harness();
    const authorized = await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge, redirect_uri: loopback });
    const code = new URL(authorized.payload.redirect_uri).searchParams.get("code");
    assert.equal((await call(DESKTOP_TOKEN_PATH, { code, code_verifier: verifier, ...(redeemWith ? { redirect_uri: redeemWith } : {}) })).status, 400);
  }
  const { call } = harness();
  const authorized = await call(DESKTOP_AUTHORIZE_PATH, { state, code_challenge: challenge });
  const code = new URL(authorized.payload.redirect_uri).searchParams.get("code");
  assert.equal((await call(DESKTOP_TOKEN_PATH, { code, code_verifier: verifier, redirect_uri: loopback })).status, 400, "a Desktop code cannot be redeemed as CLI");
});
