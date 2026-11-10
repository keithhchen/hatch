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
const id = `scope:${"b".repeat(24)}:steer`;
const message = (n: number): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `message-${n}`, inputDigest: `digest-${n}`, corpusDigest: "corpus", executorId: "exec-a" },
  canonicalUser: { role: "user", content: `question ${n}` }
});

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "file" | "postgres", body: (harness: Harness) => Promise<void>): Promise<void> {
  if (name !== "postgres") {
    const root = name === "file" ? await mkdtemp(path.join(os.tmpdir(), "hatch-steer-")) : undefined;
    const authority = new LocalRuntimeAuthority(root);
    const repository = new InMemoryConversationRepository(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "steer" });
      await body({ repository, store: new RuntimeStore(authority) });
    } finally {
      await repository.close();
      if (root) await rm(root, { recursive: true, force: true });
    }
    return;
  }
  const schema = `steer_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "steer" });
    await body({ repository, store });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

for (const backend of ["memory", "file", "postgres"] as const) {
  const options = { skip: backend === "postgres" && !databaseUrl };

  test(`${backend}: racing messages start exactly one Run and every other message steers it`, options, async () => withBackend(backend, async ({ repository }) => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, n) => repository.acceptSubmission(message(n))));
    assert.equal(results.filter((row) => row.created).length, 1);
    assert.equal(results.filter((row) => row.steered).length, 7);
    const runs = await repository.listRuns(id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.steeredCount, 7);
    assert.ok(results.every((row) => row.run.id === runs[0]!.id));
  }));

  test(`${backend}: a steered message is idempotent per message and conflicts on a different digest`, options, async () => withBackend(backend, async ({ repository }) => {
    await repository.acceptSubmission(message(0));
    const first = await repository.acceptSubmission(message(1));
    assert.equal(first.steered, true);
    const replay = await repository.acceptSubmission({ ...message(1), run: { ...message(1).run, id: "other-run" } });
    assert.deepEqual([replay.created, replay.steered, replay.run.id], [false, false, first.run.id]);
    await assert.rejects(repository.acceptSubmission({ ...message(1), run: { ...message(1).run, inputDigest: "changed" } }), { code: "client_message_conflict" });
    assert.equal((await repository.listRuns(id))[0]!.steeredCount, 1);
  }));

  test(`${backend}: claiming hands each steered message to its Run once, in order, and a Run cannot complete past an unclaimed one`, options, async () => withBackend(backend, async ({ repository }) => {
    const start = await repository.acceptSubmission(message(0));
    await repository.acceptSubmission(message(1));
    await repository.acceptSubmission(message(2));
    await assert.rejects(repository.transitionRun(start.run.id, "completed"), { code: "steer_pending" });
    assert.equal((await repository.getRun(id, start.run.id))!.status, "queued");
    const claimed = await Promise.all([repository.claimSteeredMessages(start.run.id), repository.claimSteeredMessages(start.run.id)]);
    const messages = claimed.flat();
    assert.deepEqual(messages.map((row) => row.clientMessageId), ["message-1", "message-2"]);
    assert.deepEqual(messages.map((row) => row.message.content), ["question 1", "question 2"]);
    assert.equal((await repository.transitionRun(start.run.id, "completed")).status, "completed");
    // The Run is over: the next message starts a new Run instead of joining it.
    const next = await repository.acceptSubmission(message(3));
    assert.equal(next.created, true);
    assert.notEqual(next.run.id, start.run.id);
  }));

  for (const terminal of ["cancelled", "failed", "interrupted"] as const) {
    test(`${backend}: a Run that ends ${terminal} claims its steered messages in the same transition`, options, async () => withBackend(backend, async ({ repository, store }) => {
      const start = await repository.acceptSubmission(message(0));
      await repository.acceptSubmission(message(1));
      await repository.acceptSubmission(message(2));
      const ended = await repository.transitionRun(start.run.id, terminal, "stopped");
      assert.equal(ended.status, terminal);
      assert.equal(ended.consumedCount, 2);
      assert.deepEqual((await store.readVisibleConversation(id)).map((row) => row.content), ["question 0", "question 1", "question 2"]);
      const events = (await repository.snapshot(id)).events;
      assert.deepEqual(events.filter((event) => event.type === "message.consumed").map((event) => event.payload.client_message_id), ["message-1", "message-2"]);
      // The claim and the transition are one commit: the claim precedes the terminal state in the journal.
      const types = events.map((event) => event.type);
      assert.ok(types.lastIndexOf("message.consumed") < types.lastIndexOf("run.state"));
    }));
  }

  test(`${backend}: a claimed message is dated when it arrived, as its receipt says, not when the Run claimed it`, options, async () => withBackend(backend, async ({ repository, store }) => {
    const start = await repository.acceptSubmission(message(0));
    const steered = await repository.acceptSubmission(message(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await repository.claimSteeredMessages(start.run.id);
    const history = await store.readVisibleConversation(id);
    const row = history.find((entry) => entry.content === "question 1")!;
    assert.equal(row.timestamp, steered.receipt.accepted_at);
    const consumed = (await repository.snapshot(id)).events.find((event) => event.type === "message.consumed")!;
    assert.ok(Date.parse(consumed.createdAt) - Date.parse(row.timestamp) >= 40);
  }));

  test(`${backend}: messages racing a Run's end never deadlock and are each claimed or start the next Run`, options, async () => withBackend(backend, async ({ repository }) => {
    let n = 0;
    const submit = (): Promise<unknown> => repository.acceptSubmission(message(n++)).catch((error: unknown) => error);
    const first = await repository.acceptSubmission(message(n++));
    // The Run ends while a burst arrives: claim then complete, retrying while a message joined in between.
    const finish = async (runId: string): Promise<void> => {
      for (;;) {
        await repository.claimSteeredMessages(runId);
        try { await repository.transitionRun(runId, "completed"); return; } catch (error) { if ((error as { code?: string }).code !== "steer_pending") throw error; }
      }
    };
    const outcomes = await Promise.all([finish(first.run.id), ...Array.from({ length: 12 }, submit)]);
    assert.deepEqual(outcomes.filter((outcome) => outcome instanceof Error), []);
    // Whatever did not steer a Run started its own: nothing is lost.
    const runs = await repository.listRuns(id);
    assert.equal(runs.reduce((sum, run) => sum + 1 + run.steeredCount, 0), n);
    assert.ok(runs.every((run) => run.status === "completed" || run.consumedCount <= run.steeredCount));
  }));

  test(`${backend}: partial output is persisted on the Run for a snapshot`, options, async () => withBackend(backend, async ({ repository }) => {
    const start = await repository.acceptSubmission(message(0));
    await repository.savePartialOutput(start.run.id, "Hello wor");
    assert.equal((await repository.snapshot(id)).runs[0]!.partialOutput, "Hello wor");
  }));

  test(`${backend}: an orphaned Run is taken over by exactly one instance, and a live lease is not`, options, async () => withBackend(backend, async ({ repository }) => {
    const start = await repository.acceptSubmission({ ...message(0), run: { ...message(0).run, executorLeaseExpiresAt: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(start.created, true);
    const claims = await Promise.all(["exec-b", "exec-c"].map((executor) => repository.claimOrphanedRuns(executor, 60_000)));
    assert.equal(claims.flat().length, 1);
    const owner = claims.flat()[0]!.executorId!;
    assert.deepEqual(await repository.claimOrphanedRuns("exec-d", 60_000), []);
    assert.equal(await repository.renewLease(start.run.id, "exec-a", 60_000), false);
    assert.equal(await repository.renewLease(start.run.id, owner, 60_000), true);
  }));
}
