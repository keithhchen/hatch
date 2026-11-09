import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Pool } from "pg";
import { CreatorRegistryReleaseStore } from "../creatorLearning/creatorRegistryRelease.js";

/**
 * The IM-to-Chat cell over real processes: the Registry and the Runtime are started as `node dist/...`, on their own
 * ports and their own databases, and a signed platform webhook goes in. Only the outside world is local: the platform
 * is a server that records what we send it (the real Telegram adapter is pointed at it by a preload that rewrites
 * its host), and the model is an OpenAI-compatible server (the Kimi adapter's own localhost test double).
 * Automated integration test. It proves nothing about a real account or a real platform.
 */
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CREATOR_ID = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
const PRODUCT_ID = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const RELEASE_HEX = "b".repeat(64);
const BRIEF_SPEC = { contract_version: "1", fields: [{ id: "goal", label: "What should we achieve?", required: true }] };
const CORPUS_DIGEST =`sha256:${"a".repeat(64)}`;
const TELEGRAM = { token: "e2e-bot-token", username: "hatch_e2e_bot", secret: "e2e-webhook-secret" };
const TOKENS = { runtimeToRegistry: "e2e-runtime-to-registry", registryToRuntime: "e2e-registry-to-runtime" };

const sha = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as net.AddressInfo).port };
}

const body = async (request: http.IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString("utf8"); };

/** Writes the release the Registry will call live, where the Runtime installs it from. */
async function installRelease(corpusRoot: string): Promise<void> {
  const root = path.join(corpusRoot, PRODUCT_ID, RELEASE_HEX);
  const system = "You are the E2E Expert. Answer briefly.";
  await mkdir(path.join(root, "runtime/instructions"), { recursive: true });
  await mkdir(path.join(root, "instructions"), { recursive: true });
  await writeFile(path.join(root, "instructions/system.md"), system);
  await writeFile(path.join(root, "runtime/instructions/system.md"), system);
  await writeFile(path.join(root, "agent.json"), JSON.stringify({
    contract_version: "1", creator: { id: CREATOR_ID, name: "E2E Creator" },
    product: { id: PRODUCT_ID, name: "E2E Expert", promise: "Answers in a test.", brief_spec: BRIEF_SPEC, boundaries: [], presentation: {} },
    instructions: { system: { id: "system", path: "instructions/system.md", sha256: sha(system) } },
    skills: [], knowledge: { documents: [] }, tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: { synthetic_qa: [], held_out: [] }
  }));
  await writeFile(path.join(root, "runtime/manifest.json"), JSON.stringify({
    contract_version: "1", creator: { id: CREATOR_ID }, product: { id: PRODUCT_ID, name: "E2E Expert", promise: "Answers in a test." },
    corpus_digest: CORPUS_DIGEST, system_ref: { path: "runtime/instructions/system.md", sha256: sha(system) }, skills: [], knowledge: [], brief_spec: BRIEF_SPEC
  }));
}

type Spawned = { child: ChildProcess; output: () => string; stop: () => Promise<void> };
function start(entry: string, env: Record<string, string>, args: string[] = []): Spawned {
  let output = "";
  const child = spawn(process.execPath, [...args, path.join(dist, entry)], { cwd: path.resolve(dist, ".."), env: { PATH: process.env.PATH ?? "", DOTENV_CONFIG_PATH: "/dev/null", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const stop = async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await new Promise((resolve) => { child.once("exit", resolve); setTimeout(() => { child.kill("SIGKILL"); resolve(undefined); }, 5_000).unref(); }); } };
  return { child, output: () => output, stop };
}

async function until<T>(what: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30_000, spawned: Spawned[] = []): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe().catch(() => undefined);
    if (found) return found;
    for (const process of spawned) if (process.child.exitCode !== null) throw new Error(`A process exited while waiting for ${what}:\n${process.output().slice(-3000)}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${spawned.map((process) => process.output().slice(-1500)).join("\n---\n")}`);
    await sleep(100);
  }
}

