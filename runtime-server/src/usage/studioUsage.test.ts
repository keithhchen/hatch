import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import { CreatorFactory } from "../creatorLearning/engine.js";
import { createFactoryLlmPromptRunner } from "../creatorLearning/factoryLlm.js";
import { FactoryNodeService } from "../creatorLearning/nodeService.js";
import { LocalArtifactObjectStore } from "../creatorLearning/objectStore.js";
import { InMemoryCreatorFactoryRepository } from "../creatorLearning/repository.js";
import { CreatorFactoryService } from "../creatorLearning/service.js";
import type { FactoryPromptCall, FactoryStartInput } from "../creatorLearning/types.js";
import { CreatorFactoryWorker } from "../creatorLearning/worker.js";
import { MemoryIngestJobs } from "../ingest/jobs.js";
import { UnavailableEngine } from "../ingest/engines.js";
import { IngestService } from "../ingest/service.js";
import { InMemoryUsageLedger } from "./memoryUsage.js";
import { scopeOfConversation } from "../assistant/chat.js";
import { bindContext, runInContext } from "../observability/context.js";
import { attributeByScope, usageSink, type UsageEvent } from "./usage.js";
import { USAGE_CAP_EXCEEDED, UsageCap } from "./usageCap.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const quiet = { error: () => undefined };

/** The memory ledger that also remembers every event it was asked to record. */
class CapturingLedger extends InMemoryUsageLedger {
  readonly events: UsageEvent[] = [];
  override async record(event: UsageEvent): Promise<void> { this.events.push(event); await super.record(event); }
}

const usage = (input: number, output: number): Usage => ({
  input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
} as Usage);

