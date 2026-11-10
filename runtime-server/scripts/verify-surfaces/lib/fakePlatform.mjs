import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import http from "node:http";
import { readBody, sleep } from "./util.mjs";

/**
 * VERIFICATION TOOL ONLY. The outside world, locally: a messaging platform that records everything it is sent and can be told to
 * misbehave, plus the web-search provider the product's `hatch.web_search` tool calls. The product's adapters are the real ones;
 * a preload rewrites only their host so their requests land here.
 *
 * Paths: `/<platform host>/<original path>` for platform APIs, `/search` for web search.
 * Faults are consumed in order, one per matching request: { match: (call) => bool, status, body, hangMs, headers }.
 */
export class FakePlatform {
  constructor() {
    this.calls = [];
    this.faults = [];
    this.files = new Map();
    this.revoked = false;
    this.responders = new Map();
    this.search = { delayMs: 0, calls: [] };
    this.nextMessageId = 1000;
    this.waiters = [];
    /** Bots by token: the username getMe answers, and the webhook the product registered for each (setWebhook), the way Telegram keeps it. */
    this.bots = new Map();
    this.webhooks = new Map();
    /** Telegram's login (OpenID Connect): signs id_tokens with its own key, and remembers which Telegram user each authorization is for. */
    this.login = { clientId: "verify-login-client", clientSecret: "verify-login-secret", issuer: "https://oauth.telegram.org", kid: "verify-key", ...generateKeyPairSync("rsa", { modulusLength: 2048 }), codes: new Map(), nextUser: undefined };
  }

  /** The Telegram user who completes the next authorization at /auth, the way a person tapping "Log in" on Telegram does. */
  nextLogin(user) { this.login.nextUser = user; }
  /** An id_token as Telegram signs it. `overrides` makes a forged or stale one for refusal tests; `key` signs with another key. */
  idToken({ nonce, user, overrides = {}, key = this.login }) {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const body = `${b64({ alg: "RS256", kid: this.login.kid })}.${b64({ iss: this.login.issuer, aud: this.login.clientId, iat: now, exp: now + 300, nonce, id: user.id, name: user.name, preferred_username: user.username, ...overrides })}`;
    return `${body}.${createSign("RSA-SHA256").update(body).sign(key.privateKey).toString("base64url")}`;
  }
  /** What a browser does with an authorize URL: Telegram asks the person, then sends them back with a code and the state. Returns the callback's query. */
  authorize(authorizeUrl, user = this.login.nextUser) {
    const params = new URL(authorizeUrl).searchParams;
    const code = randomUUID();
    this.login.codes.set(code, { user, nonce: params.get("nonce"), challenge: params.get("code_challenge"), redirectUri: params.get("redirect_uri"), clientId: params.get("client_id") });
    return { code, state: params.get("state"), redirectUri: params.get("redirect_uri") };
  }
  /** The webhook a bot registered: where to post its updates and the secret to sign them with. */
  webhookOf(token) { return this.webhooks.get(token); }

  async start() {
    this.server = http.createServer((request, response) => { void this.handle(request, response).catch((error) => { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }); });
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    return this;
  }
  get url() { return `http://127.0.0.1:${this.port}`; }
  async stop() { this.server.closeAllConnections(); await new Promise((resolve) => this.server.close(resolve)); }

  /** Registers bytes a platform file download will serve. Returns the Telegram `file_id`. */
  addFile(name, bytes) { const id = `file-${this.files.size + 1}`; this.files.set(id, { name, bytes: Buffer.from(bytes) }); return id; }
  /** Overrides the answer for a platform method: (call) => ({ status, body }). */
  respond(host, method, handler) { this.responders.set(`${host}:${method}`, handler); }
  inject(fault) { this.faults.push({ ...fault }); }
  revoke() { this.revoked = true; }
  reset() { this.calls.length = 0; this.faults.length = 0; this.revoked = false; this.search.calls.length = 0; this.search.delayMs = 0; }
  sends(host = "api.telegram.org") { return this.calls.filter((call) => call.host === host && call.method === "sendMessage" && call.delivered); }
  attempts(method = "sendMessage") { return this.calls.filter((call) => call.method === method); }

