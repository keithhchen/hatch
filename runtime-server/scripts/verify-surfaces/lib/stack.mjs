import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { Edge } from "./edge.mjs";
import { FakePlatform, hostRewritePreload } from "./fakePlatform.mjs";
import { ManagedProcess, PostgresCluster, makeRoot, removeRoot } from "./processes.mjs";
import { freePort, sha, sleep, until } from "./util.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dist = path.join(serverRoot, "dist");
const PLATFORM_HOSTS = ["api.telegram.org", "open.feishu.cn", "open.larksuite.com", "qyapi.weixin.qq.com", "api.line.me", "slack.com"];
export const TELEGRAM = { token: "verify-bot-token", username: "hatch_verify_bot", secret: "verify-webhook-secret" };
export const BROWSER_ORIGIN = "http://studio.verify.local";
const TOKENS = { runtimeToRegistry: "verify-runtime-to-registry", registryToRuntime: "verify-registry-to-runtime" };
const CREDENTIALS_KEY = "verify-credentials-key";

/**
 * VERIFICATION TOOL ONLY. An isolated local stack of the real product: throwaway Postgres 16, the real `dist/registryServer.js`
 * and `dist/index.js` (one or more Runtime instances), a path-routing edge standing where Caddy stands, and a fake platform.
 * Named, ported and stored on its own, it can never touch a real Hatch bundle, data directory, credential or service.
 */
export class Stack {
  /** options: { name, llmProfile, runtimeEnv, registryEnv } */
  constructor(options = {}) {
    this.options = { name: "surfaces", llmProfile: "gemini-api", runtimeEnv: {}, registryEnv: {}, ...options };
    this.runtimes = [];
    this.products = new Map();
    this.accounts = [];
  }

  static async start(options = {}) { const stack = new Stack(options); try { await stack.up(); } catch (error) { await stack.down().catch(() => undefined); throw error; } return stack; }

  async up() {
    this.root = makeRoot(this.options.name);
    this.cluster = await PostgresCluster.start(this.root);
    this.admin = new pg.Pool({ connectionString: this.cluster.url(), max: 2 });
    this.dbNames = { registry: "verify_registry", runtime: "verify_runtime" };
    for (const name of Object.values(this.dbNames)) await this.admin.query(`CREATE DATABASE "${name}"`);
    this.registryPool = new pg.Pool({ connectionString: this.cluster.url(this.dbNames.registry), max: 4 });
    this.runtimePool = new pg.Pool({ connectionString: this.cluster.url(this.dbNames.runtime), max: 4 });
    this.platform = await new FakePlatform().start();
    this.edge = await new Edge().start();
    this.corpusRoot = path.join(this.root, "corpora");
    this.dataDir = path.join(this.root, "runtime-data");
    this.preload = path.join(this.root, "platform-host.mjs");
    await writeFile(this.preload, hostRewritePreload(PLATFORM_HOSTS));
    this.registryPort = await freePort();
    this.edge.setRegistry(this.registryPort);
    await this.startRegistry();
    const first = await this.startRuntime();
    return first;
  }

  get url() { return this.edge.url; }
  get registryUrl() { return `http://127.0.0.1:${this.registryPort}`; }
  secrets() {
    const env = {};
    for (const name of ["GEMINI_API_KEY", "LLM_API_KEY"]) if (process.env[name]) env[name] = process.env[name];
    return env;
  }

  runtimeEnv(port) {
    return {
      PATH: process.env.PATH ?? "", NODE_ENV: "development", ...this.secrets(),
      PORT: String(port), HATCH_RUNTIME_HOST: "127.0.0.1",
      HATCH_RUNTIME_DATABASE_URL: this.cluster.url(this.dbNames.runtime), HATCH_RUNTIME_DATA_DIR: this.dataDir, HATCH_RUNTIME_CORPUS_ROOT: this.corpusRoot,
      HATCH_REGISTRY_URL: this.registryUrl, HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: TOKENS.runtimeToRegistry, HATCH_RUNTIME_CHAT_SERVICE_TOKEN: TOKENS.registryToRuntime,
      HATCH_LLM_PROFILE: this.options.llmProfile, HATCH_WEB_SEARCH_URL: `${this.platform.url}/search`, HATCH_WEB_SEARCH_PROVIDER: "",
      HATCH_RUNTIME_ALLOWED_ORIGINS: BROWSER_ORIGIN,
      HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_USER: "40", HATCH_RUNTIME_MAX_ACTIVE_RUNS_GLOBAL: "80", HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS: "80", HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS_PER_USER: "40",
      ...this.options.runtimeEnv
    };
  }

