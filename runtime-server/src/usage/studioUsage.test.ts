import assert from "node:assert/strict";
import test from "node:test";
import { MemoryIngestJobs } from "../ingest/jobs.js";
import { UnavailableEngine } from "../ingest/engines.js";
import { IngestService } from "../ingest/service.js";
import { InMemoryUsageLedger } from "./memoryUsage.js";
import { scopeOfConversation } from "../assistant/chat.js";
import { bindContext, runInContext } from "../observability/context.js";
import { attributeByScope, type UsageEvent } from "./usage.js";
import { USAGE_CAP_EXCEEDED, UsageCap } from "./usageCap.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";

/** The memory ledger that also remembers every event it was asked to record. */
class CapturingLedger extends InMemoryUsageLedger {
  readonly events: UsageEvent[] = [];
  override async record(event: UsageEvent): Promise<void> { this.events.push(event); await super.record(event); }
}

/** A ledger already holding `tokens` of this month's Studio usage, and a cap of one token. */
async function spentMonth(accountId: string) {
  const ledger = new CapturingLedger();
  await ledger.record({ id: "spent", accountId, surface: "studio_web", model: "m", inputTokens: 5, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  return new UsageCap(ledger, 1);
}

test("an Assistant Run is Assistant usage on every channel; an API key that made the request is recorded with it", () => {
  const owner = { ownerAccountId: "acct" };
  const viaKey = runInContext({ request_id: "req" }, () => { bindContext({ api_key_id: "key-1" }); return attributeByScope(scopeOfConversation(owner), { id: "run-1" }); });
  assert.deepEqual({ surface: viaKey.surface, apiKeyId: viaKey.apiKeyId, accountId: viaKey.accountId }, { surface: "assistant", apiKeyId: "key-1", accountId: "acct" });
  const viaSession = runInContext({ request_id: "req" }, () => attributeByScope(scopeOfConversation(owner), { id: "run-2" }));
  assert.deepEqual({ surface: viaSession.surface, apiKeyId: viaSession.apiKeyId }, { surface: "assistant", apiKeyId: undefined });
});

test("an ingest job is not started once the Expert has spent the month", async () => {
  const jobs = new MemoryIngestJobs();
  const service = new IngestService({ jobs, owns: async () => true, engine: new UnavailableEngine("off"), sink: {} as never, objects: {} as never, usageCap: await spentMonth(CREATOR), inBackground: () => undefined });
  await assert.rejects(service.submit(CREATOR, PRODUCT, [{ url: "https://example.com" }]), (error: { code?: string; status?: number }) => error.code === USAGE_CAP_EXCEEDED && error.status === 429);
  assert.deepEqual(await jobs.recent(CREATOR, PRODUCT, 10), []);
});
