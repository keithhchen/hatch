import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import type { RunContext } from "../agentRuntime.js";
import { PiAgentRuntime } from "../piAgentRuntime.js";
import type { RunStart } from "../protocol.js";
import { createRegistryServerFromEnvironment } from "../registryServer.js";
import { InMemoryUsageLedger } from "./memoryUsage.js";
import { attributeByScope, monthlyTokenCap, studioAttribution, usageReport, usageSink, type UsageEvent, type UsageRecorder } from "./usage.js";

const event = (overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id: "call-1", accountId: "acct", surface: "chat_web", model: "m", inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5, at: new Date("2026-11-10T12:00:00Z"), ...overrides
});
const piUsage = (overrides: Partial<Usage> = {}): Usage => ({ input: 60, output: 20, cacheRead: 40, cacheWrite: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, ...overrides });

test("the same call recorded twice counts once", async () => {
  const ledger = new InMemoryUsageLedger();
  await ledger.record(event());
  await ledger.record(event());
  const month = await ledger.monthToDate("acct", new Date("2026-11-13T00:00:00Z"));
  assert.deepEqual(month.chat_web, { input: 100, cachedInput: 40, output: 20, reasoning: 5 });
});

test("month to date sums the month's days per surface and leaves other months and accounts out", async () => {
  const ledger = new InMemoryUsageLedger();
  await ledger.record(event({ id: "a" }));
  await ledger.record(event({ id: "b", surface: "studio_web", at: new Date("2026-11-02T00:00:00Z") }));
  await ledger.record(event({ id: "c", at: new Date("2026-10-31T23:59:59Z") }));
  await ledger.record(event({ id: "d", accountId: "other" }));
  const month = await ledger.monthToDate("acct", new Date("2026-11-13T00:00:00Z"));
  assert.equal(month.chat_web.input, 100);
  assert.equal(month.studio_web.input, 100);
  assert.equal(month.responses_api.input, 0);
});

test("a model call becomes one event: input counts the cached prompt, attribution rides along", async () => {
  const seen: UsageEvent[] = [];
  const sink = usageSink({ record: async (next) => { seen.push(next); } }, { accountId: "acct", surface: "responses_api", apiKeyId: "key_1", productId: "p", runId: "run_1" }, { error() {} });
  await sink({ id: "run_1:7", model: "kimi", usage: piUsage({ cacheWrite: 10, reasoning: 8 }) });
  assert.deepEqual(seen, [{ id: "run_1:7", accountId: "acct", surface: "responses_api", apiKeyId: "key_1", productId: "p", runId: "run_1", model: "kimi", inputTokens: 110, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 8 }]);
});

test("a scope that names no surface is web chat; one that names the API and a key is attributed to both", () => {
  assert.deepEqual(attributeByScope({ creatorId: "c", productId: "p" }, { id: "r" }), { accountId: "c", surface: "chat_web", productId: "p", runId: "r" });
  assert.deepEqual(attributeByScope({ creatorId: "c", productId: "p", usageSurface: "responses_api", apiKeyId: "k" }, { id: "r" }), { accountId: "c", surface: "responses_api", productId: "p", runId: "r", apiKeyId: "k" });
});

test("a recorder that fails never fails the run: the error is logged with the run id", async () => {
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  const failing: UsageRecorder = { record: async () => { throw new Error("db down"); } };
  const sink = usageSink(failing, { accountId: "acct", surface: "chat_web", runId: "run_9" }, { error: (name, fields) => { logged.push([name, fields]); } });
  const usage = piUsage();

  // The pi runtime awaits the sink when a model call ends; the Run goes on.
  const runtime = new PiAgentRuntime({ toolDefinitions: [] });
  const handleEvent = Reflect.get(runtime, "handleEvent") as (options: unknown) => Promise<void>;
  const finals: unknown[] = [];
  await Reflect.apply(handleEvent, runtime, [{
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], api: "openai-completions", provider: "p", model: "kimi", usage, stopReason: "stop", timestamp: 42 } },
    input: { type: "client.message", run_id: "run_9", conversation_id: "c", message: { role: "user", content: "hi" } } as RunStart,
    ctx: { usage: sink } as unknown as RunContext,
    queue: { push() {} }, toolEvents: new Map(), openThinking: new Set(), transcriptMessages: [],
    getActiveSkills: () => [], setActiveSkills() {}, getResourceRoots: () => [], setHasExecutedTool() {},
    setFinalAssistant: (message: unknown) => finals.push(message), setTerminalError() { assert.fail("the run must not fail"); }, setHandedOver() {}, handedOver: () => false
  }]);
  assert.equal(finals.length, 1);
  assert.equal(logged[0]?.[0], "usage_record_failed");
  assert.equal(logged[0]?.[1]?.run_id, "run_9");
});

