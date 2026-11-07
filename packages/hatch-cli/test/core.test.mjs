import assert from "node:assert/strict";
import { stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { challengeFor, createPkce, randomState } from "../src/pkce.js";
import { LoopbackReceiver } from "../src/loopback.js";
import { FileCredentialStore } from "../src/credentialStore.js";
import { HatchClient } from "../src/client.js";
import { CommandRegistry } from "../src/registry.js";
import { COMMANDS } from "../src/commands.js";
import { buildIngestItems, MAX_TOTAL_BYTES } from "../src/ingest.js";
import { json, makeContext, ME } from "./helpers.mjs";

test("PKCE pair: challenge is base64url sha256 of verifier", () => {
  const { verifier, challenge } = createPkce();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge, challengeFor(verifier));
  // RFC 7636 appendix B vector
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.notEqual(randomState(), randomState());
});

test("loopback receiver returns the code when state matches", async () => {
  const receiver = new LoopbackReceiver({ state: "s1" });
  const uri = await receiver.start();
  assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const waiting = receiver.wait();
  const res = await fetch(`${uri}?code=abc&state=s1`);
  assert.equal(res.status, 200);
  assert.equal(await waiting, "abc");
});

test("loopback receiver rejects a state mismatch", async () => {
  const receiver = new LoopbackReceiver({ state: "s1" });
  const uri = await receiver.start();
  const rejected = assert.rejects(receiver.wait(), { code: "state_mismatch" });
  const res = await fetch(`${uri}?code=abc&state=evil`);
  assert.equal(res.status, 400);
  await rejected;
});

test("loopback receiver times out", async () => {
  const receiver = new LoopbackReceiver({ state: "s", timeoutMs: 20 });
  await receiver.start();
  await assert.rejects(receiver.wait(), { code: "login_timeout" });
});

test("credential store: 0600 file, 0700 dir, profile isolation", async () => {
  const { home } = await makeContext();
  const store = FileCredentialStore.atHome(home);
  await store.put("default", { token: "t1", kind: "session" });
  await store.put("work", { token: "t2", kind: "api_key" });
  const file = join(home, ".config", "hatch", "credentials.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(home, ".config", "hatch"))).mode & 0o777, 0o700);
  assert.equal((await store.get("default")).token, "t1");
  assert.equal((await store.get("work")).token, "t2");
  await store.delete("default");
  assert.equal(await store.get("default"), null);
  assert.equal((await store.get("work")).token, "t2");
});

test("HATCH_API_KEY overrides stored credentials", async () => {
  const { ctx } = await makeContext({ env: { HATCH_API_KEY: "envkey", HATCH_API_URL: "http://x.test" } });
  await ctx.store.put("default", { token: "stored", kind: "session", api_url: "http://old.test" });
  const creds = await ctx.credentials();
  assert.deepEqual([creds.token, creds.kind, creds.source, creds.api_url], ["envkey", "api_key", "env", "http://x.test"]);
});

test("client maps 401 to 'run hatch login', and sends bearer + idempotency key", async () => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push(init); return json({ detail: "nope" }, 401); };
  const client = HatchClient.create({ baseUrl: "http://x.test/", fetch: fetchFn, token: "tok-secret" });
  await assert.rejects(client.post("/v1/x", { a: 1 }), (e) => e.status === 401 && /hatch login/.test(e.message) && !e.message.includes("tok-secret"));
  assert.equal(calls[0].headers.authorization, "Bearer tok-secret");
  assert.ok(calls[0].headers["idempotency-key"]);
  await assert.rejects(HatchClient.create({ baseUrl: "http://x.test", fetch: fetchFn }).get("/v1/x"), { code: "not_signed_in" });
  const down = HatchClient.create({ baseUrl: "http://x.test", fetch: async () => { throw new TypeError("fetch failed"); }, token: "t" });
  await assert.rejects(down.get("/"), { code: "network" });
});

test("registry dispatch prefers the longest command name", () => {
  const registry = new CommandRegistry(COMMANDS);
  assert.equal(registry.resolve(["ingest", "status", "p", "j"]).command.name, "ingest status");
  assert.deepEqual(registry.resolve(["ingest", "p", "u"]).rest, ["p", "u"]);
  assert.equal(registry.resolve(["products", "list"]).command.name, "products list");
  assert.equal(registry.resolve(["nope"]), null);
});

test("ingest encodes files as base64 with media type, urls as url items", async () => {
  const { home } = await makeContext();
  await writeFile(join(home, "a.pdf"), "PDFDATA");
  const items = await buildIngestItems(["https://e.com/x", "a.pdf"], { cwd: home });
  assert.deepEqual(items[0], { url: "https://e.com/x" });
  assert.deepEqual(items[1], { name: "a.pdf", content_base64: Buffer.from("PDFDATA").toString("base64"), media_type: "application/pdf" });
  await assert.rejects(buildIngestItems(["missing.txt"], { cwd: home }), { code: "file_not_found" });
  await mkdir(join(home, "d"));
  await assert.rejects(buildIngestItems(["d"], { cwd: home }), { code: "not_a_file" });
});

test("ingest rejects total size over 30 MB before reading", async () => {
  let read = false;
  const fs = { stat: async () => ({ isFile: () => true, size: MAX_TOTAL_BYTES / 2 + 1 }), readFile: async () => { read = true; return Buffer.alloc(0); } };
  await assert.rejects(buildIngestItems(["a.mp4", "b.mp4"], { cwd: "/", fs }), (e) => e.code === "too_large" && /30 MB/.test(e.message));
  assert.equal(read, false);
});

