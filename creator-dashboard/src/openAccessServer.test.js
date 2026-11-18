import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createDashboardApp } from "../server.mjs";
import { createGuestTokens } from "../guest.mjs";

// Fake Registry and Runtime upstreams (transport/auth contract tests, never product UAT).
const SECRET = "runtime-secret";
const ORIGIN = "http://dashboard.test";
const PRODUCT = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const CREATOR = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
const ACCOUNT = { id: "buyer-1", email: "buyer@example.test", display_name: "Zero Buyer" };
const guests = createGuestTokens(SECRET);
const listing = { creator_id: CREATOR, creator_name: "Maya", creator_avatar_url: "/avatars/maya.png", agent_id: PRODUCT, product_id: PRODUCT, product_name: "Resume", product_description: "d", product_promise: "p", corpus_digest: "sha256:c", availability: "published" };

const json = (response, status, body) => { response.statusCode = status; response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const urlOf = (server) => `http://127.0.0.1:${server.address().port}`;

async function setup(context, { secret = SECRET, analytics } = {}) {
  const registryCalls = [];
  const runtimeCalls = [];
  const state = { catalogFails: false, claim: { status: 200, body: { product_id: PRODUCT, connection_id: "c1", channel: "telegram" } }, carry: { status: 200, body: { moved: 2 } }, audience: [] };
  const registry = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    registryCalls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
    const route = new URL(request.url, "http://registry.test");
    if (["/v1/auth/signin", "/v1/auth/signup"].includes(route.pathname)) return json(response, 200, { token: "opaque-session", account: ACCOUNT });
    if (route.pathname === "/v1/auth/me") {
      if (request.headers.authorization === "Bearer opaque-session") return json(response, 200, ACCOUNT);
      if (request.headers.authorization === "Bearer creator-token") return json(response, 200, { id: CREATOR, email: "c@example.test", display_name: "Maya" });
      return json(response, 401, { detail: "unauthorized" });
    }
    if (route.pathname === "/v1/internal/creator-accounts") return json(response, 200, { accounts: [{ id: ACCOUNT.id, display_name: ACCOUNT.display_name }] });
    if (route.pathname === "/v1/public/products") return state.catalogFails ? json(response, 500, { detail: "down" }) : json(response, 200, [listing]);
    if (route.pathname === "/v1/channels/im-link/claim") return json(response, state.claim.status, state.claim.body);
    return json(response, 404, { detail: "not found" });
  });
  const runtime = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    runtimeCalls.push({ method: request.method, url: request.url, authorization: request.headers.authorization, origin: request.headers.origin, body });
    if (request.url.startsWith("/v1/creator/audience")) return json(response, 200, { audience: state.audience });
    if (request.url.startsWith(`/v1/products/${PRODUCT}/agent`)) return json(response, 200, { creator_agent: { creator_id: CREATOR, product_id: PRODUCT, creator: { id: CREATOR, name: "Creator" }, product: { id: PRODUCT, name: "Resume" } } });
    if (request.url === "/v1/guest/carry-over") return json(response, state.carry.status, state.carry.body);
    return json(response, 200, { ok: true, url: request.url });
  });
  const runtimeSocket = new WebSocketServer({ server: runtime, path: "/runtime" });
  const hellos = [];
  runtimeSocket.on("connection", (socket) => socket.on("message", (data) => hellos.push(JSON.parse(data.toString()))));
  await Promise.all([listen(registry), listen(runtime)]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-open-access-"));
  const captured = [];
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: urlOf(registry),
    runtimeUrl: urlOf(runtime),
    publicOrigin: ORIGIN,
    registryDeploymentServiceToken: "deploy-secret",
    commerceRuntimeServiceToken: "service-token",
    guestTokenSecret: secret,
    analytics: analytics ?? { capture: (distinctId, event) => captured.push({ distinctId, ...event }), shutdown: async () => {} }
  });
  const api = createServer(dashboard.handler);
  api.on("upgrade", (request, socket, head) => dashboard.handleUpgrade(request, socket, head).catch(() => socket.destroy()));
  await listen(api);
  context.after(() => { api.closeAllConnections(); runtime.closeAllConnections(); registry.closeAllConnections(); api.close(); runtime.close(); registry.close(); runtimeSocket.close(); });
  const base = urlOf(api);
  const login = async () => {
    const response = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ACCOUNT.email, password: "test-only" }) });
    const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
    const csrf = decodeURIComponent(cookies.find((value) => value.startsWith("hatch_web_csrf=")).split("=")[1]);
    return { cookie: cookies.join("; "), csrf };
  };
  return { base, dashboard, registryCalls, runtimeCalls, hellos, state, captured, login, wsUrl: base.replace("http", "ws") + "/v1/web-chat/runtime" };
}