test("the pi runtime records each completed model call once, keyed by run and message time", async () => {
  const ledger = new InMemoryUsageLedger();
  const sink = usageSink(ledger, { accountId: "acct", surface: "studio_web", runId: "run_1" }, { error() {} });
  const runtime = new PiAgentRuntime({ toolDefinitions: [] });
  const handleEvent = Reflect.get(runtime, "handleEvent") as (options: unknown) => Promise<void>;
  const end = (timestamp: number) => Reflect.apply(handleEvent, runtime, [{
    event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "p", model: "kimi", usage: piUsage(), stopReason: "stop", timestamp } },
    input: { type: "client.message", run_id: "run_1", conversation_id: "c", message: { role: "user", content: "hi" } } as RunStart,
    ctx: { usage: sink } as unknown as RunContext,
    queue: { push() {} }, toolEvents: new Map(), openThinking: new Set(), transcriptMessages: [],
    getActiveSkills: () => [], setActiveSkills() {}, getResourceRoots: () => [], setHasExecutedTool() {},
    setFinalAssistant() {}, setTerminalError() {}, setHandedOver() {}, handedOver: () => false
  }]);
  await end(1); await end(1); await end(2);
  assert.equal((await ledger.monthToDate("acct")).studio_web.output, 40);
});

test("the report has the dashboard's shape: tokens are input + output, every day present, the cap passed through", async () => {
  const ledger = new InMemoryUsageLedger();
  await ledger.record(event({ id: "a", surface: "studio_web", at: new Date("2026-11-12T00:00:00Z") }));
  await ledger.record(event({ id: "b", surface: "responses_api", at: new Date("2026-11-13T00:00:00Z"), inputTokens: 10, outputTokens: 5 }));
  await ledger.record(event({ id: "c", surface: "studio_api", at: new Date("2026-11-13T00:00:00Z"), inputTokens: 1, outputTokens: 1 }));
  const report = await usageReport(ledger, "acct", "2026-11-11", "2026-11-13", 1000, new Date("2026-11-13T08:00:00Z"));
  assert.deepEqual(report.month_to_date, { studio_web: 120, studio_api: 2, chat_web: 0, responses_api: 15, total: 137, split: report.month_to_date.split });
  assert.deepEqual(report.month_to_date.split.studio_web, { input: 100, cachedInput: 40, output: 20, reasoning: 5 });
  assert.deepEqual(report.cap, { monthly_tokens: 1000, remaining_tokens: 863 });
  assert.deepEqual(report.daily, [
    { day: "2026-11-11", studio_web: 0, studio_api: 0, chat_web: 0, responses_api: 0 },
    { day: "2026-11-12", studio_web: 120, studio_api: 0, chat_web: 0, responses_api: 0 },
    { day: "2026-11-13", studio_web: 0, studio_api: 2, chat_web: 0, responses_api: 15 }
  ]);
  assert.equal((await usageReport(ledger, "nobody", "2026-11-11", "2026-11-11", null)).cap.monthly_tokens, null);
});

test("Studio work is Studio API when an API key made the request, and Studio web otherwise", () => {
  assert.deepEqual(studioAttribution("c", undefined, { productId: "p", runId: "r" }), { accountId: "c", surface: "studio_web", productId: "p", runId: "r" });
  assert.deepEqual(studioAttribution("c", "key_1", { productId: "p" }), { accountId: "c", surface: "studio_api", apiKeyId: "key_1", productId: "p" });
});

test("the monthly cap is a positive integer or nothing", () => {
  assert.equal(monthlyTokenCap({}), null);
  assert.equal(monthlyTokenCap({ HATCH_MONTHLY_TOKEN_CAP: " 5000000 " }), 5_000_000);
  for (const bad of ["", "0", "-1", "1.5", "lots"]) assert.equal(monthlyTokenCap({ HATCH_MONTHLY_TOKEN_CAP: bad }), null);
});

test("GET /v1/creator/usage answers the signed-in Expert from the ledger, and only an interactive session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-usage-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1", REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"), HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret", DASHSCOPE_API_KEY: "", HATCH_MONTHLY_TOKEN_CAP: "2000000"
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "usage@example.com", password: "password123", display_name: "Usage" }) });
    const token = (await signup.json() as { session: { token: string } }).session.token;
    const get = (query: string, bearer?: string) => fetch(`${base}/v1/creator/usage${query}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

    assert.equal((await get("")).status, 401);
    const response = await get("", token);
    assert.equal(response.status, 200);
    const body = await response.json() as { month_to_date: Record<string, unknown>; cap: unknown; daily: Array<Record<string, unknown>> };
    assert.deepEqual(Object.keys(body).sort(), ["cap", "daily", "month_to_date"]);
    assert.deepEqual(body.cap, { monthly_tokens: 2_000_000, remaining_tokens: 2_000_000 });
    assert.equal(body.month_to_date.total, 0);
    assert.equal(body.daily.length, 30);
    assert.deepEqual(Object.keys(body.daily[0]!).sort(), ["chat_web", "day", "responses_api", "studio_api", "studio_web"]);
    assert.equal((await get("?from=2026-11-05&to=2026-11-01", token)).status, 400);
    assert.equal((await get("?from=garbage", token)).status, 400);
    assert.equal(((await (await get("?from=2026-11-01&to=2026-11-03", token)).json()) as { daily: unknown[] }).daily.length, 3);
  } finally {
    await registry.close();
  }
});