/** A ledger already holding `tokens` of this month's Studio usage, and a cap of one token. */
async function spentMonth(accountId: string) {
  const ledger = new CapturingLedger();
  await ledger.record({ id: "spent", accountId, surface: "studio_web", model: "m", inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  return new UsageCap(ledger, 1);
}

test("the Factory prompt runner reports each model call, and the ledger counts a retried write once", async () => {
  const ledger = new CapturingLedger();
  const sink = usageSink(ledger, { accountId: CREATOR, surface: "studio_web", productId: PRODUCT, runId: "run-1" }, quiet);
  const runner = createFactoryLlmPromptRunner({
    env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", DEEPSEEK_API_KEY: "test" },
    fetch: async () => new Response(`${[
      { id: "c", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
        { index: 0, id: "a", type: "function", function: { name: "submit_evidence_section", arguments: JSON.stringify({ section: "Product evidence", markdown: "E" }) } },
        { index: 1, id: "b", type: "function", function: { name: "finalize_evidence", arguments: "{}" } }
      ] }, finish_reason: null }] },
      { id: "c", object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } }
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
  });
  const call = { purpose: "evidence.extract" as const, systemPrompt: "s", prompt: "p", outputContract: { kind: "evidence_ledger" as const, requiredSections: ["Product evidence"] }, onModelCall: sink };
  await runner(call);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0]!.id, "0");
  assert.equal(ledger.events[0]!.model, "deepseek-v4-flash");
  assert.deepEqual((await ledger.monthToDate(CREATOR)).studio_web, { input: 8, cachedInput: 0, output: 2, reasoning: 0 });
  // The same call written again (a retry of the write) changes nothing.
  await sink({ id: "0", model: "deepseek-v4-flash", usage: usage(8, 2) });
  assert.deepEqual((await ledger.monthToDate(CREATOR)).studio_web, { input: 8, cachedInput: 0, output: 2, reasoning: 0 });
});

test("a Factory run's model calls are the owning Expert's Studio usage, per run and product", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-studio-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const input: FactoryStartInput = {
    runId: "run-usage", creator: { id: CREATOR, name: "Expert" }, productId: PRODUCT, productName: "P", productPromise: "Promise.",
    sources: [{ id: "S1", authority: "creator_current", title: "Method", content: "Do it." }],
    config: { developmentQuestions: 1, heldoutQuestions: 1, maxCorpusRevisions: 1 }
  };
  await repository.create({ id: "run-usage", creatorId: CREATOR, idempotencyKey: "k", input });
  const ledger = new CapturingLedger();
  const prompts: FactoryPromptCall[] = [];
  const factory = new CreatorFactory(root, async call => {
    prompts.push(call);
    // One call reported twice: the second write is a retry of the first.
    await call.onModelCall?.({ id: "0", model: "factory-model", usage: usage(100, 20) });
    await call.onModelCall?.({ id: "0", model: "factory-model", usage: usage(100, 20) });
    throw new Error("stop after the first call");
  }, async () => "unused");
  const worker = new CreatorFactoryWorker(repository, factory, { workerId: "w", leaseMs: 60_000, heartbeatMs: 0, usage: ledger });
  await worker.workOnce();

  assert.equal(prompts.length, 1);
  assert.equal(ledger.events.length, 2);
  const [event, again] = ledger.events;
  assert.equal(event!.id, again!.id);
  assert.match(event!.id, /^[0-9a-f-]{36}:0$/);
  assert.deepEqual({ accountId: event!.accountId, surface: event!.surface, productId: event!.productId, runId: event!.runId }, { accountId: CREATOR, surface: "studio_web", productId: PRODUCT, runId: "run-usage" });
  assert.deepEqual(await ledger.forRun("run-usage"), { input: 100, cachedInput: 0, output: 20, reasoning: 0 });
});

test("a Factory run queued by an API key is Studio API usage under that key; one queued by a session is Studio web", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-studio-usage-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new InMemoryCreatorFactoryRepository();
  const input = (runId: string): FactoryStartInput => ({
    runId, creator: { id: CREATOR, name: "Expert" }, productId: PRODUCT, productName: "P", productPromise: "Promise.",
    sources: [{ id: "S1", authority: "creator_current", title: "Method", content: "Do it." }],
    config: { developmentQuestions: 1, heldoutQuestions: 1, maxCorpusRevisions: 1 }
  });
  await repository.create({ id: "by-key", creatorId: CREATOR, idempotencyKey: "k1", input: input("by-key"), apiKeyId: "key-1" });
  await repository.create({ id: "by-session", creatorId: CREATOR, idempotencyKey: "k2", input: input("by-session") });
  const ledger = new CapturingLedger();
  const factory = new CreatorFactory(root, async call => {
    await call.onModelCall?.({ id: "0", model: "factory-model", usage: usage(10, 2) });
    throw new Error("stop after the first call");
  }, async () => "unused");
  const worker = new CreatorFactoryWorker(repository, factory, { workerId: "w", leaseMs: 60_000, heartbeatMs: 0, usage: ledger });
  await worker.workOnce();
  await worker.workOnce();

  const byRun = (runId: string) => ledger.events.find(event => event.runId === runId)!;
  assert.deepEqual({ surface: byRun("by-key").surface, apiKeyId: byRun("by-key").apiKeyId }, { surface: "studio_api", apiKeyId: "key-1" });
  assert.deepEqual({ surface: byRun("by-session").surface, apiKeyId: byRun("by-session").apiKeyId }, { surface: "studio_web", apiKeyId: undefined });
});

test("an Assistant Run bound by a request from an API key is Studio API usage under that key; otherwise Studio web", () => {
  const owner = { ownerAccountId: "acct" };
  const viaKey = runInContext({ request_id: "req" }, () => { bindContext({ api_key_id: "key-1" }); return attributeByScope(scopeOfConversation(owner), { id: "run-1" }); });
  assert.deepEqual({ surface: viaKey.surface, apiKeyId: viaKey.apiKeyId, accountId: viaKey.accountId }, { surface: "studio_api", apiKeyId: "key-1", accountId: "acct" });
  const viaSession = runInContext({ request_id: "req" }, () => attributeByScope(scopeOfConversation(owner), { id: "run-2" }));
  assert.deepEqual({ surface: viaSession.surface, apiKeyId: viaSession.apiKeyId }, { surface: "studio_web", apiKeyId: undefined });
});

test("an ingest job is not started once the Expert has spent the month", async () => {
  const jobs = new MemoryIngestJobs();
  const service = new IngestService({ jobs, owns: async () => true, engine: new UnavailableEngine("off"), sink: {} as never, usageCap: await spentMonth(CREATOR), inBackground: () => undefined });
  await assert.rejects(service.submit(CREATOR, PRODUCT, [{ url: "https://example.com" }]), (error: { code?: string; status?: number }) => error.code === USAGE_CAP_EXCEEDED && error.status === 429);
  assert.deepEqual(await jobs.recent(CREATOR, PRODUCT, 10), []);
});

test("a Factory run is not started or advanced once the Expert has spent the month", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-studio-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new CreatorFactoryService(new InMemoryCreatorFactoryRepository(), root, undefined, undefined, undefined, undefined, undefined, await spentMonth(CREATOR));
  const expected = (error: { code?: string }) => error.code === USAGE_CAP_EXCEEDED;
  await assert.rejects(service.create({ id: CREATOR, name: "E" }, { productName: "P", productPromise: "Q", sources: [{ id: "S1", authority: "creator_current", title: "T", content: "C" }] }, "key"), expected);
});

test("a Factory Node is not started once the Expert has spent the month", async () => {
  const storage = { objectStore: new LocalArtifactObjectStore(await mkdtemp(path.join(os.tmpdir(), "hatch-node-cap-"))) };
  const service = new FactoryNodeService({} as never, {} as never, storage, {} as never, "creator-products", { recorder: new InMemoryUsageLedger(), cap: await spentMonth(CREATOR) });
  const product = { productId: PRODUCT, name: "P", promise: "Q" };
  const expected = (error: { code?: string }) => error.code === USAGE_CAP_EXCEEDED;
  await assert.rejects(service.startAboutYou({ creatorId: CREATOR, product }), expected);
  await assert.rejects(service.startCorpus({ creatorId: CREATOR, product, aboutYouRef: "x" }), expected);
});
