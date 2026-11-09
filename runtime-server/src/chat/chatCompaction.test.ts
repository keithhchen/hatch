import assert from "node:assert/strict";
import { test } from "node:test";
import { chatCompactionAdapter, describeRuntimeMessage, type RuntimeCompactionMessage } from "../compaction.js";
import { CompactionStrategy, policyFor, type SummarizeInput } from "../compactionStrategy.js";
import { InMemoryConversationRepository, type AcceptSubmissionInput } from "../conversationRepository.js";
import type { ConversationMessage } from "../protocol.js";
import { RunStateMachine } from "../runState.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { ChatCompaction, type CompactionNotice } from "./chatCompaction.js";
import { RunEventHub } from "./runEventHub.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const conversationId = `scope:${"f".repeat(24)}:compaction`;
const uuid = "3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab";
const submission = (n: number, content = `question ${n}`): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "x" },
  canonicalUser: { role: "user", content }
});

const settled = async (condition: () => boolean | Promise<boolean>, what = "condition") => {
  for (let i = 0; i < 400; i++) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error(`${what} not reached`);
};

const writeCall = (id: string, path: string): ConversationMessage => ({
  role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "file_write", arguments: JSON.stringify({ path }) } }]
});
const output = (id: string, size: number): ConversationMessage => ({
  role: "tool", content: null, tool_call_id: id, tool_name: "file_write", tool_content: [{ type: "text", text: "y".repeat(size) }]
});

/** A test-only model: answers from a function, never from a real provider. */
type Summarize = (input: SummarizeInput<RuntimeCompactionMessage>) => Promise<string>;

async function harness(summarize: Summarize, options: { stopPollMs?: number } = {}) {
  const authority = new LocalRuntimeAuthority();
  const repository = new InMemoryConversationRepository(authority);
  const store = new RuntimeStore(authority);
  await repository.createConversation({ ...binding, id: conversationId, publicId: "compaction" });
  const hub = new RunEventHub();
  const strategy = new CompactionStrategy(chatCompactionAdapter(summarize), { ...policyFor(20_000), prune: 150, trigger: 300, tail: 80, cacheTtlMs: 1_000, timeoutMs: 3_000, maxOverflowRetries: 2 });
  const compaction = (executorId: string) => new ChatCompaction({ repository, store, hub, strategy: () => strategy, executorId, stopPollMs: options.stopPollMs ?? 10 });
  /** A finished conversation: the first Run's question, a file it wrote, and its answer. */
  const finished = async () => {
    const { run } = await repository.acceptSubmission(submission(1, `Please write out/report.md for order 88231045 (${uuid})`));
    for (const message of [writeCall("c1", "out/report.md"), output("c1", 1_600), { role: "assistant" as const, content: "Done: the report is written." }]) {
      await store.append({ type: "conversation.model_message", conversation_id: conversationId, run_id: run.id, message });
    }
    await repository.transitionRun(run.id, "completed");
    return run;
  };
  return { repository, store, hub, strategy, compaction, finished };
}

const answers = (): { summarize: Summarize; inputs: SummarizeInput<RuntimeCompactionMessage>[] } => {
  const inputs: SummarizeInput<RuntimeCompactionMessage>[] = [];
  return { inputs, summarize: async (input) => { inputs.push(input); return input.instructions.includes("left these out") ? `## Goal\nreport out/report.md order 88231045 ${uuid}` : "## Goal\nwrite a report"; } };
};

