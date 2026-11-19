import assert from "node:assert/strict";
import { test } from "node:test";
import { createBriefSnapshot, type BriefSnapshot } from "../brief.js";
import { InMemoryConversationRepository, type AcceptSubmissionInput } from "../conversationRepository.js";
import { FilePrompts, type Prompts } from "../prompts.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { endingOf } from "../testSupport.js";
import { ChatRuntime } from "./chatRuntime.js";
import { cleanTitle, ConversationTitles, titleInput, type TitleModel } from "./conversationTitles.js";

// ── cleanTitle ─────────────────────────────────────────────────────────

test("a title loses the wrapping and the trailing punctuation models add", () => {
  assert.equal(cleanTitle("\"Pricing review for a SaaS startup.\""), "Pricing review for a SaaS startup");
  assert.equal(cleanTitle("「大阪3日間の旅程」"), "大阪3日間の旅程");
  assert.equal(cleanTitle("《juduvalve.com 获客诊断》。"), "juduvalve.com 获客诊断");
  assert.equal(cleanTitle("**Title: Q3 hiring plan!**"), "Q3 hiring plan");
  assert.equal(cleanTitle("## 获客诊断…"), "获客诊断");
  assert.equal(cleanTitle("\n\n  Tokyo trip, 5 days  \nI chose this because"), "Tokyo trip, 5 days", "only the first line");
});

test("a bracket that belongs to the title stays", () => {
  assert.equal(cleanTitle("Pricing plan (v2)"), "Pricing plan (v2)");
  assert.equal(cleanTitle("Plan (v2) for [Acme]"), "Plan (v2) for [Acme]");
  assert.equal(cleanTitle("(Draft) plan"), "(Draft) plan");
});

test("a title is cut to 24 CJK characters or 50 Latin ones, a Latin one at a word", () => {
  assert.equal([...cleanTitle("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十")!].length, 24);
  assert.equal(cleanTitle("juduvalve.com 获客诊断，包括独立站、询盘转化、广告投放和销售跟进的完整复盘")!.length <= 24, true);
  const long = cleanTitle("A comprehensive review of the pricing strategy for a twelve seat software company in Europe")!;
  assert.ok(long.length <= 50, long);
  assert.ok(long.startsWith("A comprehensive review of the pricing strategy"), long);
  assert.ok(!long.endsWith(" "), long);
  assert.equal(cleanTitle("x".repeat(80))!.length, 50);
});

test("nothing usable, or a generic word, is no title", () => {
  for (const raw of ["", "   ", "\"\"", "。", "Chat", "Conversation.", "对话", "新对话", "新しい会話", "New conversation", "Untitled"]) assert.equal(cleanTitle(raw), undefined, raw);
});

// ── titleInput ─────────────────────────────────────────────────────────

const brief = (fields: Array<[string, string]>): BriefSnapshot => createBriefSnapshot(
  { contract_version: "1", fields: fields.map(([label], i) => ({ id: `f${i}`, label, required: false })) },
  fields.map(([, value], i) => ({ field_id: `f${i}`, value }))
);

test("a conversation started from a Brief is about the Brief's answers, not the system reminder", () => {
  const conversation = { briefSnapshot: brief([["Website", "juduvalve.com"], ["Target markets", "Germany, Poland"], ["Notes", ""]]) };
  const input = titleInput(conversation, [
    { role: "user", content: "<system-reminder>\nStart the task described in the Brief.\n</system-reminder>" },
    { role: "assistant", content: "I looked at juduvalve.com and found three gaps." }
  ])!;
  assert.match(input, /Website: juduvalve\.com/);
  assert.match(input, /Target markets: Germany, Poland/);
  assert.doesNotMatch(input, /system-reminder|Notes/);
  assert.match(input, /first reply began:\nI looked at juduvalve\.com/);
});

test("any other conversation is about the first thing the user wrote, and the start of the first reply", () => {
  const input = titleInput({}, [
    { role: "user", content: "How do I price a 12-seat SaaS?" },
    { role: "assistant", content: "x".repeat(5_000) },
    { role: "user", content: "second question" }
  ])!;
  assert.match(input, /^The user wrote:\nHow do I price a 12-seat SaaS\?\n\nThe first reply began:\nx{1000}…$/);
  assert.doesNotMatch(input, /second question/);
  assert.equal(titleInput({}, [{ role: "user", content: "hi" }]), "The user wrote:\nhi");
});