  /** Resolves when `predicate` holds over the recorded calls. */
  async waitFor(what, predicate, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (predicate(this.calls)) return true; await sleep(100); }
    throw new Error(`Timed out waiting for ${what}`);
  }

  async handle(request, response) {
    const raw = await readBody(request);
    const url = new URL(request.url, "http://platform.local");
    if (url.pathname === "/search") return this.handleSearch(raw, response);
    const [, host, ...rest] = url.pathname.split("/");
    if (host === "oauth.telegram.org") return this.handleLogin(request, rest.join("/"), raw, response);
    const tail = `/${rest.join("/")}`;
    let body = {};
    const text = raw.toString("utf8");
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    const telegram = tail.match(/^\/bot([^/]+)\/(\w+)$/);
    const call = { at: Date.now(), host, path: tail, method: telegram?.[2] ?? tail, body, headers: request.headers, delivered: false };
    this.calls.push(call);
    const finish = (status, payload, headers = {}) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(payload)); };
    const fault = this.faults.findIndex((candidate) => !candidate.match || candidate.match(call));
    if (fault >= 0) {
      const [injected] = this.faults.splice(fault, 1);
      call.fault = injected.name ?? (injected.hangMs ? "timeout" : String(injected.status));
      if (injected.hangMs) { await sleep(injected.hangMs); call.delivered = injected.deliverAnyway === true; if (call.delivered) return finish(200, { ok: true, result: { message_id: this.nextMessageId++ } }); return response.destroy(); }
      return finish(injected.status, injected.body ?? { ok: false, description: `injected ${injected.status}` }, injected.headers);
    }
    if (this.revoked) { call.fault = "revoked"; return finish(401, { ok: false, description: "Unauthorized: revoked" }); }
    const custom = this.responders.get(`${host}:${call.method}`);
    if (custom) { const answer = custom(call); call.delivered = (answer.status ?? 200) < 300; return finish(answer.status ?? 200, answer.body); }
    if (telegram) {
      if (call.method === "getMe") {
        const username = this.bots.get(telegram[1]);
        if (!username) return finish(401, { ok: false, error_code: 401, description: "Unauthorized" });
        call.delivered = true;
        return finish(200, { ok: true, result: { id: 1, is_bot: true, username } });
      }
      if (call.method === "setWebhook") { this.webhooks.set(telegram[1], { url: body.url, secret: body.secret_token }); call.delivered = true; return finish(200, { ok: true, result: true }); }
      if (call.method === "deleteWebhook") { this.webhooks.delete(telegram[1]); call.delivered = true; return finish(200, { ok: true, result: true }); }
      if (call.method === "getFile") { const file = this.files.get(body.file_id); return file ? finish(200, { ok: true, result: { file_path: `files/${body.file_id}/${file.name}` } }) : finish(400, { ok: false, description: "no such file" }); }
      call.delivered = true;
      return finish(200, { ok: true, result: { message_id: this.nextMessageId++ } });
    }
    const download = tail.match(/^\/file\/bot[^/]+\/files\/([^/]+)\//);
    if (download && this.files.has(download[1])) { response.writeHead(200); return response.end(this.files.get(download[1]).bytes); }
    call.delivered = true;
    finish(200, { ok: true, code: 0, msg: "ok", data: {}, result: {} });
  }

  /** oauth.telegram.org: the token endpoint (Basic auth, PKCE) and the key set. /auth is played by `authorize`. */
  async handleLogin(request, tail, raw, response) {
    const send = (status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
    this.calls.push({ at: Date.now(), host: "oauth.telegram.org", path: `/${tail}`, method: tail, body: {}, headers: request.headers, delivered: true });
    if (tail === ".well-known/jwks.json") return send(200, { keys: [{ ...this.login.publicKey.export({ format: "jwk" }), kid: this.login.kid, alg: "RS256", use: "sig" }] });
    if (tail === "token") {
      const form = new URLSearchParams(raw.toString("utf8"));
      const basic = Buffer.from(String(request.headers.authorization ?? "").replace(/^Basic /, ""), "base64").toString();
      const grant = this.login.codes.get(form.get("code"));
      this.login.codes.delete(form.get("code"));
      const verifier = form.get("code_verifier") ?? "";
      const { createHash } = await import("node:crypto");
      const proven = grant && createHash("sha256").update(verifier).digest("base64url") === grant.challenge;
      if (basic !== `${this.login.clientId}:${this.login.clientSecret}` || !grant || !proven || form.get("redirect_uri") !== grant.redirectUri) return send(400, { error: "invalid_grant" });
      return send(200, { id_token: this.idToken({ nonce: grant.nonce, user: grant.user }), token_type: "Bearer" });
    }
    send(404, { error: "not_found" });
  }

  async handleSearch(raw, response) {
    const query = JSON.parse(raw.toString("utf8") || "{}").query;
    const entry = { at: Date.now(), query };
    this.search.calls.push(entry);
    if (this.search.delayMs) await sleep(this.search.delayMs);
    entry.answeredAt = Date.now();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ title: "Verification fixture result", url: "https://example.invalid/fixture", snippet: `Fixture search result for: ${query}` }] }));
  }
}

/** Rewrites the registry-side platform hosts to the fake platform. Written to a file and passed with `node --import`. */
export const hostRewritePreload = (hosts) => `const real = globalThis.fetch;
const hosts = ${JSON.stringify(hosts)};
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const match = hosts.find((host) => url.startsWith("https://" + host + "/"));
  return real(match ? process.env.VERIFY_PLATFORM_URL + "/" + match + url.slice(("https://" + match).length) : input, init);
};
`;
