import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { AccessCodes } from "../accessCodes/accessCodes.js";
import { AUDIT_SPEC, MemoryAccessCodes, PRODUCT, gateOver } from "../accessGate.testkit.js";
import { ACCESS_CODE_CAPABILITY, AccessGate } from "../accessGate.js";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import type { AgentCorpus, AgentCorpusResolver, AgentCorpusResolverLike } from "../agentCorpus.js";
import { DELIVERABLE_FOLLOWUP_PREFIX } from "../chat/deliverableFollowup.js";
import { ChatService, RunRegistry } from "../chat/chatService.js";
import { RunEventHub } from "../chat/runEventHub.js";
import { RunTerminator } from "../chat/runTerminator.js";
import { InMemoryConversationRepository } from "../conversationRepository.js";
import { createRuntimeServer, type RuntimeServer } from "../index.js";
import { clientMessageInputDigest } from "../protocol.js";
import { RuntimeStore, LocalRuntimeAuthority } from "../store.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresAccessCodes } from "../accessCodes/postgresAccessCodes.js";
import { endingOf } from "../testSupport.js";
import { CodePages, codeConversationId, codeIntakeKey } from "./codePages.js";
import { handleCodePageRoute } from "./routes.js";

const CODE = "MSC123456";
const answers = { name: "A", phone: "13800000000", email: "a@b.co", website: "example.com" };
const PROGRESS = { steps: [
  { id: "fetch", label: "抓取网站", tools: ["fetch_url"] }, { id: "speed", label: "测速", tools: ["page_speed"] },
  { id: "write", label: "撰写报告", tools: ["write"] }, { id: "publish", label: "发布", tools: ["publish_html"] }
] };

async function setup(options: { capable?: boolean; codes?: Pick<AccessCodes, "redeem" | "lookup"> } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-code-pages-"));
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await writeFile(path.join(root, "runtime", "progress.json"), JSON.stringify(PROGRESS));
  const resolved = { root, digest: "corpus", corpus: { creator: { id: "creator" }, product: { id: PRODUCT, name: "外贸官网获客诊断", brief_spec: AUDIT_SPEC } } };
  const corpora = { resolveByProduct: async () => resolved } as unknown as AgentCorpusResolverLike;
  const repository = new InMemoryConversationRepository(new LocalRuntimeAuthority());
  const hub = new RunEventHub();
  const service = new ChatService<object>({
    repository, terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: () => undefined, executorId: "exec", holdsConversation: () => false, steered: () => undefined },
    hub, admission: { reserve: () => () => undefined }, registry: new RunRegistry<object>()
  });
  const codes = new MemoryAccessCodes({
    MSC123456: { status: "active", productId: PRODUCT, conversationId: null },
    MSC000002: { status: "pending", productId: PRODUCT, conversationId: null },
    MSC000009: { status: "active", productId: "another-product", conversationId: null }
  });
  const world = { report: undefined as string | undefined, tools: [] as string[] };
  const pages = new CodePages({
    priceFen: 990,
    gate: gateOver(options.codes ?? codes, options.capable !== false), corpora, repository,
    store: { readRunActivity: async () => ({ tool_calls: world.tools.map((name) => ({ name })) }) } as never,
    reportUrl: async () => world.report,
    start: async (conversation, key) => service.submit({
      principal: { kind: "account", accountId: conversation.ownerAccountId } as never, conversation, scope: {}, client: { client: "web" },
      clientMessageId: key, message: async () => ({ role: "user", content: "start", kind: "task_start" }),
      digest: clientMessageInputDigest({ content: "", task_start: true }), runId: `run-${key}`, corpusDigest: "corpus", requiresLocalTools: false
    })
  });
  const conversationOf = (code: string) => repository.findOwnedConversation({ ownerAccountId: `code:${code}`, creatorId: "creator" }, codeConversationId(code));
  return { pages, codes, repository, world, conversationOf };
}

test("entry: no code, an unknown code, an unpaid code, and the code of a Product without the capability all get the entry", async () => {
  const { pages } = await setup();
  assert.deepEqual(await pages.status("MSC999999"), { state: "entry", reason: "not_found" });
  assert.deepEqual(await pages.status("MSC000002"), { state: "entry", reason: "not_paid" });
  assert.deepEqual(await pages.status("MSC000009"), { state: "entry", reason: "not_found" }); // another Product, never gated
  const ungated = await setup({ capable: false });
  assert.deepEqual(await ungated.pages.status(CODE), { state: "entry", reason: "not_found" });
  await assert.rejects(ungated.pages.intake(CODE, answers), /兑换码不存在/);
  assert.equal(ungated.codes.rows[CODE]!.status, "active", "nothing was spent");
});

test("landing: the product page reads the Product's name and the configured price", async () => {
  const { pages } = await setup();
  assert.deepEqual(await pages.landing(PRODUCT), { product: { id: PRODUCT, name: "外贸官网获客诊断" }, price_fen: 990 });
});

