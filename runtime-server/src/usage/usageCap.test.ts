import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantTarget } from "../assistant/assistantTarget.js";
import { ChatFlow } from "../channels/chatTarget.js";
import { ProductTarget } from "../channels/productTarget.js";
import { ChatError } from "../chat/principal.js";
import { ChatService, RunRegistry } from "../chat/chatService.js";
import { RunEventHub } from "../chat/runEventHub.js";
import { RunTerminator } from "../chat/runTerminator.js";
import { InMemoryConversationRepository, type ConversationRunRecord } from "../conversationRepository.js";
import { toProblem } from "../errors/problem.js";
import { errorBody, toApiError } from "../responses/errors.js";
import { LocalRuntimeAuthority } from "../store.js";
import { InMemoryUsageLedger } from "./memoryUsage.js";
import { emptySurfaces, usageReport, type SurfaceTokens, type UsageEvent } from "./usage.js";
import { UsageCap, UsageCapExceeded } from "./usageCap.js";

const NOW = new Date("2026-11-13T10:00:00Z");
const month = (studio: number, chatApi = 0, chatWeb = 0): SurfaceTokens => {
  const tokens = emptySurfaces();
  tokens.studio.input = studio; tokens.chat_api.output = chatApi; tokens.chat_web.input = chatWeb;
  return tokens;
};
const counting = (tokens: () => SurfaceTokens) => {
  const reads: string[] = [];
  return { reads, reader: { monthToDate: async (accountId: string) => { reads.push(accountId); return tokens(); } } };
};

test("below the cap a Run may start; at or over it, the typed error says who, how much, and when it resets", async () => {
  await new UsageCap(counting(() => month(40, 30, 29)).reader, 100, { now: () => NOW }).assertWithinCap("acct");
  const at = new UsageCap(counting(() => month(40, 30, 30)).reader, 100, { now: () => NOW });
  await assert.rejects(at.assertWithinCap("acct"), (error: unknown) => {
    assert.ok(error instanceof UsageCapExceeded);
    assert.deepEqual([error.accountId, error.used, error.cap, error.resetsAt.toISOString(), error.status, error.code], ["acct", 100, 100, "2026-12-01T00:00:00.000Z", 429, "usage_cap_exceeded"]);
    return true;
  });
});

test("the cap counts input and output across every surface, and December resets into January", async () => {
  const ledger = new InMemoryUsageLedger();
  const event = (overrides: Partial<UsageEvent>): UsageEvent => ({ id: "x", accountId: "acct", surface: "chat_web", model: "m", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, at: new Date("2026-12-05T00:00:00Z"), ...overrides });
  await ledger.record(event({ id: "a", surface: "studio", inputTokens: 60, cachedInputTokens: 50 }));
  await ledger.record(event({ id: "b", surface: "chat_api", outputTokens: 40, reasoningTokens: 30 }));
  await ledger.record(event({ id: "c", inputTokens: 999, at: new Date("2026-11-30T00:00:00Z") }));
  const cap = new UsageCap(ledger, 100, { now: () => new Date("2026-12-20T00:00:00Z") });
  await assert.rejects(cap.assertWithinCap("acct"), (error: unknown) => error instanceof UsageCapExceeded && error.used === 100 && error.resetsAt.toISOString() === "2027-01-01T00:00:00.000Z");
  await cap.assertWithinCap("someone-else");
});

test("no cap, or a cap of zero, never reads the ledger", async () => {
  const { reads, reader } = counting(() => month(1e9));
  for (const env of [{}, { HATCH_MONTHLY_TOKEN_CAP: "0" }, { HATCH_MONTHLY_TOKEN_CAP: "" }]) await UsageCap.fromEnvironment(reader, env).assertWithinCap("acct");
  assert.deepEqual(reads, []);
  assert.equal(UsageCap.fromEnvironment(reader, { HATCH_MONTHLY_TOKEN_CAP: "5" }).cap, 5);
});

test("a below-cap reading is remembered for the window, per account; an over-cap one never is", async () => {
  let clock = NOW.getTime();
  let spent = 10;
  const { reads, reader } = counting(() => month(spent));
  const cap = new UsageCap(reader, 100, { ttlMs: 10_000, now: () => new Date(clock) });
  await cap.assertWithinCap("a"); await cap.assertWithinCap("a"); await cap.assertWithinCap("b");
  assert.deepEqual(reads, ["a", "b"], "the second message of the same account reads nothing");
  clock += 10_001;
  await cap.assertWithinCap("a");
  assert.deepEqual(reads, ["a", "b", "a"], "after the window it reads again");
  spent = 100; clock += 10_001;
  await assert.rejects(cap.assertWithinCap("a"), UsageCapExceeded);
  await assert.rejects(cap.assertWithinCap("a"), UsageCapExceeded);
  assert.equal(reads.length, 5, "an over-cap account is read every time, so a raised cap or a new month is seen at once");
  spent = 0;
  await cap.assertWithinCap("a");
});

test("the dashboard read carries the cap and what remains of it", async () => {
  const ledger = new InMemoryUsageLedger();
  await ledger.record({ id: "a", accountId: "acct", surface: "studio", model: "m", inputTokens: 70, cachedInputTokens: 0, outputTokens: 20, reasoningTokens: 0, at: NOW });
  assert.deepEqual((await usageReport(ledger, "acct", "2026-11-13", "2026-11-13", 100, NOW)).cap, { monthly_tokens: 100, remaining_tokens: 10 });
  assert.deepEqual((await usageReport(ledger, "acct", "2026-11-13", "2026-11-13", 50, NOW)).cap, { monthly_tokens: 50, remaining_tokens: 0 });
  assert.deepEqual((await usageReport(ledger, "acct", "2026-11-13", "2026-11-13", null, NOW)).cap, { monthly_tokens: null, remaining_tokens: null });
});

