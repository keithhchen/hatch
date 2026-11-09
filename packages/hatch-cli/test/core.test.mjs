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

test("interactive login asks which method; choosing API key reads it as a secret", async () => {
  const asked = [];
  const prompter = {
    interactive: true,
    choose: async (question, options) => { asked.push(options.map(([v]) => v)); return "api_key"; },
    secret: async (question) => { asked.push(question); return " key-456 \n"; }
  };
  const { ctx, fetch } = await makeContext({ routes: { "GET /v1/auth/me": ME }, env: { HATCH_WEB_URL: "http://web.test" }, prompter });
  const result = await COMMANDS.find((c) => c.name === "login").run(ctx, { _: [], flags: {} });
  assert.deepEqual(asked[0], ["browser", "api_key"]);
  assert.match(asked[1], /http:\/\/web\.test\/studio\/api-keys/);
  assert.equal(fetch.calls[0].headers.authorization, "Bearer key-456");
  assert.equal(result.kind, "api_key");
});

test("--browser skips the question even in a terminal", async () => {
  const prompter = { interactive: true, choose: async () => { throw new Error("asked"); } };
  let opened = false;
  const { ctx } = await makeContext({
    routes: { "POST /v1/auth/desktop/token": { token: "sess" }, "GET /v1/auth/me": ME }, prompter,
    browser: { open(url) { opened = true; const q = new URL(url).searchParams; fetch(`${q.get("redirect_uri")}?code=C&state=${q.get("state")}`); } }
  });
  const result = await COMMANDS.find((c) => c.name === "login").run(ctx, { _: [], flags: { browser: true } });
  assert.ok(opened);
  assert.equal(result.kind, "session");
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

const run = (ctx, name, args) => COMMANDS.find((c) => c.name === name).run(ctx, args);
const reply = { id: "m4", role: "assistant", text: "Here is the summary.", created_at: "t2" };
const sent = { conversation_id: "s1", message: { id: "u1", role: "user", text: "Summarize", created_at: "t1" }, queued: false };

test("workers lists a product's workers", async () => {
  const workers = [{ id: "research", name: "Deep Research", availability: "available", status: "running" }, { id: "cases", name: "Case Builder", availability: "locked", status: "idle", blocked_by: { missing_required: ["builder"], needs_one_of: [] } }];
  const { ctx, fetch } = await makeContext({ env: { HATCH_API_KEY: "k" }, routes: { "GET /v1/creator/products/p1/workers": { workers } } });
  const result = await run(ctx, "workers", { _: ["p1"], flags: {} });
  assert.deepEqual(result, workers);
  assert.equal(fetch.calls[0].headers.authorization, "Bearer k");
  const text = COMMANDS.find((c) => c.name === "workers").format(result);
  assert.match(text, /research\s+running\s+Deep Research/);
  assert.match(text, /cases\s+locked\s+Case Builder\s+\(needs builder\)/);
});

test("chat without --wait prints the accepted message id; --wait holds 60 s and prints the reply", async () => {
  const { ctx, fetch } = await makeContext({
    env: { HATCH_API_KEY: "k" },
    routes: {
      "POST /v1/creator/products/p1/workers/research/messages": (c) => c.url.includes("wait=60") ? { ...sent, status: "idle", reply } : { ...sent, status: "running" }
    }
  });
  const chat = COMMANDS.find((c) => c.name === "chat");
  const plain = await chat.run(ctx, { _: ["p1", "research", "Summarize", "this"], flags: { key: "k1" } });
  assert.deepEqual(fetch.calls[0].body, { content: "Summarize this", client_message_id: "k1" });
  assert.equal(fetch.calls[0].headers["idempotency-key"], "k1");
  assert.ok(!fetch.calls[0].url.includes("wait"));
  assert.equal(chat.format(plain), "u1");
  const waited = await chat.run(ctx, { _: ["p1", "research", "Summarize"], flags: { wait: true } });
  assert.ok(fetch.calls[1].url.endsWith("/messages?wait=60"));
  assert.equal(chat.format(waited), "Here is the summary.");
  await assert.rejects(chat.run(ctx, { _: ["p1", "research"], flags: {} }), (e) => e.code === "usage");
});

test("chat reports a worker that is still running or failed", async () => {
  const { ctx } = await makeContext({
    env: { HATCH_API_KEY: "k" },
    routes: { "POST /v1/creator/products/p1/workers/research/messages": { ...sent, status: "running" }, "POST /v1/creator/products/p1/workers/builder/messages": { ...sent, status: "failed", error: "model down" } }
  });
  await run(ctx, "chat", { _: ["p1", "research", "x"], flags: { wait: true } });
  assert.match(ctx.stderr.text(), /Still running.*hatch history p1 research/);
  assert.equal(ctx.exitCode, 0);
  await run(ctx, "chat", { _: ["p1", "builder", "x"], flags: {} });
  assert.equal(ctx.exitCode, 1);
});

test("chat surfaces a locked worker as the server's reason", async () => {
  const { ctx } = await makeContext({
    env: { HATCH_API_KEY: "k" },
    routes: { "POST /v1/creator/products/p1/workers/cases/messages": () => json({ error: { code: "worker_unavailable", message: "cases cannot start yet: builder must produce output first." } }, 409) }
  });
  await assert.rejects(run(ctx, "chat", { _: ["p1", "cases", "go"], flags: {} }), (e) => e.status === 409 && e.code === "worker_unavailable" && /builder must produce output/.test(e.message));
});

test("history passes --after and renders the lines; stop posts to the worker", async () => {
  const { ctx, fetch } = await makeContext({
    env: { HATCH_API_KEY: "k" },
    routes: {
      "GET /v1/creator/products/p1/workers/research/messages": { status: "idle", messages: [sent.message, reply] },
      "POST /v1/creator/products/p1/workers/research/stop": { requested: true }
    }
  });
  const history = COMMANDS.find((c) => c.name === "history");
  const result = await history.run(ctx, { _: ["p1", "research"], flags: { after: "m 0" } });
  assert.ok(fetch.calls[0].url.endsWith("/messages?after=m%200"));
  assert.match(history.format(result), /\[u1\] you[\s\S]*Summarize[\s\S]*\[m4\] assistant[\s\S]*Here is the summary\./);
  assert.equal(history.format({ messages: [] }), "No messages.");
  await run(ctx, "stop", { _: ["p1", "research"], flags: {} });
  assert.equal(fetch.calls[1].key, "POST /v1/creator/products/p1/workers/research/stop");
  assert.deepEqual(fetch.calls[1].body, {});
});

test("assistant sends to the account conversation and reads its history", async () => {
  const { ctx, fetch } = await makeContext({
    env: { HATCH_API_KEY: "k" },
    routes: {
      "POST /v1/creator/assistant/conversation/messages": { ...sent, status: "idle", reply },
      "GET /v1/creator/assistant/conversation/messages": { status: "idle", messages: [reply] }
    }
  });
  const result = await run(ctx, "assistant", { _: ["What", "needs", "me?"], flags: { wait: true, key: "k2" } });
  assert.deepEqual(fetch.calls[0].body, { content: "What needs me?", client_message_id: "k2" });
  assert.ok(fetch.calls[0].url.endsWith("/messages?wait=60"));
  assert.equal(result.reply.text, "Here is the summary.");
  await run(ctx, "assistant history", { _: [], flags: { after: "m1" } });
  assert.ok(fetch.calls[1].url.endsWith("/messages?after=m1"));
});

test("MCP wait is in seconds", async () => {
  const send = COMMANDS.find((c) => c.name === "chat").mcp;
  assert.deepEqual(send.toArgs({ product_id: "p1", worker: "research", content: "hi", wait: 90 }), { _: ["p1", "research", "hi"], flags: { wait: 90, key: undefined } });
  const { ctx, fetch } = await makeContext({ env: { HATCH_API_KEY: "k" }, routes: { "POST /v1/creator/products/p1/workers/research/messages": { ...sent, status: "running" } } });
  await run(ctx, "chat", { _: ["p1", "research", "hi"], flags: { wait: 90 } });
  assert.ok(fetch.calls[0].url.endsWith("?wait=90"));
  await run(ctx, "chat", { _: ["p1", "research", "hi"], flags: { wait: 0 } });
  assert.ok(!fetch.calls[1].url.includes("wait"));
});
