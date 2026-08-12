import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

test("Browser auth uses an HttpOnly session cookie and rejects missing CSRF", async (context) => {
  const registry = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/auth/signin") {
      response.end(JSON.stringify({
        token: "opaque-registry-session",
        account: { id: "buyer-cookie", role: "user", display_name: "Cookie Buyer" }
      }));
      return;
    }
    if (request.url === "/v1/auth/me" && request.headers.authorization === "Bearer opaque-registry-session") {
      response.end(JSON.stringify({ id: "buyer-cookie", role: "user", display_name: "Cookie Buyer" }));
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
  assert.equal((await me.json()).id, "buyer-cookie");

  dashboard.portalState.clock = () => new Date(Date.now() + 13 * 60 * 60_000);
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

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
