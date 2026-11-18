import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const DAY = 24 * 60 * 60_000;

test("Browser auth uses an HttpOnly session cookie and rejects missing CSRF", async (context) => {
  const registry = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "opaque-registry-session",
        account: { id: "buyer-cookie", display_name: "Cookie Buyer" }
      }));
      return;
    }
    if (request.url === "/v1/auth/me" && request.headers.authorization === "Bearer opaque-registry-session") {
      response.end(JSON.stringify({ id: "buyer-cookie", email: "buyer@example.com", display_name: "Cookie Buyer", avatar_url: null, session_expires_at: "2030-01-01T00:00:00.000Z" }));
      return;
    }
    response.statusCode = 401;
    response.end(JSON.stringify({ detail: "unauthorized" }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-cookie-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "buyer@example.test", password: "test-only" })
  });
  const loginBody = await login.json();
  assert.equal(login.status, 200);
  assert.equal("token" in loginBody, false);
  assert.equal(loginBody.profile.id, "buyer-cookie");

  const setCookies = login.headers.getSetCookie();
  assert.ok(setCookies.some((value) => /^hatch_web_session=/.test(value) && /HttpOnly/.test(value)));
  assert.ok(setCookies.some((value) => /^hatch_web_csrf=/.test(value) && !/HttpOnly/.test(value)));
  const cookie = setCookies.map((value) => value.split(";", 1)[0]).join("; ");
  const csrf = decodeURIComponent(setCookies.find((value) => value.startsWith("hatch_web_csrf="))
    .split(";", 1)[0]
    .slice("hatch_web_csrf=".length));

  const me = await fetch(`${serverUrl(api)}/v1/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  const account = await me.json();
  assert.equal(account.id, "buyer-cookie");
  assert.equal(account.email, "buyer@example.com", "the web answers /me with the same account shape as Registry");
  assert.equal(account.initials, "CB");

  dashboard.portalState.clock = () => new Date(Date.now() + 31 * 24 * 60 * 60_000);
  const expired = await fetch(`${serverUrl(api)}/v1/auth/me`, { headers: { cookie } });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, "unauthorized");
  dashboard.portalState.clock = () => new Date();

  const listBuyerOrders = dashboard.commerce.listBuyerOrders.bind(dashboard.commerce);
  dashboard.commerce.listBuyerOrders = () => {
    throw new Error("database failed at /Users/private/workspace with token=secret-value");
  };
  const failedRequest = await fetch(`${serverUrl(api)}/v1/user/orders`, {
    headers: { cookie, "x-request-id": "request-safe-error-contract" }
  });
  const failedBody = await failedRequest.json();
  assert.equal(failedRequest.status, 500);
  assert.equal(failedBody.error.code, "internal_error");
  assert.equal(failedBody.request_id, "request-safe-error-contract");
  assert.match(failedBody.error.message, /same request ID/);
  assert.doesNotMatch(JSON.stringify(failedBody), /private|workspace|secret-value|database failed/i);
  dashboard.commerce.listBuyerOrders = listBuyerOrders;

  const rejectedLogout = await fetch(`${serverUrl(api)}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie }
  });
  assert.equal(rejectedLogout.status, 403);
  assert.equal((await rejectedLogout.json()).error.code, "csrf_rejected");

  const logout = await fetch(`${serverUrl(api)}/v1/auth/logout`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf }
  });
  assert.equal(logout.status, 204);
  assert.ok(logout.headers.getSetCookie().every((value) => /Max-Age=0/.test(value)));
});

const cookieMaxAge = (response, name) => Number(response.headers.getSetCookie().find((v) => v.startsWith(`${name}=`))?.match(/Max-Age=(\d+)/)?.[1]);

async function signedInDashboard(context, { registrySession } = {}) {
  const registry = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: "opaque", ...(registrySession ? { session: registrySession } : {}), account: { id: "u1", display_name: "U" } }));
    } else if (request.headers.authorization === "Bearer opaque") {
      response.end(JSON.stringify({ id: "u1", email: "u@example.com", display_name: "U" }));
    } else {
      response.statusCode = 401;
      response.end("{}");
    }
  });
  await listen(registry);
  context.after(() => registry.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-slide-"));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: serverUrl(registry) });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const base = serverUrl(api);
  const login = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "u@example.test", password: "x" }) });
  const cookie = login.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
  const t0 = Date.now();
  const at = (ms) => { dashboard.portalState.clock = () => new Date(t0 + ms); };
  const me = () => fetch(`${base}/v1/auth/me`, { headers: { cookie } });
  const sessionId = decodeURIComponent(cookie.match(/hatch_web_session=([^;]+)/)[1]);
  return { dashboard, login, me, at, t0, sessionId };
}

test("Web session lasts 30 days idle, slides at most hourly, and refreshes the cookie", async (context) => {
  const { login, me, at } = await signedInDashboard(context);
  assert.ok(Math.abs(cookieMaxAge(login, "hatch_web_session") - 30 * 86400) < 5);
  assert.ok(Math.abs(cookieMaxAge(login, "hatch_web_csrf") - 30 * 86400) < 5);

  at(20 * DAY);
  const slid = await me();
  assert.equal(slid.status, 200);
  assert.ok(Math.abs(cookieMaxAge(slid, "hatch_web_session") - 30 * 86400) < 5, "cookie refreshed to a full 30 days");
  assert.ok(Math.abs(cookieMaxAge(slid, "hatch_web_csrf") - 30 * 86400) < 5);

  at(20 * DAY + 30 * 60_000);
  assert.deepEqual((await me()).headers.getSetCookie(), [], "no slide and no cookie within an hour");

  at(49 * DAY);
  assert.equal((await me()).status, 200, "29 days after the slide is still valid");
  at(49 * DAY + 31 * DAY);
  assert.equal((await me()).status, 401, "30 days idle is rejected");
});

test("Web session slide is capped at the Registry session's absolute expiry", async (context) => {
  const { me, at } = await signedInDashboard(context, { registrySession: { expires_at: new Date(Date.now() + 45 * DAY).toISOString() } });
  at(20 * DAY);
  const slid = await me();
  assert.equal(slid.status, 200);
  assert.ok(Math.abs(cookieMaxAge(slid, "hatch_web_session") - 25 * 86400) < 5, "Max-Age stops at the absolute cap");
  at(44 * DAY);
  assert.equal((await me()).status, 200);
  at(46 * DAY);
  assert.equal((await me()).status, 401);
});

test("Concurrent requests slide a web session once", async (context) => {
  const { dashboard, me, at, sessionId } = await signedInDashboard(context);
  at(2 * 60 * 60_000);
  const responses = await Promise.all([me(), me(), me()]);
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal(responses.filter((r) => r.headers.getSetCookie().length > 0).length, 1, "only one request wrote the slide");
  const session = dashboard.portalState.getWebSession(sessionId);
  assert.equal(Date.parse(session.expires_at) - Date.parse(session.last_seen_at), 30 * DAY);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
