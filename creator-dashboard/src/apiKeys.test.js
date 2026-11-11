import assert from "node:assert/strict";
import test from "node:test";
import { ApiKeysClient, dateFormatter, keyRow, sortNewestFirst } from "./apiKeys.js";
import { parseCreatorRoute, creatorRouteTitle } from "./creatorRoutes.js";
import { createCreatorTranslator } from "./creatorI18n.js";

const recorder = (replies) => { const calls = []; const request = async (path, options) => { calls.push([path, options]); return replies.shift(); }; return { calls, request }; };

test("list unwraps api_keys, newest first", async () => {
  const { request, calls } = recorder([{ api_keys: [{ id: "a", created_at: "2026-01-01T00:00:00Z" }, { id: "b", created_at: "2026-02-01T00:00:00Z" }] }]);
  assert.deepEqual((await new ApiKeysClient(request).list()).map((key) => key.id), ["b", "a"]);
  assert.deepEqual(calls, [["/v1/auth/api-keys", undefined]]);
});

test("create posts the trimmed name and returns the one-time token", async () => {
  const { request, calls } = recorder([{ id: "k", name: "cli", token: "hk_secret" }]);
  const created = await new ApiKeysClient(request).create("  cli ");
  assert.equal(created.token, "hk_secret");
  assert.deepEqual(calls[0], ["/v1/auth/api-keys", { method: "POST", body: JSON.stringify({ name: "cli" }) }]);
});

test("revoke deletes by encoded id and surfaces failures", async () => {
  const { request, calls } = recorder([undefined]);
  await new ApiKeysClient(request).revoke("a/b");
  assert.deepEqual(calls[0], ["/v1/auth/api-keys/a%2Fb", { method: "DELETE" }]);
  await assert.rejects(new ApiKeysClient(async () => { throw Object.assign(new Error("nope"), { status: 500 }); }).revoke("x"), /nope/);
});

test("view model shows Never for missing dates and does not mutate input", () => {
  const format = dateFormatter("en", "—");
  const row = keyRow({ id: "a", name: "n", created_at: "2026-03-05T12:00:00Z", last_seen_at: null, expires_at: null }, format, "Never");
  assert.equal(row.lastUsed, "Never");
  assert.equal(row.expires, "Never");
  assert.match(row.created, /2026/);
  assert.equal(format("garbage"), "—");
  const input = [{ created_at: "1" }, { created_at: "2" }];
  sortNewestFirst(input);
  assert.equal(input[0].created_at, "1");
});

test("settings route, the api-keys redirect and copy exist in every locale", () => {
  assert.deepEqual(parseCreatorRoute("/studio/api-keys"), { kind: "redirect", section: "settings", to: "/studio/settings" });
  assert.equal(parseCreatorRoute("/studio/api-keys/x").kind, "not-found");
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/settings")), "Settings");
  for (const locale of ["en", "zh", "ja"]) {
    const t = createCreatorTranslator(locale);
    for (const key of ["sxNavSettings", "sxaReachMe", "sxNavApiKeys", "sxakCreate", "sxakCreatedWarn", "sxakNever", "sxakRevoke", "sxakEmpty"]) assert.notEqual(t(key), key, `${locale}.${key}`);
    assert.match(t("sxakRevokeTitle", "k"), /k/);
  }
});