test("after the reply, in the background: the summary keeps paths and identifiers, the tail stays verbatim, and the event carries a compaction id", async () => {
  const model = answers();
  const { store, repository, compaction, finished } = await harness(model.summarize);
  const notices: CompactionNotice[] = [];
  const instance = compaction("a");
  instance.onCompaction((notice) => notices.push(notice));
  instance.afterReply(await finished());
  await settled(async () => (await store.readConversation(conversationId))[0]?.role === "compactionSummary", "history replaced");
  const history = await store.readConversation(conversationId);
  assert.match(history[0]!.content!, new RegExp(`out/report\\.md.*88231045.*${uuid}`));
  assert.equal(model.inputs.length, 2, "one retry restored what the model first dropped");
  assert.deepEqual(history.slice(1), [{ role: "assistant", content: "Done: the report is written." }]);
  const event = (await store.readEvents()).find((row) => row.type === "conversation.compacted");
  assert.ok(event?.type === "conversation.compacted" && event.compaction_id?.startsWith("cmp_") && event.stage === "summary");
  const journal = (await repository.snapshot(conversationId)).events.filter((row) => row.type.startsWith("compaction."));
  assert.deepEqual(journal.map((row) => row.type), ["compaction.started", "compaction.completed"]);
  assert.equal(new Set(journal.map((row) => row.payload.compaction_id)).size, 1);
  assert.equal(journal[1]!.payload.compaction_id, event.compaction_id);
  assert.deepEqual(notices.map((notice) => notice.state), ["started", "completed"]);
  assert.equal(await repository.runningCompaction(conversationId), undefined);
});

const blocking = () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const summarize: Summarize = async ({ signal }) => {
    started.push("asked");
    await Promise.race([open, new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))))]);
    return "## Goal\nx";
  };
  return { summarize, release, started };
};

test("a new message preempts background compaction and waits for it to end; the history is untouched", async () => {
  const model = blocking();
  const { store, repository, compaction, finished } = await harness(model.summarize);
  const instance = compaction("a");
  instance.afterReply(await finished());
  await settled(() => model.started.length === 1, "summarizer asked");
  await instance.preempt(conversationId);
  assert.equal(await repository.runningCompaction(conversationId), undefined, "ended before the message proceeds");
  assert.equal((await store.readConversation(conversationId))[0]!.role, "user");
  assert.deepEqual((await repository.snapshot(conversationId)).events.filter((row) => row.type === "compaction.completed"), []);
});

test("a new message on another instance preempts it too", async () => {
  const model = blocking();
  const { repository, compaction, finished } = await harness(model.summarize);
  const first = compaction("a");
  const second = compaction("b");
  first.afterReply(await finished());
  await settled(() => model.started.length === 1, "summarizer asked");
  await second.preempt(conversationId);
  assert.equal(await repository.runningCompaction(conversationId), undefined);
});

test("a Run that started while it summarized makes the result stale: the new message is not wiped", async () => {
  const model = blocking();
  const { store, repository, compaction, finished } = await harness(model.summarize);
  const instance = compaction("a");
  instance.afterReply(await finished());
  await settled(() => model.started.length === 1, "summarizer asked");
  // The message is accepted without the preempt the service performs: the database guard must hold on its own.
  await repository.acceptSubmission(submission(2, "a new message"));
  model.release();
  await settled(async () => (await repository.runningCompaction(conversationId)) === undefined, "job ended");
  const history = await store.readConversation(conversationId);
  assert.equal(history.at(-1)!.content, "a new message");
  assert.equal(history[0]!.role, "user", "no checkpoint was written");
});

test("a failed summary keeps a bounded verbatim tail, says how much was dropped, and tells the user", async () => {
  const { store, repository, compaction, finished } = await harness(async () => { throw new Error("provider down"); });
  const notices: CompactionNotice[] = [];
  const instance = compaction("a");
  instance.onCompaction((notice) => notices.push(notice));
  instance.afterReply(await finished());
  await settled(async () => (await store.readConversation(conversationId))[0]?.role === "compactionSummary", "history replaced");
  const history = await store.readConversation(conversationId);
  assert.match(history[0]!.content!, /\d+ earlier messages? (was|were) dropped/);
  assert.equal(history.at(-1)!.content, "Done: the report is written.");
  const completed = (await repository.snapshot(conversationId)).events.find((row) => row.type === "compaction.completed")!;
  assert.equal(completed.payload.degraded, true);
  assert.ok((completed.payload.dropped_messages as number) > 0);
  assert.equal(notices.find((notice) => notice.state === "completed")?.degraded, true);
});

