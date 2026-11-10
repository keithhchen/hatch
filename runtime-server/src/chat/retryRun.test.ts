import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  InMemoryConversationRepository, PostgresConversationRepository,
  type AcceptSubmissionInput, type ConversationRepository, type ConversationRunRecord
} from "../conversationRepository.js";
import { PostgresStore } from "../postgresStore.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { endingOf } from "../testSupport.js";
import { ChatService, RunRegistry } from "./chatService.js";
import { RunEventHub } from "./runEventHub.js";
import { RunTerminator } from "./runTerminator.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"e".repeat(24)}:retry`;
const message = (n: number): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "exec-a" },
  canonicalUser: { role: "user", content: `question ${n}` }
});

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; service: ChatService<object>; adopted: string[]; heard: Array<Record<string, unknown>> };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

function harness(repository: ConversationRepository, store: Harness["store"]): Harness {
  const hub = new RunEventHub();
  const heard: Array<Record<string, unknown>> = [];
  hub.subscribe(id, { push: (event) => { heard.push(event); } });
  const adopted: string[] = [];
  const service = new ChatService<object>({
    repository, terminator: new RunTerminator(repository, hub),
    supervisor: { adopt: (run: ConversationRunRecord) => { adopted.push(run.id); }, executorId: "exec-a", holdsConversation: () => false },
    hub, admission: { reserve: () => () => undefined }, registry: new RunRegistry<object>()
  });
  return { repository, store, service, adopted, heard };
}

async function withBackend(name: "memory" | "postgres", body: (h: Harness) => Promise<void>): Promise<void> {
  if (name === "memory") {
    const authority = new LocalRuntimeAuthority();
    const repository = new InMemoryConversationRepository(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "retry" });
      await body(harness(repository, new RuntimeStore(authority)));
    } finally { await repository.close(); }
    return;
  }
  const schema = `retry_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000, max: 8 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "retry" });
    await body(harness(repository, store));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

const retry = (h: Harness, key: string) => h.repository.getConversation(id).then((conversation) => h.service.retry({
  principal: { kind: "account", accountId: "owner" } as never, conversation: conversation!, scope: {}, client: { client: "web" },
  key, runId: `run-for-${key}`, corpusDigest: "corpus", requiresLocalTools: false
}));
const refusedWith = (code: string) => ({ code, status: 409 });

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? { skip: !databaseUrl, timeout: 30_000 } : {};

  test(`${backend}: a failed Run is answered again by one new Run over the same transcript, after the reply it kept`, options, () => withBackend(backend, async (h) => {
    const { run } = await h.repository.acceptSubmission(message(1));
    await h.repository.savePartialOutput(run.id, "The first half of an answer");
    await h.repository.endRun(run.id, endingOf("failed", "fetch failed"));
    const before = (await h.store.readConversation(id)).map((entry) => [entry.role, entry.content]);

    const retried = await retry(h, "retry-1");
    assert.equal(retried.outcome, "started");
    assert.equal(retried.run.status, "queued");
    assert.deepEqual(h.adopted, ["run-for-retry-1"]);
    assert.deepEqual(h.heard.filter((event) => event.run_id === retried.run.id), [{ type: "turn.state", run_id: retried.run.id, status: "queued" }]);
    // No new user message: the transcript is what the failed Run left, partial reply included.
    assert.deepEqual((await h.store.readConversation(id)).map((entry) => [entry.role, entry.content]), before);
    assert.deepEqual(before, [["user", "question 1"], ["assistant", "The first half of an answer"]]);
    // Every client hears of the Run through the journal, once.
    const created = (await h.repository.snapshot(id)).events.filter((event) => event.type === "run.created" && event.runId === retried.run.id);
    assert.equal(created.length, 1);
    assert.equal((await h.repository.listRuns(id)).length, 2);
  }));

  test(`${backend}: the same key replays its Run instead of starting another, also while that Run is active`, options, () => withBackend(backend, async (h) => {
    const { run } = await h.repository.acceptSubmission(message(1));
    await h.repository.endRun(run.id, endingOf("failed"));
    const first = await retry(h, "retry-1");
    const again = await retry(h, "retry-1");
    assert.equal(again.outcome, "replayed");
    assert.equal(again.run.id, first.run.id);
    assert.deepEqual(h.adopted, [first.run.id]);
    assert.equal((await h.repository.listRuns(id)).length, 2);
    // A key that a message already used is a conflict, never an answer again.
    await assert.rejects(retry(h, "m-1"), refusedWith("client_message_conflict"));
  }));

  test(`${backend}: it is refused while a Run is active, and when the latest Run did not fail`, options, () => withBackend(backend, async (h) => {
    const { run: failed } = await h.repository.acceptSubmission(message(1));
    await h.repository.endRun(failed.id, endingOf("failed"));
    // A newer message started a Run: the failed one is no longer the latest.
    const { run: newer } = await h.repository.acceptSubmission(message(2));
    await assert.rejects(retry(h, "retry-active"), refusedWith("conversation_busy"));
    await h.repository.endRun(newer.id, endingOf("completed"));
    await assert.rejects(retry(h, "retry-completed"), refusedWith("run_not_retryable"));
    assert.deepEqual(h.adopted, []);
    assert.equal((await h.repository.listRuns(id)).length, 2);
  }));

  test(`${backend}: a cancelled Run is not answered again, an interrupted one is, and an empty conversation has nothing to answer`, options, () => withBackend(backend, async (h) => {
    await assert.rejects(retry(h, "retry-empty"), refusedWith("run_not_retryable"));
    const { run: cancelled } = await h.repository.acceptSubmission(message(1));
    await h.repository.endRun(cancelled.id, endingOf("cancelled"));
    await assert.rejects(retry(h, "retry-cancelled"), refusedWith("run_not_retryable"));
    const { run: interrupted } = await h.repository.acceptSubmission(message(2));
    await h.repository.endRun(interrupted.id, endingOf("interrupted"));
    assert.equal((await retry(h, "retry-interrupted")).outcome, "started");
  }));

  test(`${backend}: two different keys at once start exactly one Run`, options, () => withBackend(backend, async (h) => {
    const { run } = await h.repository.acceptSubmission(message(1));
    await h.repository.endRun(run.id, endingOf("failed"));
    const results = await Promise.allSettled([retry(h, "a"), retry(h, "b"), retry(h, "c")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results) if (result.status === "rejected") assert.equal((result.reason as { status: number }).status, 409);
    assert.equal(h.adopted.length, 1);
    assert.equal((await h.repository.listRuns(id)).length, 2);
  }));
}