  async startRuntime(extraEnv = {}) {
    const port = await freePort();
    const proc = new ManagedProcess(`runtime:${port}`, process.execPath, [...(this.options.runtimeNodeArgs ?? []), path.join(dist, "index.js")], { cwd: serverRoot, env: { ...this.runtimeEnv(port), ...extraEnv } });
    const instance = { port, proc, id: `runtime-${this.runtimes.length + 1}` };
    this.runtimes.push(instance);
    await until(`${instance.id} ready`, async () => { if (!proc.alive) throw new Error(`runtime exited:\n${proc.tail(3000)}`); return (await fetch(`http://127.0.0.1:${port}/readyz`)).ok; }, { timeoutMs: 90_000 }).catch((error) => { throw new Error(`${error.message}\n${proc.tail(3000)}`); });
    this.edge.setRuntimes(this.runtimes.filter((r) => r.proc.alive).map((r) => r.port));
    return instance;
  }

  /** `kill -9` the instance and take it out of the edge. */
  async killRuntime(instance) { await instance.proc.kill9(); this.edge.setRuntimes(this.runtimes.filter((r) => r.proc.alive).map((r) => r.port)); }
  async stopRuntime(instance) { await instance.proc.stop(); this.edge.setRuntimes(this.runtimes.filter((r) => r.proc.alive).map((r) => r.port)); }
  liveRuntimes() { return this.runtimes.filter((r) => r.proc.alive); }

  async startRegistry(extraEnv = {}) {
    const env = {
      PATH: process.env.PATH ?? "", NODE_ENV: "development", ...this.secrets(),
      REGISTRY_PORT: String(this.registryPort), REGISTRY_HOST: "127.0.0.1",
      HATCH_REGISTRY_DATABASE_URL: this.cluster.url(this.dbNames.registry), HATCH_AGENT_CORPUS_ROOT: path.join(this.root, "registry-corpora"), HATCH_CREATOR_FACTORY_ROOT: path.join(this.root, "factory"),
      HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: TOKENS.runtimeToRegistry, HATCH_RUNTIME_CHAT_URL: this.edge.url, HATCH_RUNTIME_CHAT_SERVICE_TOKEN: TOKENS.registryToRuntime,
      HATCH_TELEGRAM_BOT_TOKEN: TELEGRAM.token, HATCH_TELEGRAM_BOT_USERNAME: TELEGRAM.username, HATCH_TELEGRAM_WEBHOOK_SECRET: TELEGRAM.secret,
      HATCH_CREDENTIALS_KEY: CREDENTIALS_KEY, HATCH_STUDIO_ASSISTANT_URL: `${BROWSER_ORIGIN}/studio/assistant`,
      HATCH_FACTORY_LLM_PROFILE: this.options.llmProfile, VERIFY_PLATFORM_URL: this.platform.url, ...this.options.registryEnv, ...extraEnv
    };
    this.registry = new ManagedProcess("registry", process.execPath, ["--import", this.preload, path.join(dist, "registryServer.js")], { cwd: serverRoot, env });
    await until("the Registry", async () => { if (!this.registry.alive) throw new Error(`registry exited:\n${this.registry.tail(3000)}`); return (await fetch(`${this.registryUrl}/healthz`)).ok; }, { timeoutMs: 90_000 });
    return this.registry;
  }
  async killRegistry() { await this.registry.kill9(); }

  async down() {
    for (const instance of this.runtimes.reverse()) await instance.proc.stop().catch(() => undefined);
    await this.registry?.stop().catch(() => undefined);
    await this.edge?.stop().catch(() => undefined);
    await this.platform?.stop().catch(() => undefined);
    await this.registryPool?.end().catch(() => undefined);
    await this.runtimePool?.end().catch(() => undefined);
    await this.admin?.end().catch(() => undefined);
    await this.cluster?.stop();
    if (this.root) removeRoot(this.root);
  }

  // ── Accounts: created through the real Registry sign-up route ───────────