test("there is nothing to name before the user has said something", () => {
  assert.equal(titleInput({}, []), undefined);
  assert.equal(titleInput({}, [{ role: "assistant", content: "hello" }]), undefined);
  assert.equal(titleInput({ briefSnapshot: brief([["Website", ""]]) }, [{ role: "user", content: "  " }]), undefined);
});

// ── ConversationTitles over a real repository ──────────────────────────

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"t".repeat(24)}:titles`;
const message = (n: number, content: string, executorId = "exec"): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId, executorLeaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
  canonicalUser: { role: "user", content }
});

async function setup(model: TitleModel, extra: { timeoutMs?: number; skip?: (id: string) => Promise<boolean>; prompts?: Prompts; brief?: BriefSnapshot } = {}) {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id, publicId: "titles", ...(extra.brief ? { briefSnapshot: extra.brief } : {}) });
  const titles = new ConversationTitles({ repository, history: store, prompts: extra.prompts ?? new FilePrompts(), model, timeoutMs: extra.timeoutMs, skip: extra.skip });
  /** A Run is asked, answered and ended, as the terminator does, then the titler is told. */
  const complete = async (n: number, question: string, answer: string) => {
    const { run } = await repository.acceptSubmission(message(n, question));
    const ending = { ...endingOf("completed"), reply: { message: { role: "assistant" as const, content: answer }, finishReason: "stop" as const, visibleParts: [] } };
    const ended = await repository.endRun(run.id, ending);
    return titles.runEnded(ended, ending);
  };
  return { repository, titles, complete };
}

test("the first completed Run gives the conversation its title, from the user's words and the reply, under the stored prompt", async () => {
  const seen: Array<{ system: string; user: string }> = [];
  const { repository, complete } = await setup(async ({ system, user }) => { seen.push({ system, user }); return "\"juduvalve.com 获客诊断。\""; });
  const titled = await complete(0, "帮我看看 juduvalve.com 的获客", "好的，我先看了网站首页。");
  assert.equal(titled?.title, "juduvalve.com 获客诊断");
  assert.equal((await repository.getConversation(id))?.title, "juduvalve.com 获客诊断");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.system, /Answer with the title only/);
  assert.match(seen[0]!.user, /帮我看看 juduvalve\.com 的获客[\s\S]*好的，我先看了网站首页/);
});

test("a second Run neither asks the model again nor changes the title", async () => {
  let calls = 0;
  const { repository, complete } = await setup(async () => { calls++; return calls === 1 ? "First title" : "Other title"; });
  assert.equal((await complete(0, "hello there", "hi"))?.title, "First title");
  assert.equal(await complete(1, "and another thing", "sure"), undefined);
  assert.equal(calls, 1);
  assert.equal((await repository.getConversation(id))?.title, "First title");
});

test("a model that fails leaves the chat alone, and the next completed Run tries again", async () => {
  let calls = 0;
  const { repository, complete } = await setup(async () => { if (++calls === 1) throw new Error("model down"); return "Second try"; });
  assert.equal(await complete(0, "hello there", "hi"), undefined, "the failure does not reach the caller");
  assert.equal((await repository.getConversation(id))?.title, undefined);
  assert.equal((await repository.getRun(id, "run-0"))?.status, "completed");
  assert.equal((await complete(1, "hello again", "hi again"))?.title, "Second try");
});

test("an answer that is no title, or a model that never answers, is retried the same way", async () => {
  let calls = 0;
  const { repository, complete } = await setup(({ signal }) => ++calls === 1 ? Promise.resolve("Chat") : new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("timed out")))), { timeoutMs: 30 });
  assert.equal(await complete(0, "hello there", "hi"), undefined);
  assert.equal(await complete(1, "hello again", "hi"), undefined, "bounded by the timeout");
  assert.equal(calls, 2);
  assert.equal((await repository.getConversation(id))?.title, undefined);
});

test("a title the user set is never replaced", async () => {
  let calls = 0;
  const { repository, complete } = await setup(async () => { calls++; return "Generated"; });
  await repository.updateConversation(id, { title: "My own name" });
  assert.equal(await complete(0, "hello there", "hi"), undefined);
  assert.equal(calls, 0, "no model call for a conversation that already has a title");
  assert.equal((await repository.getConversation(id))?.title, "My own name");
});

test("a title the user sets while the model works wins over the generated one", async () => {
  const { repository, complete } = await setup(async () => { await repository.updateConversation(id, { title: "Renamed meanwhile" }); return "Generated"; });
  assert.equal(await complete(0, "hello there", "hi"), undefined);
  assert.equal((await repository.getConversation(id))?.title, "Renamed meanwhile");
});

test("only a Run that completed is titled; a conversation that is not a chat is skipped", async () => {
  let calls = 0;
  const { repository, titles } = await setup(async () => { calls++; return "A title"; }, { skip: async () => true });
  const { run } = await repository.acceptSubmission(message(0, "hello there"));
  const failing = endingOf("failed");
  assert.equal(await titles.runEnded(await repository.endRun(run.id, failing), failing), undefined);
  assert.equal(await titles.runEnded({ run, ended: false }, endingOf("completed")), undefined, "a Run that was already over");
  const second = await repository.acceptSubmission(message(1, "hello again"));
  assert.equal(await titles.runEnded(await repository.endRun(second.run.id, endingOf("completed")), endingOf("completed")), undefined, "skipped");
  assert.equal(calls, 0);
});

test("a conversation started from a Brief is titled from the Brief", async () => {
  const seen: string[] = [];
  const { complete } = await setup(async ({ user }) => { seen.push(user); return "juduvalve.com 获客诊断"; }, { brief: brief([["Website", "juduvalve.com"], ["Markets", "DE, PL"]]) });
  assert.equal((await complete(0, "<system-reminder>\nStart the task described in the Brief.\n</system-reminder>", "I will begin with the site."))?.title, "juduvalve.com 获客诊断");
  assert.match(seen[0]!, /Website: juduvalve\.com/);
});

// ── through the ChatRuntime ────────────────────────────────────────────

const settled = async (condition: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 300; i++) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`${what} not reached`);
};

test("a Run's completion is told first, then the page hears the title once; a failing title model never touches the Run", async () => {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id, publicId: "titles" });
  let calls = 0;
  const titles = new ConversationTitles({ repository, history: store, prompts: new FilePrompts(), model: async () => { if (++calls === 1) throw new Error("model down"); return "Tokyo trip, 5 days"; } });
  const chat = new ChatRuntime<object>({
    repository, store, scopes: { resolve: async () => ({}) }, admission: { reserve: () => () => undefined }, toolTimeoutMs: 60_000, leaseMs: 60_000, sweepMs: 60_000,
    compactionStrategy: () => ({ wants: () => false, tokensOf: () => 0, policy: { prune: 1e9, cacheTtlMs: 1, maxOverflowRetries: 2, timeoutMs: 1000 } }) as never,
    runner: { async run(turn) { await turn.state.start(); await turn.state.complete({ message: { role: "assistant", content: "Day 1: Asakusa." }, finishReason: "stop", visibleParts: [] }); } },
    titles
  });
  const heard: Array<Record<string, unknown>> = [];
  chat.hub.subscribe(id, { push: event => { heard.push(event); } });
  const ask = async (n: number) => {
    const { run } = await repository.acceptSubmission(message(n, "Plan a 5 day Tokyo trip", chat.supervisor.executorId));
    chat.supervisor.adopt(run);
    await settled(async () => (await repository.getRun(id, run.id))!.status === "completed", `run ${n} completes`);
  };
  await ask(0);
  await settled(() => calls === 1, "the first attempt");
  assert.equal((await repository.getConversation(id))?.title, undefined, "the model failed: no title, and the Run completed all the same");
  assert.equal(heard.some(event => event.type === "conversation.titled"), false);
  await ask(1);
  await settled(async () => (await repository.getConversation(id))?.title === "Tokyo trip, 5 days", "the retry titles it");
  await settled(() => heard.some(event => event.type === "conversation.titled"), "the page is told");
  assert.deepEqual(heard.filter(event => event.type === "conversation.titled"), [{ type: "conversation.titled", conversation_id: "titles", title: "Tokyo trip, 5 days" }]);
  await ask(2);
  assert.equal(calls, 2, "a titled conversation is not asked about again");
  assert.equal(heard.filter(event => event.type === "conversation.titled").length, 1);
  await chat.stop();
});
