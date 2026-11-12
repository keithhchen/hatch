import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";
import { UsageClient, formatTokens, usageView } from "./usage.js";
import { createCreatorTranslator } from "./creatorI18n.js";

// A report of the shape Registry returns. It exists only in this test file.
const fixture = {
  month_to_date: { studio: 1200, chat_api: 300, chat_web: 500, total: 2000 },
  cap: { monthly_tokens: 4000 },
  daily: [
    { day: "2026-11-11", studio: 0, chat_api: 0, chat_web: 0 },
    { day: "2026-11-12", studio: 1000, chat_api: 0, chat_web: 500 },
    { day: "2026-11-13", studio: 200, chat_api: 300, chat_web: 0 }
  ]
};

test("the client reads the Expert's usage from the dashboard route", async () => {
  const calls = [];
  assert.equal(await new UsageClient(async (path) => { calls.push(path); return fixture; }).get(), fixture);
  assert.deepEqual(calls, ["/v1/creator/usage"]);
});

test("the view has per-surface totals, bars scaled to the busiest day and cap progress", () => {
  const view = usageView(fixture);
  assert.equal(view.total, 2000);
  assert.deepEqual(view.surfaces, [{ surface: "studio", tokens: 1200 }, { surface: "chat_api", tokens: 300 }, { surface: "chat_web", tokens: 500 }]);
  assert.equal(view.busiest, 1500);
  assert.deepEqual(view.days.map((day) => day.total), [0, 1500, 500]);
  assert.deepEqual(view.cap, { limit: 4000, used: 2000, ratio: 0.5, over: false });
  assert.equal(view.empty, false);
});

test("no cap hides the bar, nothing spent is the empty state, a spent cap says so", () => {
  assert.equal(usageView({ ...fixture, cap: { monthly_tokens: null } }).cap, null);
  const none = usageView({ month_to_date: { studio: 0, chat_api: 0, chat_web: 0, total: 0 }, cap: { monthly_tokens: null }, daily: [{ day: "2026-11-13", studio: 0, chat_api: 0, chat_web: 0 }] });
  assert.equal(none.empty, true);
  assert.equal(usageView({ ...fixture, cap: { monthly_tokens: 1500 } }).cap.over, true);
  assert.equal(usageView({ ...fixture, cap: { monthly_tokens: 1500 } }).cap.ratio, 1);
});

test("token counts read in the viewer's locale", () => {
  assert.equal(formatTokens("en", 1234), "1,234");
  assert.match(formatTokens("zh", 2_500_000), /250/);
  assert.match(formatTokens("ja", 2_500_000), /250/);
});

test("the Usage section copy exists in every locale and Settings renders the section", async () => {
  for (const locale of ["en", "zh", "ja"]) {
    const t = createCreatorTranslator(locale);
    for (const key of ["sxUsage", "sxuMonth", "sxuStudio", "sxuChatApi", "sxuChatWeb", "sxuDaily", "sxuCap", "sxuEmpty"]) assert.notEqual(t(key), key, `${locale}.${key}`);
    assert.match(t("sxuCapOf", "1", "2"), /1.*2/);
  }
  assert.equal(createCreatorTranslator("en")("sxUsage"), "Usage");
  assert.equal(createCreatorTranslator("zh")("sxUsage"), "用量");
  assert.equal(createCreatorTranslator("ja")("sxUsage"), "使用量");
  assert.match(await readFile(new URL("./SettingsPage.jsx", import.meta.url), "utf8"), /<UsageSection /);
});

test("the dashboard proxies the Expert's usage to Registry with their own session, query included", async (context) => {
  const seen = [];
  const registry = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.test");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/v1/auth/signin") return response.end(JSON.stringify({ token: "expert-token", account: { id: "expert", email: "e@example.test", display_name: "E" } }));
    if (url.pathname === "/v1/auth/me") return response.end(JSON.stringify({ id: "expert", email: "e@example.test", display_name: "E" }));
    if (url.pathname === "/v1/creator/usage") { seen.push({ search: url.search, authorization: request.headers.authorization }); return response.end(JSON.stringify(fixture)); }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
  context.after(() => registry.close());
  const directory = path.join(path.dirname(new URL(import.meta.url).pathname), "../.local-uat", `usage-proxy-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const dashboard = await createDashboardApp({ ledgerPath: path.join(directory, "ledger.jsonl"), registryUrl: `http://127.0.0.1:${registry.address().port}` });
  const api = createServer(dashboard.handler);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  context.after(() => api.close());
  const base = `http://127.0.0.1:${api.address().port}`;

  assert.equal((await fetch(`${base}/v1/creator/usage`)).status, 401);
  const login = await fetch(`${base}/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "e@example.test", password: "test-only" }) });
  const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
  const response = await fetch(`${base}/v1/creator/usage?from=2026-11-11&to=2026-11-13`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const { request_id: _requestId, ...body } = await response.json();
  assert.deepEqual(body, fixture);
  assert.deepEqual(seen, [{ search: "?from=2026-11-11&to=2026-11-13", authorization: "Bearer expert-token" }]);
});
