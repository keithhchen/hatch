import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { test } from "node:test";
import { AccountStoreTs } from "../registryAuth.js";
import { DiscordIdentity, lineIdentity, lineOidc, telegramIdentity, telegramOidc } from "./identities.js";
import { LoginError, OidcClient } from "./oidc.js";
import { PlatformLogin, type LoginClaim, type LoginStore, type LoginTransaction } from "./platformLogin.js";

// Automated test doubles: LINE and Discord that sign and answer with local keys and canned bodies. The product never constructs these.
const CLIENT = { clientId: "client-1", clientSecret: "secret-1" };
const ORIGIN = "https://site.test";
const LINE_USER = `U${"a1".repeat(16)}`;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const lineKey = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" } as JsonWebKey };
};
const GOOD = lineKey("l1");
const OTHER = lineKey("l1");
const signLine = (claims: Record<string, unknown>, signer = GOOD, header: Record<string, unknown> = { alg: "ES256", kid: signer.kid }) => {
  const body = `${b64(header)}.${b64(claims)}`;
  return `${body}.${createSign("SHA256").update(body).sign({ key: signer.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};
const lineClaims = (extra: Record<string, unknown> = {}) => ({
  iss: "https://access.line.me", aud: CLIENT.clientId, sub: LINE_USER, name: "Lin Ne", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...extra,
});
const refused = (code: string) => (error: unknown) => error instanceof LoginError && error.code === code;
const input = { code: "c", verifier: "v", redirectUri: `${ORIGIN}/v1/auth/line/callback`, now: Date.now() };

function line(idToken: (nonce: string) => string) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify(url.endsWith("/certs") ? { keys: [GOOD.jwk] } : { id_token: idToken("n1") }));
  }) as typeof fetch;
  return { provider: lineIdentity(new OidcClient(lineOidc(CLIENT), fetchImpl)), requests };
}

test("LINE: the authorize URL is LINE's, and the token request carries the secret in its body", async () => {
  const { provider, requests } = line(nonce => signLine(lineClaims({ nonce })));
  const url = new URL(provider.authorizeUrl({ redirectUri: input.redirectUri, state: "s", nonce: "n1", challenge: "ch" }));
  assert.equal(`${url.origin}${url.pathname}`, "https://access.line.me/oauth2/v2.1/authorize");
  assert.deepEqual([url.searchParams.get("scope"), url.searchParams.get("nonce"), url.searchParams.get("code_challenge_method")], ["openid profile", "n1", "S256"]);
  assert.deepEqual(await provider.identify({ ...input, nonce: "n1" }), { subject: LINE_USER, name: "Lin Ne" });
  const token = requests.find(request => request.url === "https://api.line.me/oauth2/v2.1/token")!;
  assert.equal((token.init!.headers as Record<string, string>).authorization, undefined);
  assert.equal(new URLSearchParams(String(token.init!.body)).get("client_secret"), CLIENT.clientSecret);
  assert.ok(requests.some(request => request.url === "https://api.line.me/oauth2/v2.1/certs"));
});

test("LINE: a token that does not verify, or names no LINE user id, signs nobody in", async () => {
  const cases: Record<string, (nonce: string) => string> = {
    "signed by another key": nonce => signLine(lineClaims({ nonce }), OTHER),
    "an algorithm other than ES256": nonce => signLine(lineClaims({ nonce }), GOOD, { alg: "HS256", kid: "l1" }),
    "RS256 claimed for an EC key": nonce => signLine(lineClaims({ nonce }), GOOD, { alg: "RS256", kid: "l1" }),
    "another issuer": nonce => signLine(lineClaims({ nonce, iss: "https://evil.test" })),
    "another audience": nonce => signLine(lineClaims({ nonce, aud: "someone-else" })),
    "another nonce": () => signLine(lineClaims({ nonce: "not-ours" })),
    "expired": nonce => signLine(lineClaims({ nonce, exp: Math.floor(Date.now() / 1000) - 10 })),
    "no subject": nonce => signLine(lineClaims({ nonce, sub: undefined })),
    "a subject that is not a LINE user id": nonce => signLine(lineClaims({ nonce, sub: "1234" })),
  };
  for (const [name, idToken] of Object.entries(cases)) await assert.rejects(line(idToken).provider.identify({ ...input, nonce: "n1" }), refused("login_failed"), name);
});

function discord(responses: { token?: Response; me?: Response }) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return (url.endsWith("/token") ? responses.token : responses.me) ?? new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { provider: new DiscordIdentity(CLIENT, fetchImpl), requests };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("Discord: the authorize URL asks for `identify`, and the person is read from users/@me with the access token", async () => {
  const { provider, requests } = discord({ token: json({ access_token: "at-1" }), me: json({ id: "80351110224678912", username: "ann", global_name: "Ann Lee" }) });
  const url = new URL(provider.authorizeUrl({ redirectUri: input.redirectUri, state: "s", challenge: "ch" }));
  assert.equal(`${url.origin}${url.pathname}`, "https://discord.com/oauth2/authorize");
  assert.deepEqual([url.searchParams.get("scope"), url.searchParams.get("client_id"), url.searchParams.get("code_challenge_method")], ["identify", CLIENT.clientId, "S256"]);
  assert.deepEqual(await provider.identify(input), { subject: "80351110224678912", name: "Ann Lee" });
  assert.equal(requests[0]!.url, "https://discord.com/api/oauth2/token");
  const form = new URLSearchParams(String(requests[0]!.init!.body));
  assert.deepEqual([form.get("grant_type"), form.get("code_verifier"), form.get("redirect_uri")], ["authorization_code", "v", input.redirectUri]);
  assert.equal(requests[1]!.url, "https://discord.com/api/users/@me");
  assert.equal((requests[1]!.init!.headers as Record<string, string>).authorization, "Bearer at-1");
});

test("Discord: the name falls back to the username, and a refusal or an odd id signs nobody in", async () => {
  assert.equal((await discord({ token: json({ access_token: "a" }), me: json({ id: "80351110224678912", username: "ann" }) }).provider.identify(input)).name, "ann");
  const cases: Record<string, Parameters<typeof discord>[0]> = {
    "the token endpoint refuses": { token: json({ error: "invalid_grant" }, 400) },
    "no access token": { token: json({}) },
    "users/@me refuses": { token: json({ access_token: "a" }), me: json({ message: "401" }, 401) },
    "no id": { token: json({ access_token: "a" }), me: json({ username: "ann" }) },
    "an id that is not a snowflake": { token: json({ access_token: "a" }), me: json({ id: "1; DROP" }) },
  };
  for (const [name, responses] of Object.entries(cases)) await assert.rejects(discord(responses).provider.identify(input), refused("login_failed"), name);
});

class MemoryLoginStore implements LoginStore {
  transactions = new Map<string, LoginTransaction>();
  claims = new Map<string, LoginClaim & { used?: true }>();
  async begin(t: LoginTransaction) { this.transactions.set(t.state, t); }
  async take(state: string) { const t = this.transactions.get(state); this.transactions.delete(state); return t; }
  async issueClaim(code: string, claim: LoginClaim) { this.claims.set(code, claim); }
  async peekClaim(code: string) { const c = this.claims.get(code); return c && !c.used ? c : undefined; }
  async useClaim(code: string) { const c = await this.peekClaim(code); if (c) this.claims.get(code)!.used = true; return c; }
}

/** Platforms that vouch for whoever the test says, so the service is exercised on its own. */
function service() {
  const who: Record<string, string> = { telegram: "4242", line: LINE_USER, discord: "80351110224678912" };
  const providers = Object.fromEntries(Object.keys(who).map(kind => [kind, {
    authorizeUrl: ({ state }: { state: string }) => `https://${kind}.test/authorize?state=${state}`,
    identify: async () => ({ subject: who[kind]! }),
  }]));
  const accounts = new AccountStoreTs();
  const admitted: Array<[string, string]> = [];
  const store = new MemoryLoginStore();
  const login = new PlatformLogin({ providers, store, accounts, origin: ORIGIN, limiter: { take: async () => 0 }, admit: async (kind, _account, subject) => { admitted.push([kind, subject]); } });
  return { login, accounts, admitted, store, who };
}