const guestCookieOf = (response) => response.headers.getSetCookie().find((value) => value.startsWith("hatch_guest="));
const tokenIn = (setCookie) => decodeURIComponent(setCookie.split(";", 1)[0].slice("hatch_guest=".length));

test("a visitor with no session chats as a guest: a signed token goes upstream and a cookie is set once", async (context) => {
  const { base, runtimeCalls } = await setup(context);
  const first = await fetch(`${base}/v1/web-chat/conversations?product_id=${PRODUCT}`);
  assert.equal(first.status, 200);
  const setCookie = guestCookieOf(first);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /Max-Age=31536000/);
  assert.doesNotMatch(setCookie, /Secure/);
  const token = tokenIn(setCookie);
  assert.equal(guests.verify(token), true);
  assert.equal(runtimeCalls[0].authorization, `Bearer ${token}`);
  assert.equal(runtimeCalls[0].url, `/v1/conversations?product_id=${PRODUCT}`);

  const second = await fetch(`${base}/v1/web-chat/conversations`, { headers: { cookie: `hatch_guest=${encodeURIComponent(token)}` } });
  assert.equal(second.status, 200);
  assert.equal(guestCookieOf(second), undefined, "a valid cookie is not minted again");
  assert.equal(runtimeCalls[1].authorization, `Bearer ${token}`);

  const secure = await fetch(`${base}/v1/web-chat/conversations`, { headers: { "x-forwarded-proto": "https" } });
  assert.match(guestCookieOf(secure), /; Secure/);
});

test("a tampered guest cookie is treated as absent and replaced", async (context) => {
  const { base, runtimeCalls } = await setup(context);
  const good = guests.mint();
  for (const bad of [`${good}x`, "hatch_guest.AAAAAAAAAAAAAAAAAAAAAA.nope", "junk", guestsOther().mint()]) {
    const response = await fetch(`${base}/v1/web-chat/conversations`, { headers: { cookie: `hatch_guest=${encodeURIComponent(bad)}` } });
    const minted = tokenIn(guestCookieOf(response));
    assert.notEqual(minted, bad);
    assert.equal(guests.verify(minted), true);
    assert.equal(runtimeCalls.at(-1).authorization, `Bearer ${minted}`);
  }
});
const guestsOther = () => createGuestTokens("another-secret");

test("a web session wins over a guest cookie", async (context) => {
  const { base, runtimeCalls, login } = await setup(context);
  const { cookie } = await login();
  const response = await fetch(`${base}/v1/web-chat/conversations`, { headers: { cookie: `${cookie}; hatch_guest=${encodeURIComponent(guests.mint())}` } });
  assert.equal(response.status, 200);
  assert.equal(guestCookieOf(response), undefined);
  assert.equal(runtimeCalls[0].authorization, "Bearer opaque-session");
});