test("intake: an active code gets the Brief's fields, without the code itself", async () => {
  const { pages } = await setup();
  const status = await pages.status(CODE.toLowerCase());
  assert.equal(status.state, "intake");
  assert.deepEqual(status.fields?.map((field) => field.id), ["name", "phone", "email", "website", "markets"]);
  assert.equal(status.fields?.find((field) => field.id === "markets")?.required, false);
});

test("intake submit: the code is spent and the Run starts, once, even for a double submit", async () => {
  const { pages, codes, repository, conversationOf } = await setup();
  const [first, second] = await Promise.all([pages.intake(CODE, answers), pages.intake(CODE, answers)]);
  await pages.intake(CODE, answers);
  assert.equal(first.state, "generating");
  assert.equal(second.state, "generating");
  const conversation = (await conversationOf(CODE))!;
  assert.equal(codes.rows[CODE]!.conversationId, conversation.id, "the code is spent for the conversation it started");
  assert.equal(conversation.briefSnapshot?.fields.find((field) => field.id === "code")?.value, CODE, "the Brief carries the page's own code");
  const runs = await repository.listRuns(conversation.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.clientMessageId, codeIntakeKey(CODE));
});

test("intake submit with a required answer missing spends nothing and starts nothing", async () => {
  const { pages, codes, conversationOf } = await setup();
  await assert.rejects(pages.intake(CODE, { ...answers, website: "" }), (error: { code?: string }) => error.code === "invalid_brief");
  assert.equal(codes.rows[CODE]!.status, "active");
  assert.equal(await conversationOf(CODE), undefined);
});

test("generating: the steps come from the Product's own map and the tools the Run really called", async () => {
  const { pages, world } = await setup();
  await pages.intake(CODE, answers);
  let status = await pages.status(CODE);
  assert.deepEqual(status.steps?.map((step) => step.label), ["抓取网站", "测速", "撰写报告", "发布"]);
  assert.equal(status.step, -1, "nothing done yet: no invented progress");
  world.tools = ["fetch_url", "bash"];
  assert.equal((await pages.status(CODE)).step, 0);
  world.tools = ["fetch_url", "page_speed", "write"];
  status = await pages.status(CODE);
  assert.equal(status.state, "generating");
  assert.equal(status.step, 2);
});

test("ready: a published report gives its link", async () => {
  const { pages, world } = await setup();
  await pages.intake(CODE, answers);
  world.report = "https://gethatchapp.com/html/abc?t=sig";
  assert.deepEqual(await pages.status(CODE), { state: "ready", product: { id: PRODUCT, name: "外贸官网获客诊断" }, report_url: world.report });
});

test("failed: a failed Run, or no report after the follow-ups, is a plain failure", async () => {
  const { pages, repository, conversationOf } = await setup();
  await pages.intake(CODE, answers);
  const conversation = (await conversationOf(CODE))!;
  const [run] = await repository.listRuns(conversation.id);
  await repository.endRun(run!.id, endingOf("failed", "model down"));
  assert.equal((await pages.status(CODE)).state, "failed");

  const capped = await setup();
  await capped.pages.intake(CODE, answers);
  const cappedConversation = (await capped.conversationOf(CODE))!;
  const [first] = await capped.repository.listRuns(cappedConversation.id);
  await capped.repository.endRun(first!.id, endingOf("completed"));
  for (const n of [1, 2]) {
    const { run } = await capped.repository.acceptSubmission({
      binding: { ownerAccountId: cappedConversation.ownerAccountId, creatorId: "creator", agentId: PRODUCT, productId: PRODUCT, corpusDigest: "corpus" },
      run: { id: `run-z${n}`, conversationId: cappedConversation.id, clientMessageId: `${DELIVERABLE_FOLLOWUP_PREFIX}${n}`, inputDigest: `d${n}`, corpusDigest: "corpus", executorId: "exec" },
      canonicalUser: { role: "user", content: "publish it" }
    });
    await capped.repository.endRun(run.id, endingOf("completed"));
  }
  assert.equal((await capped.pages.status(CODE)).state, "failed");
});

test("scoped by code: a wrong code, or another code, sees nothing of this conversation", async () => {
  const { pages, codes } = await setup();
  codes.rows.MSC555555 = { status: "active", productId: PRODUCT, conversationId: null };
  await pages.intake(CODE, answers);
  const other = await pages.status("MSC555555");
  assert.equal(other.state, "intake", "another active code is its own page, not this one's report");
  assert.equal(other.report_url, undefined);
  assert.deepEqual(await pages.status("MSC000000"), { state: "entry", reason: "not_found" });
});