const exceeded = new UsageCapExceeded("acct", 1234, 1000, new Date("2026-12-01T00:00:00Z"));

test("Responses API: 429 insufficient_quota usage_cap_exceeded, with the numbers and the reset date", () => {
  const { error, internal } = toApiError(exceeded);
  assert.equal(internal, false);
  assert.equal(error.status, 429);
  assert.deepEqual(errorBody(error), { error: { type: "insufficient_quota", code: "usage_cap_exceeded", message: "Monthly token limit reached (1234/1000). It resets on 2026-12-01.", param: null } });
  assert.equal(toApiError(new ChatError("usage_cap_exceeded", "x", 429)).error.type, "insufficient_quota", "also when the refusal arrives from another process");
});

test("Conversation HTTP and Studio routes: 429 usage_cap_exceeded in their own shapes, with no numbers on the wire", () => {
  assert.deepEqual(toProblem(exceeded), { status: 429, code: "usage_cap_exceeded", message: "Monthly token limit reached. It resets on 2026-12-01." });
  assert.doesNotMatch(exceeded.message, /1234|1000/);
});

test("channels: one short reply instead of a Run, in the target's own words", async () => {
  const refusing = { send: async () => { throw exceeded; }, upload: async () => ({ assetId: "a", kind: "file" as const }), progress: async () => undefined };
  const connection = { id: "c", ownerAccountId: "o", channel: "telegram", scope: "", client: "im", target: { kind: "product", productId: "p" }, audience: "self", taskSpecific: false, state: "active" } as never;
  const notices: string[] = [];
  const inbound = (text: string) => ({ id: "i", connection, adapter: {} as never, principal: { kind: "account", accountId: "o" }, address: { connectionId: "c", chat: "1" } as never, notify: async (reply: string) => { notices.push(reply); }, event: { id: text, address: { chat: "1" }, text, files: [] } as never });
  const product = new ChatFlow(new ProductTarget({ gateway: refusing as never, limiter: { take: async () => 0 } }));
  await product.handle(inbound("hi") as never);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /monthly limit/);
  assert.doesNotMatch(notices[0]!, /1234/);
  assert.ok(new AssistantTarget({} as never).wording.capReached.length > 0);
});

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
async function chat(cap: (scope: { creatorId: string }) => Promise<void>) {
  const repository = new InMemoryConversationRepository(new LocalRuntimeAuthority());
  const { conversation } = await repository.createConversation({ ...binding, id: `scope:${"c".repeat(24)}:cap`, publicId: "cap" });
  const hub = new RunEventHub();
  const adopted: string[] = [];
  const service = new ChatService<{ creatorId: string }>({
    repository, terminator: new RunTerminator(repository, hub), hub, admission: { reserve: () => () => undefined }, registry: new RunRegistry(), cap,
    supervisor: { adopt: (run: ConversationRunRecord) => { adopted.push(run.id); }, executorId: "exec", holdsConversation: () => false, steered: () => undefined }
  });
  const submit = (n: number) => service.submit({
    principal: { kind: "account", accountId: "owner" } as never, conversation, scope: { creatorId: "creator" }, client: { client: "web" },
    clientMessageId: `m-${n}`, message: async () => ({ role: "user", content: `q${n}` }), digest: `d-${n}`, runId: `run-${n}`, corpusDigest: "corpus", requiresLocalTools: false
  });
  return { repository, submit, adopted, conversation };
}

test("chat: a Run in flight is not interrupted and takes steered messages once its payer is over the cap", async () => {
  let over = false;
  const asked: string[] = [];
  const h = await chat(async scope => { asked.push(scope.creatorId); if (over) throw new UsageCapExceeded(scope.creatorId, 10, 10, new Date("2026-12-01T00:00:00Z")); });
  try {
    assert.equal((await h.submit(1)).outcome, "started");
    over = true;
    assert.equal((await h.submit(2)).outcome, "steered", "joining the active Run is allowed");
    assert.equal((await h.submit(2)).outcome, "replayed", "an accepted message is not asked again");
    assert.deepEqual(h.adopted, ["run-1"]);
    assert.equal((await h.repository.getActiveRun(h.conversation.id))?.id, "run-1", "the Run in flight is still active");
    assert.deepEqual(asked, ["creator"], "only the message that would start a Run was asked");
  } finally { await h.repository.close(); }
});

test("chat: with no active Run, an over-cap message starts nothing and accepts nothing", async () => {
  const h = await chat(async scope => { throw new UsageCapExceeded(scope.creatorId, 10, 10, new Date("2026-12-01T00:00:00Z")); });
  try {
    await assert.rejects(h.submit(1), (error: unknown) => error instanceof UsageCapExceeded && toProblem(error).status === 429);
    assert.equal(await h.repository.getActiveRun(h.conversation.id), undefined);
    assert.equal(await h.repository.hasAcceptedMessage(h.conversation.id, "m-1"), false);
    assert.deepEqual(h.adopted, []);
  } finally { await h.repository.close(); }
});