test("a message that joins a compacting Run waits and is claimed afterwards, after the summary", async () => {
  const joined: Array<{ consumed: number; status: string }> = [];
  const ctl: { repository?: InMemoryConversationRepository; runId?: string } = {};
  const { store, repository, compaction, finished } = await harness(async () => {
    await ctl.repository!.acceptSubmission(submission(3, "one more thing"));
    const run = (await ctl.repository!.getRun(conversationId, ctl.runId!))!;
    if (!joined.length) joined.push({ consumed: run.consumedCount, status: run.status });
    return `## Goal\nx out/report.md 88231045 ${uuid}`;
  });
  ctl.repository = repository;
  const first = await finished();
  // The next turn: a new Run whose history is large, so it compacts before its model call.
  const { run } = await repository.acceptSubmission(submission(2, "continue please"));
  ctl.runId = run.id;
  await repository.transitionRun(run.id, "running");
  const state = new RunStateMachine(run.id, conversationId, store, (status, reason) => repository.transitionRun(run.id, status, reason).then(() => undefined), undefined, "running");
  const conversation = (await repository.getConversation(conversationId))!;
  const turn = compaction("a").forRun({ run, conversation, state, publish: () => undefined, signal: new AbortController().signal });
  const checkpoint = await turn.ifNeeded(await store.readConversation(conversationId), "pre_turn");
  assert.ok(checkpoint);
  assert.deepEqual(joined, [{ consumed: 0, status: "compacting" }], "it joined while the Run was compacting and was not taken");
  assert.equal((await repository.getRun(conversationId, run.id))!.status, "running");
  const claimed = await repository.claimSteeredMessages(run.id);
  assert.deepEqual(claimed.map((row) => row.message.content), ["one more thing"]);
  const history = await store.readConversation(conversationId);
  assert.equal(history[0]!.role, "compactionSummary");
  assert.equal(history.at(-1)!.content, "one more thing");
  void first;
});

test("recovery from a provider overflow is bounded, and a manual compaction that fails raises instead of dropping", async () => {
  const model = answers();
  const { store, repository, compaction, finished } = await harness(model.summarize);
  await finished();
  const { run } = await repository.acceptSubmission(submission(2, "carry on"));
  const state = new RunStateMachine(run.id, conversationId, store, (status, reason) => repository.transitionRun(run.id, status, reason).then(() => undefined), undefined, "queued");
  await state.start();
  const turn = compaction("a").forRun({ run, conversation: (await repository.getConversation(conversationId))!, state, publish: () => undefined, signal: new AbortController().signal });
  const attempts = [] as unknown[];
  for (let n = 0; n < 4; n++) attempts.push(await turn.recoverFromOverflow(await store.readConversation(conversationId)));
  assert.equal(attempts.filter(Boolean).length <= 2, true);
  assert.equal(attempts[2], undefined);
  assert.equal(attempts[3], undefined);

  const failing = await harness(async () => { throw new Error("provider down"); });
  await failing.finished();
  const next = await failing.repository.acceptSubmission(submission(2, "carry on"));
  const failingState = new RunStateMachine(next.run.id, conversationId, failing.store, (status, reason) => failing.repository.transitionRun(next.run.id, status, reason).then(() => undefined), undefined, "queued");
  await failingState.start();
  const manual = failing.compaction("a").forRun({ run: next.run, conversation: (await failing.repository.getConversation(conversationId))!, state: failingState, publish: () => undefined, signal: new AbortController().signal });
  const before = await failing.store.readConversation(conversationId);
  await assert.rejects(manual.manual(before), /provider down/);
  assert.deepEqual(await failing.store.readConversation(conversationId), before);
});

test("images are path labels for the summary and sender attribution is kept", () => {
  const image = describeRuntimeMessage({ role: "user", content: "[Alice] look at this", model_images: [{ type: "image", data: "AAAA", mimeType: "image/png" }] });
  assert.equal(image.sender, "Alice");
  assert.doesNotMatch(image.text, /AAAA/);
  assert.match(image.text, /\[image: attached\]/);
});