test("a client that guesses codes is stopped by the limiter's 429", async () => {
  const server = await listenRoute(async (req, res, url) => {
    const { MemoryAttemptLimiter, rateLimitedAccessCodes } = await import("../accessCodes/rateLimit.js");
    const real = new MemoryAccessCodes({});
    limiter ??= new MemoryAttemptLimiter(2);
    const gate = new AccessGate(new InMemoryProductCapabilities([[PRODUCT, ACCESS_CODE_CAPABILITY]]), (headers) => rateLimitedAccessCodes(real as never, limiter!, String(headers?.["x-real-ip"])));
    await handleCodePageRoute(req, res, url, new CodePages({ gate, corpora: {} as never, repository: {} as never, store: {} as never, reportUrl: async () => undefined, start: async () => undefined }));
  });
  let limiter: import("../accessCodes/rateLimit.js").MemoryAttemptLimiter | undefined;
  const get = (code: string) => fetch(`${server}/v1/codes/${code}`, { headers: { "x-real-ip": "203.0.113.7" } });
  assert.equal((await get("MSC000001")).status, 200);
  assert.equal((await get("MSC000002")).status, 200);
  const blocked = await get("MSC000003");
  assert.equal(blocked.status, 429);
  assert.equal(((await blocked.json()) as { error: { message: string } }).error.message, "尝试次数过多，请稍后再试");
});

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
async function listenRoute(handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void>): Promise<string> {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => void handler(req, res, new URL(req.url!, "http://x")).catch(() => { res.statusCode = 500; res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// The chat of a Product with an access code is closed to its buyers; every other Product keeps its chat as ever.
let runtime: RuntimeServer | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });
test("a Product with the access code capability has no conversations for its buyers; one without it is untouched", async () => {
  const GATED = PRODUCT, OPEN = "33333333-3333-4333-8333-333333333333";
  const corpus = async () => ({
    root: "", digest: `sha256:${"b".repeat(64)}`,
    corpus: { agent_id: GATED, creator: { id: "22222222-2222-4222-8222-222222222222", name: "Expert" }, product: { id: GATED, name: "Audit", boundaries: [], presentation: {} }, knowledge: { documents: [] }, tools: [] } as unknown as AgentCorpus
  });
  const corpusFor = async (productId: string) => { const c = await corpus(); return { ...c, corpus: { ...c.corpus, agent_id: productId, product: { ...c.corpus.product, id: productId } } }; };
  runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(await mkdtemp(path.join(os.tmpdir(), "hatch-code-gate-"))),
    authIdentityResolver: { resolveIdentity: async (token) => token ? { sub: `user-${token}` } : undefined },
    agentCorpusResolver: { resolve: async (_c: string, id: string) => corpusFor(id), resolveByProduct: corpusFor } as unknown as AgentCorpusResolver,
    accessGate: new AccessGate(new InMemoryProductCapabilities([[GATED, ACCESS_CODE_CAPABILITY]]))
  });
  await new Promise<void>((resolve) => (runtime!.server as http.Server).listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${((runtime.server as http.Server).address() as { port: number }).port}`;
  const call = async (productId: string, method: "GET" | "POST") => {
    const response = await fetch(`${base}/v1/conversations?product_id=${productId}`, { method, headers: { authorization: "Bearer a", ...(method === "POST" ? { "content-type": "application/json" } : {}) }, body: method === "POST" ? JSON.stringify({ client_request_id: "k" }) : undefined });
    return { status: response.status, body: await response.json() as { error?: { code: string } } };
  };
  for (const method of ["GET", "POST"] as const) {
    const refused = await call(GATED, method);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error?.code, "access_code_required");
  }
  assert.equal((await call(OPEN, "POST")).status, 201);
  assert.equal((await call(OPEN, "GET")).status, 200);
});

// Opt-in, against the real adapter: every run owns a random schema of HATCH_TEST_DATABASE_URL.
test("the real Postgres adapter: a double submit spends the paid code once and starts one Run", { skip: !process.env.HATCH_TEST_DATABASE_URL }, async () => {
  const schema = `codepages_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.HATCH_TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: process.env.HATCH_TEST_DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  try {
    const real = new PostgresAccessCodes(pool, 990);
    await real.initialize();
    const { code, outTradeNo } = await real.createPending({ productId: PRODUCT, email: "a@b.co" });
    const { pages, repository, conversationOf } = await setup({ codes: real });
    assert.deepEqual(await pages.status(code), { state: "entry", reason: "not_paid" });
    await real.activatePaid({ outTradeNo, transactionId: "tx1", amountFen: 990 });
    assert.equal((await pages.status(code)).state, "intake");
    await Promise.all([pages.intake(code, answers), pages.intake(code, answers), pages.intake(code, answers)]);
    const conversation = (await conversationOf(code))!;
    assert.equal((await real.lookup(code))?.status, "used");
    assert.equal((await real.lookup(code))?.conversationId, conversation.id);
    assert.equal((await repository.listRuns(conversation.id)).length, 1);
    assert.equal((await pages.status(code)).state, "generating");
  } finally { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
});
