import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

async function setup(context) {
  const calls = [];
  const registry = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ url: request.url, body: raw ? JSON.parse(raw) : undefined });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/auth/telegram") return response.end(JSON.stringify({ enabled: true }));
    if (request.url === "/v1/auth/telegram/start") return response.end(JSON.stringify({ authorize_url: "https://oauth.telegram.org/auth?x=1", state: "state-1" }));
    if (request.url === "/v1/auth/telegram/callback") {
      return response.end(JSON.stringify({ token: "registry-token", account: { id: "tg-1", display_name: "Tg User", email: null }, created: true, return_to: "/studio/assistant" }));
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: "not_found", message: "no" } }));
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  context.after(() => registry.close());
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-tg-"));
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: `http://127.0.0.1:${registry.address().port}` });
  const api = createServer(dashboard.handler);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  context.after(() => api.close());
  return { calls, base: `http://127.0.0.1:${api.address().port}` };
}

const get = (url, headers) => fetch(url, { redirect: "manual", headers });

test("Telegram login reports availability from the Registry", async (context) => {
  const { base } = await setup(context);
  assert.equal((await (await get(`${base}/v1/auth/telegram`)).json()).enabled, true);
});

test("Telegram start sets the state cookie, redirects to Telegram and rejects unsafe returnTo", async (context) => {
  const { base, calls } = await setup(context);
  const response = await get(`${base}/v1/auth/telegram/start?returnTo=%2Fstudio`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://oauth.telegram.org/auth?x=1");
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^hatch_tg_state=state-1;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Path=\/v1\/auth\/telegram/);
  assert.equal(calls.at(-1).body.return_to, "/studio");

  await get(`${base}/v1/auth/telegram/start?returnTo=%2F%2Fevil.com`);
  assert.equal(calls.at(-1).body.return_to, "/");
});

test("Telegram callback needs the matching state cookie before calling the Registry", async (context) => {
  const { base, calls } = await setup(context);
  for (const headers of [undefined, { cookie: "hatch_tg_state=other" }]) {
    const response = await get(`${base}/v1/auth/telegram/callback?code=c&state=state-1`, headers);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/sign-in?telegram=failed");
  }
  assert.equal(calls.some((call) => call.url === "/v1/auth/telegram/callback"), false);
});

test("Telegram callback creates the web session and redirects to return_to", async (context) => {
  const { base } = await setup(context);
  const response = await get(`${base}/v1/auth/telegram/callback?code=c&state=state-1`, { cookie: "hatch_tg_state=state-1" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/studio/assistant");
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((value) => /^hatch_web_session=/.test(value) && /HttpOnly/.test(value)));
  assert.ok(cookies.some((value) => /^hatch_tg_state=;.*Max-Age=0/.test(value)));
});
