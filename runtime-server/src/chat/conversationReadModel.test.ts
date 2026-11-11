import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import {
  InMemoryConversationRepository, PostgresConversationRepository,
  type AcceptSubmissionInput, type ConversationRepository
} from "../conversationRepository.js";
import { PostgresStore } from "../postgresStore.js";
import { LocalRuntimeAuthority, RuntimeStore } from "../store.js";
import { ChatConversationReadModel, type ConversationReadModel } from "./conversationReadModel.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const id = `scope:${"a".repeat(24)}:readmodel`;
const message = (n: number, extra: Record<string, unknown> = {}): AcceptSubmissionInput => ({
  binding,
  run: { id: `run-${n}`, conversationId: id, clientMessageId: `m-${n}`, inputDigest: `d-${n}`, corpusDigest: "corpus", executorId: "exec-a" },
  canonicalUser: { role: "user", content: `question ${n}`, ...extra } as never
});
const reply = (content: string) => ({ status: "completed" as const, reply: { message: { role: "assistant" as const, content }, finishReason: "stop" as const, visibleParts: [] } });

type Harness = { repository: ConversationRepository; store: RuntimeStore | PostgresStore; model: ConversationReadModel };
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

async function withBackend(name: "memory" | "postgres", body: (harness: Harness) => Promise<void>): Promise<void> {
  if (name === "memory") {
    const authority = new LocalRuntimeAuthority();
    const repository = new InMemoryConversationRepository(authority);
    const store = new RuntimeStore(authority);
    try {
      await repository.createConversation({ ...binding, id, publicId: "readmodel" });
      await body({ repository, store, model: new ChatConversationReadModel({ history: store, repository }) });
    } finally { await repository.close(); }
    return;
  }
  const schema = `readmodel_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    const store = new PostgresStore(pool);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(store);
    await repository.createConversation({ ...binding, id, publicId: "readmodel" });
    await body({ repository, store, model: new ChatConversationReadModel({ history: store, repository }) });
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

for (const backend of ["memory", "postgres"] as const) {
  const options = backend === "postgres" ? { skip: !databaseUrl, timeout: 30_000 } : {};

  test(`${backend}: a message sent during a Run is visible to another reader as queued, then as the same message once the Run claims it`, options, async () => withBackend(backend, async ({ repository, model }) => {
    const first = await repository.acceptSubmission(message(0));
    const pixels = { model_images: [{ mime_type: "image/png", data: "AAAA" }] };
    const steered = await repository.acceptSubmission(message(1, pixels));
    assert.equal(steered.steered, true);
    const during = (await model.page(id)).messages;
    assert.deepEqual(during.map((row) => [row.id, row.state]), [["m-0", undefined], ["m-1", "queued"]]);
    assert.equal(during[1]!.accepted_at, steered.receipt.accepted_at);
    assert.equal(during[1]!.content, "question 1");
    assert.ok(!JSON.stringify(during).includes("AAAA"), "the pixels stay on the server");
    // Another reader, after a refresh, sees the same.
    assert.deepEqual((await model.page(id)).messages, during);

    await repository.claimSteeredMessages(first.run.id);
    const after = (await model.page(id)).messages;
    assert.deepEqual(after.map((row) => [row.id, row.state]), [["m-0", undefined], ["m-1", undefined]]);
    assert.equal(after[1]!.accepted_at, steered.receipt.accepted_at, "the claim does not move when the message was accepted");
  }));

  test(`${backend}: ids are the client key for a user message and <run_id>:<n> for a reply, and stay the same across refresh and paging`, options, async () => withBackend(backend, async ({ repository, model }) => {
    for (const n of [0, 1, 2]) {
      const { run } = await repository.acceptSubmission(message(n));
      await repository.acceptSubmission({ ...message(n + 10), run: { ...message(n + 10).run, id: `run-${n + 10}` } }).catch(() => undefined);
      await repository.claimSteeredMessages(run.id);
      await repository.endRun(run.id, reply(`answer ${n}`));
    }
    const everything = (await model.page(id, { limit: 200 })).messages.map((row) => row.id);
    assert.ok(everything.includes("m-0") && everything.includes("run-0:1") && everything.includes("run-2:1"));
    assert.deepEqual((await model.page(id, { limit: 200 })).messages.map((row) => row.id), everything, "a refresh gives the same ids");
    const collected: string[] = [];
    let page = await model.page(id, { limit: 2 });
    collected.unshift(...page.messages.map((row) => row.id));
    for (let guard = 0; page.has_more; guard++) {
      assert.ok(guard < 20);
      page = await model.page(id, { limit: 2, beforeCursor: page.before_cursor });
      collected.unshift(...page.messages.map((row) => row.id));
    }
    assert.deepEqual(collected, everything, "paging gives the same ids, in the same order, with none twice");
  }));

  test(`${backend}: a Run's replies are numbered in the order they were written`, options, async () => withBackend(backend, async ({ repository, model }) => {
    const { run } = await repository.acceptSubmission(message(0));
    await repository.acceptSubmission(message(1));
    // A message joined after the last claim: the reply is kept and the Run stays open.
    assert.equal((await repository.endRun(run.id, reply("first"))).messageId, "run-0:1");
    await repository.claimSteeredMessages(run.id);
    const ended = await repository.endRun(run.id, reply("second"));
    assert.deepEqual([ended.ended, ended.messageId], [true, "run-0:2"]);
    assert.deepEqual((await model.page(id)).messages.map((row) => row.id), ["m-0", "run-0:1", "m-1", "run-0:2"]);
  }));

  test(`${backend}: a reply stored before ids were persisted is named <run_id>:<n> when read`, options, async () => withBackend(backend, async ({ repository, store, model }) => {
    const { run } = await repository.acceptSubmission(message(0));
    await store.append({ type: "conversation.model_message", conversation_id: id, run_id: run.id, message: { role: "assistant", content: "old reply" }, finish_reason: "stop" });
    await repository.endRun(run.id, { status: "cancelled", failure: { code: "run_cancelled", message: "stop" } });
    assert.deepEqual((await model.page(id)).messages.map((row) => row.id), ["m-0", "run-0:1"]);
  }));
}
