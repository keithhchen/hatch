import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { AccountStoreTs } from "../registryAuth.js";
import { LoginError, OidcClient } from "./oidc.js";
import { PostgresLoginStore, TelegramLogin, telegramOidc, type LoginClaim, type LoginStore, type LoginTransaction } from "./telegramLogin.js";

// Automated test doubles: a Telegram that signs its own tokens with a local key. The product never constructs these.
const CLIENT = { clientId: "client-1", clientSecret: "secret-1" };
const ORIGIN = "https://site.test";
const key = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } as JsonWebKey };
};
const GOOD = key("k1");
const OTHER = key("k1");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (claims: Record<string, unknown>, signer = GOOD, header: Record<string, unknown> = { alg: "RS256", kid: signer.kid }) => {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(signer.privateKey).toString("base64url")}`;
};

class MemoryLoginStore implements LoginStore {
  transactions = new Map<string, LoginTransaction & { expiresAt: Date }>();
  claims = new Map<string, LoginClaim & { expiresAt: Date; used?: true }>();
  async begin(t: LoginTransaction, expiresAt: Date) { this.transactions.set(t.state, { ...t, expiresAt }); }
  async take(state: string, now: Date) { const t = this.transactions.get(state); this.transactions.delete(state); return t && t.expiresAt > now ? t : undefined; }
  async issueClaim(code: string, claim: LoginClaim, expiresAt: Date) { this.claims.set(code, { ...claim, expiresAt }); }
  async peekClaim(code: string, now: Date) { const c = this.claims.get(code); return c && !c.used && c.expiresAt > now ? { subject: c.subject, ...(c.invite ? { invite: c.invite } : {}) } : undefined; }
  async useClaim(code: string, now: Date) { const c = await this.peekClaim(code, now); if (c) this.claims.get(code)!.used = true; return c; }
}

function harness(options: { idToken?: (nonce: string) => string; now?: () => Date; limited?: boolean } = {}) {
  const clock = { at: new Date() };
  const nonceOf = (authorizeUrl: string) => new URL(authorizeUrl).searchParams.get("nonce")!;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("/jwks.json")) return new Response(JSON.stringify({ keys: [GOOD.jwk] }));
    // The code the test sends back is the nonce of its own sign-in, so sign-ins in flight together do not mix.
    const nonce = new URLSearchParams(String(init!.body)).get("code")!;
    return new Response(JSON.stringify({ id_token: (options.idToken ?? ((n: string) => sign(claims({ nonce: n }))))(nonce) }));
  }) as typeof fetch;
  const store = new MemoryLoginStore();
  const accounts = new AccountStoreTs();
  const admitted: Array<[string, string, LoginClaim]> = [];
  const login = new TelegramLogin({
    oidc: new OidcClient(telegramOidc(CLIENT), fetchImpl), store, accounts, origin: ORIGIN,
    limiter: { take: async () => options.limited ? 1000 : 0 }, now: () => clock.at,
    admit: async (account, telegramId, claim) => { admitted.push([account.id, telegramId, claim]); },
  });
  /** The person comes back from Telegram with a code for the sign-in that began at `authorizeUrl`. */
  const comeBack = async (started: { authorizeUrl: string; state: string }) => login.finish({ code: nonceOf(started.authorizeUrl), state: started.state });
  return { login, store, accounts, admitted, requests, comeBack, clock };
}
const claims = (extra: Record<string, unknown> = {}) => ({
  iss: "https://oauth.telegram.org", aud: CLIENT.clientId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
  id: 4242, name: "Ann Lee", preferred_username: "ann", ...extra,
});
const refused = (code: string) => (error: unknown) => error instanceof LoginError && error.code === code;

test("The authorize URL asks for the code flow with PKCE S256 and the scopes the bot needs", async () => {
  const { login } = harness();
  const { authorizeUrl } = await login.start({});
  const url = new URL(authorizeUrl);
  assert.equal(`${url.origin}${url.pathname}`, "https://oauth.telegram.org/auth");
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual([params.client_id, params.redirect_uri, params.response_type, params.code_challenge_method], [CLIENT.clientId, `${ORIGIN}/v1/auth/telegram/callback`, "code", "S256"]);
  assert.equal(params.scope, "openid profile telegram:bot_access");
  assert.match(params.code_challenge!, /^[A-Za-z0-9_-]{43}$/);
});

test("A sign-in from the site makes an account with no email or password, and the same Telegram id comes back to it", async () => {
  const env = harness();
  const first = await env.comeBack(await env.login.start({ returnTo: "/account" }));
  assert.deepEqual([first.created, first.returnTo, first.account.email, first.account.password_hash, first.account.display_name], [true, "/account", null, null, "Ann Lee"]);
  const again = await env.comeBack(await env.login.start({}));
  assert.deepEqual([again.created, again.account.id], [false, first.account.id]);
  assert.deepEqual(env.admitted, [], "from the site no chat is bound");
  // The token endpoint is asked with Basic auth, the verifier and the same redirect URI.
  const token = env.requests.find(request => request.url.endsWith("/token"))!;
  assert.equal((token.init!.headers as Record<string, string>).authorization, `Basic ${Buffer.from("client-1:secret-1").toString("base64")}`);
  const form = new URLSearchParams(String(token.init!.body));
  assert.deepEqual([form.get("grant_type"), form.get("redirect_uri"), form.get("client_id")], ["authorization_code", `${ORIGIN}/v1/auth/telegram/callback`, CLIENT.clientId]);
  assert.match(form.get("code_verifier")!, /^[A-Za-z0-9_-]{43}$/);
});

test("An account cannot sign in with a password it does not have", async () => {
  const env = harness();
  const { account } = await env.comeBack(await env.login.start({}));
  assert.equal(await env.accounts.verifyPassword("anything-at-all", account), false);
});

test("A return path that leaves the site is dropped", async () => {
  const env = harness();
  for (const returnTo of ["//evil.test", "https://evil.test", "/\\evil"]) assert.equal((await env.comeBack(await env.login.start({ returnTo }))).returnTo, "/");
});

test("A sign-in that began in the chat is bound to the sender it was issued for, and a link is used once", async () => {
  const env = harness();
  const link = (await env.login.claimLink("4242", "HATCH-INVITE"))!;
  const claim = new URL(link).searchParams.get("claim")!;
  assert.equal(`${new URL(link).origin}${new URL(link).pathname}`, `${ORIGIN}/v1/auth/telegram/start`);
  const outcome = await env.comeBack(await env.login.start({ claim }));
  assert.deepEqual(env.admitted, [[outcome.account.id, "4242", { subject: "4242", invite: "HATCH-INVITE" }]]);
  await assert.rejects(env.login.start({ claim }), refused("claim_invalid"), "the same link a second time");
});

test("A token whose id is not the sender the link was issued for is refused, and the link is spent", async () => {
  const env = harness();
  const claim = new URL((await env.login.claimLink("1111"))!).searchParams.get("claim")!;
  await assert.rejects(env.comeBack(await env.login.start({ claim })), refused("claim_mismatch"));
  assert.deepEqual(env.admitted, []);
  assert.equal(await env.store.peekClaim(claim, env.clock.at), undefined);
  assert.equal([...env.accounts["identities"].keys()].length, 0, "nobody was signed in");
});

test("A state is single-use and expires", async () => {
  const env = harness();
  const started = await env.login.start({});
  await env.comeBack(started);
  await assert.rejects(env.login.finish({ code: "c", state: started.state }), refused("login_state_invalid"), "replayed");
  const late = await env.login.start({});
  env.clock.at = new Date(env.clock.at.getTime() + 11 * 60_000);
  await assert.rejects(env.login.finish({ code: "c", state: late.state }), refused("login_state_invalid"), "expired");
  await assert.rejects(env.login.finish({ code: "c", state: "never-issued" }), refused("login_state_invalid"));
});

test("A token that does not verify signs nobody in", async () => {
  const cases: Record<string, (nonce: string) => string> = {
    "signed by another key": nonce => sign(claims({ nonce }), OTHER),
    "an algorithm other than RS256": nonce => sign(claims({ nonce }), GOOD, { alg: "HS256", kid: "k1" }),
    "no algorithm": nonce => `${b64({ alg: "none", kid: "k1" })}.${b64(claims({ nonce }))}.`,
    "an unknown key id": nonce => sign(claims({ nonce }), GOOD, { alg: "RS256", kid: "k9" }),
    "another issuer": nonce => sign(claims({ nonce, iss: "https://evil.test" })),
    "another audience": nonce => sign(claims({ nonce, aud: "someone-else" })),
    "another nonce": () => sign(claims({ nonce: "not-ours" })),
    "expired": nonce => sign(claims({ nonce, exp: Math.floor(Date.now() / 1000) - 10 })),
    "issued in the future": nonce => sign(claims({ nonce, iat: Math.floor(Date.now() / 1000) + 3600 })),
    "no Telegram id": nonce => sign(claims({ nonce, id: undefined })),
    "an id that is not a number": nonce => sign(claims({ nonce, id: "4242; DROP" })),
    "not a token": () => "garbage",
  };
  for (const [name, idToken] of Object.entries(cases)) {
    const env = harness({ idToken });
    await assert.rejects(env.comeBack(await env.login.start({})), refused("login_failed"), name);
    assert.equal(env.accounts["identities"].size, 0, name);
  }
});

test("The same Telegram id is one account, however many sign-ins race", async () => {
  const env = harness();
  const started = await Promise.all([env.login.start({}), env.login.start({}), env.login.start({})]);
  const outcomes = await Promise.all(started.map(env.comeBack));
  assert.equal(new Set(outcomes.map(outcome => outcome.account.id)).size, 1);
});

test("Too many attempts are refused", async () => {
  const env = harness({ limited: true });
  await assert.rejects(env.login.start({}), refused("rate_limited"));
  await assert.rejects(env.login.finish({ code: "c", state: "s" }), refused("rate_limited"));
});

test("A chat that asks for a link too often gets none", async () => {
  const { login } = harness({ limited: true });
  assert.equal(await login.claimLink("4242"), undefined);
});

test("One Telegram id belongs to at most one account", async () => {
  const accounts = new AccountStoreTs();
  const { account } = await accounts.signInWithIdentity("telegram", "7", "Ann");
  const other = await accounts.create("b@verify.test", "long-enough-password", "Bob");
  assert.equal(await accounts.linkIdentity(other.id, "telegram", "7"), false);
  assert.equal(await accounts.linkIdentity(account.id, "telegram", "7"), true);
  const emailAccount = await accounts.create("c@verify.test", "long-enough-password", "Cy");
  assert.equal(await accounts.linkIdentity(emailAccount.id, "telegram", "8"), true, "an email account claims an id");
  assert.equal((await accounts.signInWithIdentity("telegram", "8", "Other name")).account.id, emailAccount.id, "and the id then signs in to it");
});

const connectionString = process.env.HATCH_TEST_DATABASE_URL;
test("In Postgres a state and a claim are each spent once, and an identity is one row", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `hatch_login_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 6 });
  try {
    const store = await PostgresLoginStore.open(pool);
    const now = new Date(); const later = new Date(now.getTime() + 60_000);
    await store.begin({ state: "s1", verifier: "v", nonce: "n", claim: "c1", returnTo: "/x" }, later);
    const taken = await Promise.all([store.take("s1", now), store.take("s1", now)]);
    assert.equal(taken.filter(Boolean).length, 1, "one of two racing callbacks wins");
    await store.begin({ state: "s2", verifier: "v", nonce: "n", returnTo: "/" }, new Date(now.getTime() - 1));
    assert.equal(await store.take("s2", now), undefined, "expired");
    await store.issueClaim("c1", { subject: "9", invite: "I" }, later);
    assert.deepEqual(await store.peekClaim("c1", now), { subject: "9", invite: "I" });
    const used = await Promise.all([store.useClaim("c1", now), store.useClaim("c1", now)]);
    assert.equal(used.filter(Boolean).length, 1, "one of two racing uses wins");
    assert.equal(await store.peekClaim("c1", now), undefined);

    const accounts = new AccountStoreTs(pool);
    await accounts.ensureSchema();
    const results = await Promise.all([1, 2, 3, 4].map(() => accounts.signInWithIdentity("telegram", "55", "Ann")));
    assert.equal(new Set(results.map(result => result.account.id)).size, 1);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM accounts")).rows[0].n, 1, "a lost race leaves no account behind");
    assert.equal((await accounts.getById(results[0]!.account.id))!.email, null);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
