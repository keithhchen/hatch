import { endingOf } from "./testSupport.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  InMemoryConversationRepository, PostgresConversationRepository,
  type AcceptSubmissionInput, type ConversationRepository
} from "./conversationRepository.js";
import { LocalRuntimeAuthority, RuntimeStore } from "./store.js";
import { PostgresStore } from "./postgresStore.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"d".repeat(24)}:hardening`;
const message = (n: number): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `message-${n}`, inputDigest: `digest-${n}`, corpusDigest: "corpus", executorId: "exec-a" },
  canonicalUser: { role: "user", content: `question ${n}` }
});

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; crashNextTranscriptWrite(): () => void };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "file" | "postgres", body: (harness: Harness) => Promise<void>): Promise<void> {
  if (name !== "postgres") {
    const root = name === "file" ? await mkdtemp(path.join(os.tmpdir(), "hatch-hardening-")) : undefined;
    const authority = new LocalRuntimeAuthority(root);
    const repository = new InMemoryConversationRepository(authority);
    const previousLimit = process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS;
    try {
      await repository.createConversation({ ...binding, id, publicId: "hardening" });
      const store = new RuntimeStore(authority);
      // The commit log refuses a commit over its storage quota: a failure at the moment the transcript is written.
      await body({ repository, store, crashNextTranscriptWrite: () => { process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS = "1"; return () => { delete process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS; }; } });
    } finally {
      if (previousLimit === undefined) delete process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS; else process.env.HATCH_RUNTIME_MAX_CONVERSATION_EVENTS = previousLimit;
      await repository.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
    return;
  }
  const schema = `hardening_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    let crash = false;
    const real = pool;
    const crashing = {
      query: real.query.bind(real) as Pool["query"],
      end: () => real.end(),
      connect: async () => {
        const client = await real.connect();
        const query = client.query.bind(client) as typeof client.query;
        (client as { query: unknown }).query = (sql: unknown, ...rest: unknown[]) => crash && String(sql).includes("INSERT INTO hatch_conversation_events")
          ? Promise.reject(new Error("the process died while writing the transcript"))
          : (query as (...args: unknown[]) => unknown)(sql, ...rest);
        return client;
      }
    };
    const store = new PostgresStore(crashing as never);
    const repository = new PostgresConversationRepository(crashing as never);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "hardening" });
    await body({ repository, store, crashNextTranscriptWrite: () => { crash = true; return () => { crash = false; }; } });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

for (const backend of ["memory", "file", "postgres"] as const) {
  const options = { skip: backend === "postgres" && !databaseUrl };

  test(`${backend}: a claimed steered message is in the transcript, once, in the same transaction as its claim`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const start = await repository.acceptSubmission(message(0));
    await repository.acceptSubmission(message(1));
    await repository.acceptSubmission(message(2));
    const claimed = await repository.claimSteeredMessages(start.run.id);
    assert.deepEqual(claimed.map((row) => row.clientMessageId), ["message-1", "message-2"]);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "question 1", "question 2"]);
    assert.deepEqual(await repository.claimSteeredMessages(start.run.id), []);
    assert.equal((await store.readConversation(id)).length, 3);
  }));

  test(`${backend}: a crash while writing the transcript loses no claim and no message: the next claim delivers both`, options, async () => withBackend(backend, async ({ repository, store, crashNextTranscriptWrite }) => {
    const start = await repository.acceptSubmission(message(0));
    await repository.acceptSubmission(message(1));
    const restart = crashNextTranscriptWrite();
    await assert.rejects(repository.claimSteeredMessages(start.run.id));
    // Nothing half-done: the Run still owes the message, and the transcript does not hold it.
    const run = (await repository.getRun(id, start.run.id))!;
    assert.equal(run.consumedCount, 0);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0"]);
    restart();
    const retried = await repository.claimSteeredMessages(start.run.id);
    assert.deepEqual(retried.map((row) => row.clientMessageId), ["message-1"]);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0", "question 1"]);
  }));

  test(`${backend}: a tool call is answered once, by any instance, and never after it expired`, options, async () => withBackend(backend, async ({ repository }) => {
    const start = await repository.acceptSubmission(message(0));
    const call = { runId: start.run.id, toolCallId: "t1", name: "file_read", arguments: { path: "a.md" }, approval: "none" as const, requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    await repository.requestToolCall(call);
    await repository.requestToolCall(call);
    assert.equal((await repository.listToolCalls(start.run.id)).length, 1);
    // Another conversation cannot answer this Run's call.
    assert.equal(await repository.answerToolCall("scope:other:conversation", start.run.id, "t1", { status: "ok", result: {} }), false);
    assert.equal((await repository.listToolCalls(start.run.id))[0]!.outcome, undefined);
    const answers = await Promise.all([1, 2, 3].map((n) => repository.answerToolCall(id, start.run.id, "t1", { status: "ok", result: { n } })));
    assert.equal(answers.filter(Boolean).length, 1);
    const [stored] = await repository.listToolCalls(start.run.id);
    assert.equal(stored!.outcome?.status, "ok");
    assert.equal(await repository.answerToolCall(id, start.run.id, "unknown", { status: "ok", result: {} }), false);
    await repository.requestToolCall({ ...call, toolCallId: "t2", expiresAt: new Date(Date.now() - 1).toISOString() });
    assert.equal(await repository.answerToolCall(id, start.run.id, "t2", { status: "ok", result: {} }), false);
  }));

  test(`${backend}: one compaction runs per conversation; a new message preempts it; a Run that started makes its commit stale`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const first = await repository.beginCompaction({ id: "cmp_1", conversationId: id, executorId: "a", leaseMs: 60_000 });
    assert.equal(first.claimed, true);
    assert.equal((await repository.beginCompaction({ id: "cmp_2", conversationId: id, executorId: "b", leaseMs: 60_000 })).claimed, false);
    assert.equal(await repository.compactionStopped("cmp_1"), false);
    assert.equal(await repository.requestCompactionPreempt(id), true);
    assert.equal(await repository.compactionStopped("cmp_1"), true);
    assert.ok(await repository.runningCompaction(id));
    await repository.endCompaction("cmp_1");
    assert.equal(await repository.runningCompaction(id), undefined);

    const event = { type: "conversation.compacted" as const, conversation_id: id, run_id: "run-0", compaction_id: "cmp_3", trigger: "auto" as const, phase: "pre_turn" as const, reason: "context_limit" as const, message: "m", replacement_history: [{ role: "compactionSummary" as const, content: "summary" }] };
    const begun = await repository.beginCompaction({ id: "cmp_3", conversationId: id, executorId: "a", leaseMs: 60_000 });
    // A message arrives and starts a Run after the compaction read the history: its commit must not wipe that message.
    const run = await repository.acceptSubmission(message(0));
    assert.equal(await repository.commitCompaction({ conversationId: id, compactionId: "cmp_3", basis: { latestRunId: begun.latestRunId }, event, journal: { compaction_id: "cmp_3" } }), false);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["question 0"]);
    await repository.endCompaction("cmp_3");
    await repository.endRun(run.run.id, endingOf("completed"));
    const again = await repository.beginCompaction({ id: "cmp_4", conversationId: id, executorId: "a", leaseMs: 60_000 });
    assert.equal(again.latestRunId, run.run.id);
    assert.equal(await repository.commitCompaction({ conversationId: id, compactionId: "cmp_4", basis: { latestRunId: again.latestRunId }, event: { ...event, compaction_id: "cmp_4" }, journal: { compaction_id: "cmp_4", kind: "summarized" } }), true);
    assert.deepEqual((await store.readConversation(id)).map((row) => row.content), ["summary"]);
    const journal = (await repository.snapshot(id)).events.filter((row) => row.type === "compaction.completed");
    assert.deepEqual(journal.map((row) => row.payload.compaction_id), ["cmp_4"]);
    assert.equal(await repository.runningCompaction(id), undefined);
  }));

  test(`${backend}: no compaction claim is granted while a Run is active`, options, async () => withBackend(backend, async ({ repository }) => {
    await repository.acceptSubmission(message(0));
    assert.equal((await repository.beginCompaction({ id: "cmp_x", conversationId: id, executorId: "a", leaseMs: 60_000 })).claimed, false);
  }));
}