test("The service signs in each platform on its own: callback per platform, and a platform id is one account", async () => {
  const { login, accounts, who } = service();
  assert.deepEqual(login.kinds().sort(), ["discord", "line", "telegram"]);
  assert.equal(login.redirectUri("line"), `${ORIGIN}/v1/auth/line/callback`);
  const ids = new Set<string>();
  for (const kind of ["telegram", "line", "discord"] as const) {
    const started = await login.start(kind, {});
    const first = await login.finish(kind, { code: "c", state: started.state });
    const again = await login.finish(kind, { code: "c", state: (await login.start(kind, {})).state });
    assert.deepEqual([first.created, again.created, again.account.id], [true, false, first.account.id]);
    assert.equal(first.account.display_name, { telegram: "Telegram", line: "LINE", discord: "Discord" }[kind], "no name given: the platform's");
    assert.equal((await accounts.signInWithIdentity(kind, who[kind]!, "x")).account.id, first.account.id);
    ids.add(first.account.id);
  }
  assert.equal(ids.size, 3, "the same person on three platforms is three accounts until they link");
});

test("A state or a claim belongs to the platform it was issued for", async () => {
  const { login, admitted, store } = service();
  const started = await login.start("line", {});
  await assert.rejects(login.finish("discord", { code: "c", state: started.state }), refused("login_state_invalid"));
  await assert.rejects(login.finish("line", { code: "c", state: started.state }), refused("login_state_invalid"), "and it is spent");
  const claim = new URL((await login.claimLink("line", LINE_USER, "INVITE"))!).searchParams.get("claim")!;
  assert.equal((await login.claimLink("line", LINE_USER))!.startsWith(`${ORIGIN}/v1/auth/line/start?claim=`), true);
  await assert.rejects(login.start("discord", { claim }), refused("claim_invalid"));
  assert.ok(await store.peekClaim(claim), "refusing to start did not spend it");
  await login.finish("line", { code: "c", state: (await login.start("line", { claim })).state });
  assert.deepEqual(admitted, [["line", LINE_USER]]);
  await assert.rejects(login.start("line", { claim }), refused("claim_invalid"), "single-use");
});

test("A claim for another sender id is refused and spent, on any platform", async () => {
  const { login, admitted, store } = service();
  const claim = new URL((await login.claimLink("discord", "11111111111111111"))!).searchParams.get("claim")!;
  await assert.rejects(login.finish("discord", { code: "c", state: (await login.start("discord", { claim })).state }), refused("claim_mismatch"));
  assert.deepEqual(admitted, []);
  assert.equal(await store.peekClaim(claim), undefined);
});

test("A platform without a sign-in offers no link and refuses to start or finish", async () => {
  const accounts = new AccountStoreTs();
  const login = new PlatformLogin({ providers: { telegram: telegramIdentity(new OidcClient(telegramOidc(CLIENT))) }, store: new MemoryLoginStore(), accounts, origin: ORIGIN, limiter: { take: async () => 0 }, admit: async () => undefined });
  assert.equal(login.enabled("line"), false);
  assert.equal(await login.claimLink("line", LINE_USER), undefined);
  await assert.rejects(login.start("line", {}), refused("login_unavailable"));
  await assert.rejects(login.finish("line", { code: "c", state: "s" }), refused("login_unavailable"));
});