test("a guest's writes need an allowed Origin, a session's still need CSRF", async (context) => {
  const { base, runtimeCalls, login } = await setup(context);
  const post = (headers) => fetch(`${base}/v1/web-chat/conversations?product_id=${PRODUCT}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  for (const headers of [{}, { origin: "https://evil.example" }]) {
    const refused = await post(headers);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error.code, "origin_not_allowed");
  }
  assert.equal(runtimeCalls.length, 0);
  const allowed = await post({ origin: ORIGIN });
  assert.equal(allowed.status, 200);
  assert.ok(guests.verify(runtimeCalls[0].authorization.slice("Bearer ".length)));
  const { cookie } = await login();
  assert.equal((await post({ cookie })).status, 403, "a session without CSRF is refused even with no Origin");
});

test("guest chat is unavailable, not silently faked, without the guest signing secret", async (context) => {
  const { base, runtimeCalls } = await setup(context, { secret: "" });
  const response = await fetch(`${base}/v1/web-chat/conversations`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "guest_unavailable");
  assert.equal(runtimeCalls.length, 0);
});

test("the Agent of a product is proxied for sessions and guests", async (context) => {
  const { base, runtimeCalls } = await setup(context);
  const response = await fetch(`${base}/v1/web-chat/products/${PRODUCT}/agent`);
  assert.equal(response.status, 200);
  assert.equal(runtimeCalls[0].url, `/v1/products/${PRODUCT}/agent`);
  assert.ok(guests.verify(runtimeCalls[0].authorization.slice("Bearer ".length)));
});

const connect = (url, headers = {}) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, { headers });
  const upgrade = {};
  socket.once("upgrade", (response) => { upgrade.headers = response.headers; });
  socket.once("open", () => resolve({ socket, upgrade }));
  socket.once("error", reject);
});

test("the chat socket carries a guest token upstream and keeps the cookie it mints", async (context) => {
  const { wsUrl, hellos } = await setup(context);
  const { socket, upgrade } = await connect(wsUrl, { origin: ORIGIN });
  const minted = tokenIn(upgrade.headers["set-cookie"][0]);
  socket.send(JSON.stringify({ type: "client.hello", protocol_version: "0.8", product_id: PRODUCT, local_tools: [] }));
  await waitFor(() => hellos.length === 1);
  assert.equal(hellos[0].auth_token, minted);
  assert.equal(hellos[0].product_id, PRODUCT);
  socket.close();

  const again = await connect(wsUrl, { origin: ORIGIN, cookie: `hatch_guest=${encodeURIComponent(minted)}` });
  assert.equal(again.upgrade.headers["set-cookie"], undefined);
  again.socket.send(JSON.stringify({ type: "client.hello", protocol_version: "0.8", product_id: PRODUCT, local_tools: [] }));
  await waitFor(() => hellos.length === 2);
  assert.equal(hellos[1].auth_token, minted);
  again.socket.close();

  const refused = await connect(wsUrl, { origin: "https://evil.example" }).then(() => "open", () => "refused");
  assert.equal(refused, "refused");
});

test("the chat socket refuses a hello that names an entitlement", async (context) => {
  const { wsUrl, hellos } = await setup(context);
  const { socket } = await connect(wsUrl, { origin: ORIGIN });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.send(JSON.stringify({ type: "client.hello", protocol_version: "0.8", entitlement_id: "e1", local_tools: [] }));
  assert.equal(await closed, 1008);
  assert.equal(hellos.length, 0);
});

async function waitFor(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(condition(), "timed out");
}

test("carry-over moves the guest's conversations to the session and clears the cookie only on success", async (context) => {
  const { base, runtimeCalls, state, login, captured } = await setup(context);
  const { cookie, csrf } = await login();
  const guest = guests.mint();
  const carry = (headers) => fetch(`${base}/v1/web-chat/guest/carry-over`, { method: "POST", headers, body: "{}" });
  const guestCookie = `hatch_guest=${encodeURIComponent(guest)}`;

  assert.equal((await carry({ cookie: guestCookie })).status, 401, "needs a web session");
  assert.equal((await carry({ cookie: `${cookie}; ${guestCookie}` })).status, 403, "needs CSRF");
  assert.equal(runtimeCalls.length, 0);

  const none = await carry({ cookie, "x-csrf-token": csrf });
  assert.equal(none.status, 200);
  assert.equal((await none.json()).moved, 0);
  assert.equal((await carry({ cookie: `${cookie}; hatch_guest=junk`, "x-csrf-token": csrf })).status, 200);
  assert.equal(runtimeCalls.length, 0, "no guest cookie, no Runtime call");

  state.carry = { status: 502, body: { error: { code: "library_unavailable", message: "down" } } };
  const failed = await carry({ cookie: `${cookie}; ${guestCookie}`, "x-csrf-token": csrf });
  assert.equal(failed.status, 502);
  assert.equal((await failed.json()).error.code, "library_unavailable");
  assert.equal(failed.headers.getSetCookie().find((value) => value.startsWith("hatch_guest=")), undefined, "a failure keeps the cookie");
  assert.deepEqual(captured.filter((entry) => entry.event === "guest_signed_in_carried_over"), []);

  state.carry = { status: 200, body: { moved: 2 } };
  const done = await carry({ cookie: `${cookie}; ${guestCookie}`, "x-csrf-token": csrf });
  assert.equal(done.status, 200);
  assert.equal((await done.json()).moved, 2);
  assert.match(guestCookieOf(done), /^hatch_guest=;.*Max-Age=0/);
  const call = runtimeCalls.at(-1);
  assert.equal(call.url, "/v1/guest/carry-over");
  assert.equal(call.authorization, "Bearer opaque-session");
  assert.deepEqual(JSON.parse(call.body), { guest_token: guest });
  assert.deepEqual(captured.filter((entry) => entry.event === "guest_signed_in_carried_over"), [{ distinctId: ACCOUNT.id, event: "guest_signed_in_carried_over", properties: { moved: 2 } }]);
});

test("claiming an IM link claims first, then saves the Agent to the library; a failed save can be retried", async (context) => {
  const { base, registryCalls, state, login, dashboard } = await setup(context);
  const { cookie, csrf } = await login();
  const claim = (body = { token: "link-token" }, headers = { cookie, "x-csrf-token": csrf }) => fetch(`${base}/v1/im-link/claim`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const entitlements = () => dashboard.commerce.listBuyerEntitlements(ACCOUNT.id).filter((entry) => entry.status === "active" && entry.product_id === PRODUCT);
  const claims = () => registryCalls.filter((call) => call.url === "/v1/channels/im-link/claim");

  assert.equal((await claim({ token: "x" }, {})).status, 401);
  assert.equal((await claim({ token: "x" }, { cookie })).status, 403);
  assert.equal((await claim({})).status, 400);
  assert.equal(claims().length, 0);

  state.catalogFails = true;
  const unavailable = await claim();
  assert.equal(unavailable.status, 502);
  assert.equal((await unavailable.json()).error.code, "library_unavailable");
  assert.equal(claims().length, 1, "the claim ran before the save");
  assert.equal(claims()[0].authorization, "Bearer opaque-session");
  assert.deepEqual(JSON.parse(claims()[0].body), { token: "link-token" });
  assert.equal(entitlements().length, 0);

  state.catalogFails = false;
  const retried = await claim();
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).product_id, PRODUCT);
  assert.equal(entitlements().length, 1);
  assert.equal(claims().length, 2);

  assert.equal((await claim()).status, 200, "a replay is safe");
  assert.equal(entitlements().length, 1);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "entitlement.granted").length, 1);

  for (const [status, code] of [[410, "im_link_expired"], [409, "im_already_linked"], [400, "im_link_invalid"], [503, "im_link_unavailable"]]) {
    state.claim = { status, body: { error: { code, message: code } } };
    const failed = await claim();
    assert.equal(failed.status, status);
    assert.equal((await failed.json()).error.code, code);
  }
});

test("Creator users come from the Runtime audience with display names and no account ids", async (context) => {
  const { base, runtimeCalls, state } = await setup(context);
  state.audience = [
    { product_id: PRODUCT, kind: "account", account_id: ACCOUNT.id, conversations: 2, messages: 9, first_at: "2026-11-01T00:00:00Z", last_at: "2026-11-02T00:00:00Z" },
    { product_id: PRODUCT, kind: "account", account_id: "unnamed-account", conversations: 1, messages: 1, first_at: "2026-11-01T00:00:00Z", last_at: "2026-11-01T00:00:00Z" },
    { product_id: PRODUCT, kind: "guest", conversations: 1, messages: 3, first_at: "2026-11-03T00:00:00Z", last_at: "2026-11-03T00:00:00Z" },
    { product_id: PRODUCT, kind: "im", conversations: 1, messages: 2, first_at: "2026-11-04T00:00:00Z", last_at: "2026-11-04T00:00:00Z" }
  ];
  assert.equal((await fetch(`${base}/v1/creator/users`)).status, 401);
  const response = await fetch(`${base}/v1/creator/users?product_id=${PRODUCT}&ignored=1`, { headers: { authorization: "Bearer creator-token" } });
  assert.equal(response.status, 200);
  const { users } = await response.json();
  assert.deepEqual(users.map((user) => [user.kind, user.display_name]), [["account", "Zero Buyer"], ["account", undefined], ["guest", undefined], ["im", undefined]]);
  assert.deepEqual(users[0], { kind: "account", display_name: "Zero Buyer", product_id: PRODUCT, conversations: 2, messages: 9, first_at: "2026-11-01T00:00:00Z", last_at: "2026-11-02T00:00:00Z" });
  assert.doesNotMatch(JSON.stringify(users), /account_id|buyer-1|unnamed-account/);
  const audience = runtimeCalls.at(-1);
  assert.equal(audience.authorization, "Bearer creator-token");
  assert.equal(audience.url, `/v1/creator/audience?product_id=${PRODUCT}`);
});

test("the purchase surface is gone", async (context) => {
  const { base, login } = await setup(context);
  const { cookie, csrf } = await login();
  const headers = { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
  for (const [method, route] of [
    ["POST", "/v1/checkout-sessions"], ["GET", "/v1/checkout-sessions/x"], ["POST", "/v1/checkout-sessions/x/confirm"], ["POST", "/v1/user/checkout"],
    ["GET", "/v1/orders"], ["GET", "/v1/user/orders"], ["GET", "/v1/orders/x"], ["POST", "/v1/user/orders/x/refund-requests"], ["POST", "/v1/orders/x/cancel"],
    ["GET", "/v1/creator/orders"], ["GET", "/v1/creator/orders/export"], ["GET", "/v1/creator/orders/x"], ["POST", "/v1/creator/orders/x/refund-requests"],
    ["GET", "/v1/buyer/entitlements/x"], ["GET", "/v1/user/entitlements/x"], ["POST", "/v1/user/products/x/access"]
  ]) {
    const response = await fetch(`${base}${route}`, { method, headers, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, 404, `${method} ${route}`);
  }
});

test("signing in or up with a guest cookie carries the guest's conversations over in the same response", async (context) => {
  const { base, runtimeCalls, state } = await setup(context);
  const guestCookie = `hatch_guest=${encodeURIComponent(guests.mint())}`;
  const post = (path, cookie) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email: ACCOUNT.email, password: "test-only", display_name: "T" }) });

  for (const path of ["/v1/auth/login", "/v1/auth/signup"]) {
    runtimeCalls.length = 0;
    state.carry = { status: 200, body: { moved: 2 } };
    const done = await post(path, guestCookie);
    assert.ok(done.ok, path);
    assert.equal(runtimeCalls.length, 1, `${path} moves the guest once`);
    assert.equal(runtimeCalls[0].url, "/v1/guest/carry-over");
    assert.equal(runtimeCalls[0].authorization, "Bearer opaque-session");
    assert.match(guestCookieOf(done), /^hatch_guest=;.*Max-Age=0/, `${path} clears the guest cookie`);
    assert.ok(done.headers.getSetCookie().some((value) => value.startsWith("hatch_web_session=")), `${path} still sets the session`);

    runtimeCalls.length = 0;
    assert.equal(guestCookieOf(await post(path)), undefined);
    assert.equal(runtimeCalls.length, 0, "no guest cookie, no Runtime call");
  }

  runtimeCalls.length = 0;
  state.carry = { status: 502, body: { error: { code: "library_unavailable", message: "down" } } };
  const failed = await post("/v1/auth/login", guestCookie);
  assert.equal(failed.status, 200, "a failed carry-over does not fail the sign-in");
  assert.equal(guestCookieOf(failed), undefined, "and keeps the cookie for the page to retry");
});

test("the Agent endpoint shows the expert's account name and avatar, not the corpus placeholder, for a guest and a signed-in visitor", async (context) => {
  const { base, state, login } = await setup(context);
  const { cookie } = await login();
  for (const headers of [{}, { cookie }]) {
    const body = await (await fetch(`${base}/v1/web-chat/products/${PRODUCT}/agent?product_id=${PRODUCT}`, { headers })).json();
    assert.deepEqual(body.creator_agent.creator, { id: CREATOR, name: "Maya", avatar_url: "/avatars/maya.png" });
    assert.equal(body.creator_agent.product.name, "Resume");
  }
  state.catalogFails = true;
  const fallback = await (await fetch(`${base}/v1/web-chat/products/${PRODUCT}/agent?product_id=${PRODUCT}`)).json();
  assert.equal(fallback.creator_agent.creator.name, "Creator", "a catalog outage leaves the Runtime answer as it is");
});