test("login --api-key-stdin verifies with /me and stores an api_key", async () => {
  const { ctx, fetch } = await makeContext({ routes: { "GET /v1/auth/me": ME } });
  ctx.stdin.end("key-123\n");
  const login = COMMANDS.find((c) => c.name === "login");
  const result = await login.run(ctx, { _: [], flags: { "api-key-stdin": true } });
  assert.equal(result.kind, "api_key");
  assert.equal(fetch.calls[0].headers.authorization, "Bearer key-123");
  assert.equal((await ctx.store.get("default")).account.email, "k@example.com");
  assert.ok(!JSON.stringify(result).includes("key-123"));
});

test("browser login: PKCE url, state check, token exchange, save", async () => {
  let opened;
  const routes = {
    "POST /v1/auth/desktop/token": (call) => { exchanged = call.body; return { token: "sess", expires_at: "x" }; },
    "GET /v1/auth/me": ME
  };
  let exchanged;
  const { ctx } = await makeContext({
    routes, env: { HATCH_WEB_URL: "http://web.test" },
    browser: { open(url) { opened = new URL(url); const q = opened.searchParams; fetch(`${q.get("redirect_uri")}?code=C1&state=${q.get("state")}`); } }
  });
  const result = await COMMANDS.find((c) => c.name === "login").run(ctx, { _: [], flags: {} });
  assert.equal(opened.origin + opened.pathname, "http://web.test/desktop/sign-in");
  assert.equal(opened.searchParams.get("client"), "cli");
  assert.equal(opened.searchParams.get("code_challenge"), challengeFor(exchanged.code_verifier));
  assert.equal(exchanged.code, "C1");
  assert.equal(exchanged.redirect_uri, opened.searchParams.get("redirect_uri"));
  assert.equal(result.kind, "session");
  assert.equal((await ctx.store.get("default")).token, "sess");
});

test("logout revokes sessions but only forgets api keys locally", async () => {
  const { ctx, fetch } = await makeContext({ routes: { "POST /v1/auth/logout": {} } });
  const logout = COMMANDS.find((c) => c.name === "logout");
  await ctx.store.put("default", { token: "s", kind: "session", api_url: "http://x.test" });
  await logout.run(ctx, { _: [], flags: {} });
  assert.equal(fetch.calls.length, 1);
  assert.equal(await ctx.store.get("default"), null);
  await ctx.store.put("default", { token: "k", kind: "api_key", api_url: "http://x.test" });
  await logout.run(ctx, { _: [], flags: {} });
  assert.equal(fetch.calls.length, 1);
  assert.equal(await ctx.store.get("default"), null);
});

test("products update merges onto current product; unlist --off relists", async () => {
  const { ctx, fetch } = await makeContext({
    routes: {
      "GET /v1/creator/products/p1": { product: { product_id: "p1", name: "Old", promise: "Prom", updated_at: "t0" } },
      "PATCH /v1/creator/products/p1": (c) => ({ product: { product_id: "p1", ...c.body } }),
      "PUT /v1/creator/products/p1/listing": (c) => ({ product_id: "p1", listed: c.body.listed })
    }
  });
  ctx.env.HATCH_API_KEY = "k";
  await COMMANDS.find((c) => c.name === "products update").run(ctx, { _: ["p1"], flags: { name: "New" } });
  assert.deepEqual(fetch.calls.at(-1).body, { name: "New", promise: "Prom", expected_updated_at: "t0" });
  assert.equal((await COMMANDS.find((c) => c.name === "products unlist").run(ctx, { _: ["p1"], flags: {} })).listed, false);
  assert.equal((await COMMANDS.find((c) => c.name === "products unlist").run(ctx, { _: ["p1"], flags: { off: true } })).listed, true);
});

test("ingest --wait polls until done", async () => {
  let polls = 0;
  const { ctx } = await makeContext({
    env: { HATCH_API_KEY: "k" },
    routes: {
      "POST /v1/creator/products/p1/ingest": (c) => json({ job: { id: "j1", product_id: "p1", status: "queued", items: [] } }, 202),
      "GET /v1/creator/products/p1/ingest/j1": () => ({ job: { id: "j1", product_id: "p1", status: ++polls < 3 ? "running" : "done", items: [{ id: "i", input: "https://e.com", status: "ok" }] } })
    }
  });
  const job = await COMMANDS.find((c) => c.name === "ingest").run(ctx, { _: ["p1", "https://e.com"], flags: { wait: true } });
  assert.equal(job.status, "done");
  assert.equal(polls, 3);
  assert.match(ctx.stderr.text(), /job j1: running/);
});

test("waiting on a job rides out transient server errors but not real ones", async () => {
  const { waitForJob } = await import("../src/ingest.js");
  const { HatchError } = await import("../src/errors.js");
  const replies = [new HatchError("busy", { status: 503 }), { status: "running" }, { status: "done" }];
  const job = await waitForJob(async () => { const r = replies.shift(); if (r instanceof Error) throw r; return r; }, { sleep: async () => {}, intervalMs: 0 });
  assert.equal(job.status, "done");
  await assert.rejects(waitForJob(async () => { throw new HatchError("gone", { status: 404 }); }, { sleep: async () => {}, intervalMs: 0 }), /gone/);
});