  /** A local test account. Returns its id, a browser-style session token and an API key (both Bearer tokens on the wire). */
  async account(label = "user") {
    const email = `${label}-${randomUUID().slice(0, 8)}@verify.local`;
    const response = await fetch(`${this.registryUrl}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Verify-Pass-123!", display_name: label }) });
    const body = await response.json();
    if (response.status !== 201) throw new Error(`signup failed: ${response.status} ${JSON.stringify(body)}`);
    const session = body.token ?? body.session_token ?? body.access_token ?? body.session?.token;
    const id = body.account?.id ?? body.user?.id ?? body.account_id;
    const keyResponse = await fetch(`${this.registryUrl}/v1/auth/api-keys`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${session}` }, body: JSON.stringify({ name: `verify-${label}` }) });
    const key = await keyResponse.json();
    const account = { id, email, session, apiKey: key.token };
    if (!id || !session || !account.apiKey) throw new Error(`unexpected sign-up shape: ${Object.keys(body)} / ${Object.keys(key)}`);
    this.accounts.push(account);
    return account;
  }

  // ── A published Expert Product. Setup writes the release the way the repository's own e2e does; the factory is not exercised. ──

  async product(creator, { name = "Verify Expert", system = "You are the Verify Expert. Answer briefly and directly.", tools = [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }], brief = { contract_version: "1", fields: [{ id: "goal", label: "What should we achieve?", required: false }] } } = {}) {
    const { CreatorRegistryReleaseStore } = await import(pathToFileURL(path.join(dist, "creatorLearning/creatorRegistryRelease.js")).href);
    const productId = randomUUID();
    const releaseHex = (await import("node:crypto")).createHash("sha256").update(`${productId}:${system}`).digest("hex");
    const corpusDigest = `sha256:${"a".repeat(64)}`;
    const root = path.join(this.corpusRoot, productId, releaseHex);
    await mkdir(path.join(root, "runtime/instructions"), { recursive: true });
    await mkdir(path.join(root, "instructions"), { recursive: true });
    await writeFile(path.join(root, "instructions/system.md"), system);
    await writeFile(path.join(root, "runtime/instructions/system.md"), system);
    await writeFile(path.join(root, "agent.json"), JSON.stringify({
      contract_version: "1", creator: { id: creator.id, name: "Verify Creator" },
      product: { id: productId, name, promise: "Answers during a verification run.", brief_spec: brief, boundaries: [], presentation: {} },
      instructions: { system: { id: "system", path: "instructions/system.md", sha256: sha(system) } },
      skills: [], knowledge: { documents: [] }, tools, evaluations: { synthetic_qa: [], held_out: [] }
    }));
    await writeFile(path.join(root, "runtime/manifest.json"), JSON.stringify({
      contract_version: "1", creator: { id: creator.id }, product: { id: productId, name, promise: "Answers during a verification run." },
      corpus_digest: corpusDigest, system_ref: { path: "runtime/instructions/system.md", sha256: sha(system) }, skills: [], knowledge: [], brief_spec: brief
    }));
    const releases = new CreatorRegistryReleaseStore(this.registryPool);
    await releases.ensureSchema();
    await releases.publish({
      product_id: productId, creator_id: creator.id, release_digest: `sha256:${releaseHex}`, corpus_digest: corpusDigest,
      corpus_ref: `registry/${productId}/releases/${releaseHex}/corpus.json`, release_ref: `registry/${productId}/releases/${releaseHex}`,
      runtime_manifest_ref: `registry/${productId}/releases/${releaseHex}/runtime/manifest.json`, brief_spec: null
    });
    this.products.set(productId, { id: productId, creatorId: creator.id });
    return productId;
  }

  // ── Connections. There is no product API to create org or public Connections yet, so setup inserts the rows (as the repository's e2e does). ──

  async connection({ owner, channel = "telegram", audience, productId, scope = "" }) {
    const target = productId ? { kind: "product", productId } : { kind: "assistant" };
    const key = productId ? `product:${productId}` : "assistant";
    const row = await this.registryPool.query(
      "INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (owner_account_id, channel, audience, target_key) DO UPDATE SET state = 'active' RETURNING id",
      [owner.id, channel, scope, JSON.stringify(target), key, audience]);
    return row.rows[0].id;
  }
  /** The deep-link payload a public Connection exposes in its API record (`start_code`): t.me/<bot>?start=<code>. */
  async startCode(connectionId) { return (await this.registryPool.query("SELECT start_code FROM hatch_connections WHERE id = $1", [connectionId])).rows[0].start_code; }
  async admit(connectionId, { channel = "telegram", senderId, threadId = senderId, scope = "" }) {
    await this.registryPool.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", [connectionId, channel, scope, senderId, threadId]);
  }

  async inboxRows() { return (await this.registryPool.query("SELECT id, event_id, state, run_id, attempts FROM hatch_channel_inbox ORDER BY received_at NULLS LAST, id")).rows; }
  async outboxRows() { return (await this.registryPool.query("SELECT id, state, source_key, kind, sent_parts, attempts, last_error, thread_id FROM hatch_channel_outbox ORDER BY seq")).rows; }
  async runs() { return (await this.runtimePool.query("SELECT * FROM hatch_conversation_runs ORDER BY created_at")).rows; }
}

export { sleep };