test("a signed platform webhook becomes one Run and one outbound delivery across the real Registry and Runtime processes", { skip: !databaseUrl, timeout: 120_000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-im-chat-e2e-"));
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const names = { registry: `hatch_e2e_registry_${suffix}`, runtime: `hatch_e2e_runtime_${suffix}` };
  const urlFor = (database: string) => { const url = new URL(databaseUrl!); url.pathname = `/${database}`; return url.toString(); };
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  for (const name of Object.values(names)) await admin.query(`CREATE DATABASE "${name}"`);
  const registryPool = new Pool({ connectionString: urlFor(names.registry) });
  const runtimePool = new Pool({ connectionString: urlFor(names.runtime) });
  const spawned: Spawned[] = [];
  const servers: http.Server[] = [];
  context.after(async () => {
    for (const process of spawned.reverse()) await process.stop();
    for (const server of servers) await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
    await registryPool.end();
    await runtimePool.end();
    for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(root, { recursive: true, force: true });
  });

  // The outside world, locally: a platform that records what it is sent, and a model.
  const platformCalls: Array<{ method: string; body: Record<string, any> }> = [];
  const platform = await listen(async (request, response) => {
    const match = request.url?.match(/^\/bot([^/]+)\/(\w+)$/);
    platformCalls.push({ method: match?.[2] ?? request.url ?? "", body: JSON.parse((await body(request)) || "{}") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { message_id: 900 + platformCalls.length } }));
  });
  servers.push(platform.server);
  const modelRequests: string[] = [];
  const model = await listen(async (request, response) => {
    modelRequests.push(await body(request));
    const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 1, model: "kimi-k2.6", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`${chunk({ role: "assistant", content: "pong from the test model" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`);
  });
  servers.push(model.server);

  // Registry's database holds the live release and the Connection; the Runtime installs the release from disk.
  const corpusRoot = path.join(root, "corpora");
  await installRelease(corpusRoot);
  const releases = new CreatorRegistryReleaseStore(registryPool);
  await releases.ensureSchema();
  await releases.publish({
    product_id: PRODUCT_ID, creator_id: CREATOR_ID, release_digest: `sha256:${RELEASE_HEX}`, corpus_digest: CORPUS_DIGEST,
    corpus_ref: `registry/${PRODUCT_ID}/releases/${RELEASE_HEX}/corpus.json`, release_ref: `registry/${PRODUCT_ID}/releases/${RELEASE_HEX}`,
    runtime_manifest_ref: `registry/${PRODUCT_ID}/releases/${RELEASE_HEX}/runtime/manifest.json`, brief_spec: null
  });

  const ports = { registry: await freePort(), runtime: await freePort() };
  assert.ok(ports.registry !== 8100 && ports.runtime !== 8400, "non-default ports");
  // The platform adapter is the real one; only its host is rewritten, so what it sends lands on the local platform.
  const preload = path.join(root, "platform-host.mjs");
  await writeFile(preload, `const real = globalThis.fetch;
globalThis.fetch = (input, init) => { const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return real(url.startsWith("https://api.telegram.org/") ? process.env.E2E_PLATFORM_URL + url.slice("https://api.telegram.org".length) : input, init); };\n`);

  const runtime = start("index.js", {
    PORT: String(ports.runtime), HATCH_RUNTIME_HOST: "127.0.0.1",
    HATCH_RUNTIME_DATABASE_URL: urlFor(names.runtime), HATCH_RUNTIME_DATA_DIR: path.join(root, "runtime-data"), HATCH_RUNTIME_CORPUS_ROOT: corpusRoot,
    HATCH_REGISTRY_URL: `http://127.0.0.1:${ports.registry}`, HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: TOKENS.runtimeToRegistry,
    HATCH_RUNTIME_CHAT_SERVICE_TOKEN: TOKENS.registryToRuntime,
    HATCH_LLM_PROFILE: "kimi-k2.6", LLM_API_KEY: "e2e-model-key", OPENAI_BASE_URL: `http://127.0.0.1:${model.port}/v1`
  });
  const registry = start("registryServer.js", {
    REGISTRY_PORT: String(ports.registry), REGISTRY_HOST: "127.0.0.1",
    HATCH_REGISTRY_DATABASE_URL: urlFor(names.registry), HATCH_AGENT_CORPUS_ROOT: path.join(root, "registry-corpora"), HATCH_CREATOR_FACTORY_ROOT: path.join(root, "factory"),
    HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: TOKENS.runtimeToRegistry,
    HATCH_RUNTIME_CHAT_URL: `http://127.0.0.1:${ports.runtime}`, HATCH_RUNTIME_CHAT_SERVICE_TOKEN: TOKENS.registryToRuntime,
    HATCH_TELEGRAM_BOT_TOKEN: TELEGRAM.token, HATCH_TELEGRAM_BOT_USERNAME: TELEGRAM.username, HATCH_TELEGRAM_WEBHOOK_SECRET: TELEGRAM.secret,
    E2E_PLATFORM_URL: `http://127.0.0.1:${platform.port}`
  }, ["--import", preload]);
  spawned.push(runtime, registry);
  await until("the Registry", async () => (await fetch(`http://127.0.0.1:${ports.registry}/healthz`)).ok, 60_000, spawned);
  await until("the Runtime", async () => (await fetch(`http://127.0.0.1:${ports.runtime}/readyz`)).ok, 60_000, spawned);

  // An org Connection answers with the Product, and one member has been admitted. (Fixture rows: the Connection UI is another workstream.)
  const connectionId = (await registryPool.query(
    "INSERT INTO hatch_connections (owner_account_id, channel, target, target_key, audience) VALUES ($1, 'telegram', $2, $3, 'org') RETURNING id",
    [CREATOR_ID, JSON.stringify({ kind: "product", productId: PRODUCT_ID }), `product:${PRODUCT_ID}`])).rows[0].id as string;
  await registryPool.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, 'telegram', '', '777', '777')", [connectionId]);

  const webhook = (headers: Record<string, string>, update: unknown) => fetch(`http://127.0.0.1:${ports.registry}/v1/channels/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(update) });
  const update = { update_id: 424242, message: { message_id: 5, chat: { id: 777, type: "private" }, from: { id: 777 }, text: "Hello expert" } };
  // An unsigned webhook is refused before it is stored.
  assert.equal((await webhook({}, update)).status, 401);
  assert.equal((await registryPool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 0);

  // The platform delivers the same event twice, as platforms do.
  const signed = { "x-telegram-bot-api-secret-token": TELEGRAM.secret };
  assert.equal((await webhook(signed, update)).status, 200);
  assert.equal((await webhook(signed, update)).status, 200);

  await until("the reply to reach the platform", async () => platformCalls.some((call) => call.method === "sendMessage"), 45_000, spawned);
  await sleep(4_000); // a second Run or a second delivery would show by now
  const sends = platformCalls.filter((call) => call.method === "sendMessage");
  assert.equal(sends.length, 1, "one outbound delivery");
  assert.equal(sends[0]!.body.chat_id, 777);
  assert.equal(sends[0]!.body.text, "pong from the test model");
  assert.equal(sends[0]!.body.reply_parameters.message_id, 5, "it answers the message it was asked");

  assert.equal(modelRequests.length, 1, "the model was called once");
  assert.ok(modelRequests[0]!.includes("Hello expert"));
  const runs = (await runtimePool.query("SELECT id, status FROM hatch_conversation_runs")).rows;
  assert.deepEqual(runs.map((run) => run.status), ["completed"], "one Run");
  assert.equal((await registryPool.query("SELECT count(*)::int AS n FROM hatch_channel_inbox")).rows[0].n, 1, "one event, however often delivered");
  const inbox = (await registryPool.query("SELECT run_id, state FROM hatch_channel_inbox")).rows[0];
  assert.deepEqual([inbox.run_id, inbox.state], [runs[0].id, "done"]);
  const outbox = (await registryPool.query("SELECT state, source_key, connection_id FROM hatch_channel_outbox")).rows;
  assert.deepEqual(outbox.map((row) => [row.state, row.source_key, row.connection_id]), [["sent", `run:${runs[0].id}`, connectionId]]);
});
