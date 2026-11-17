import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { InMemoryConversationRepository, PostgresConversationRepository, type ConversationRepository } from "./conversationRepository.js";
import { PostgresStore } from "./postgresStore.js";
import { TASK_START_DIGEST } from "./protocol.js";

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
const GUEST = `guest:${"G".repeat(22)}`;
const binding = (ownerAccountId: string, productId = "p1") => ({ ownerAccountId, creatorId: "creator", agentId: productId, productId, corpusDigest: "d" });
const submit = (owner: string, conversationId: string, n: number, inputDigest = `digest-${n}`) => ({
  binding: binding(owner),
  run: { id: `run-${conversationId}-${n}`, conversationId, clientMessageId: `m-${conversationId}-${n}`, inputDigest, corpusDigest: "d", executorId: "e" },
  canonicalUser: { role: "user" as const, content: "x" }
});

async function withBackend(name: "memory" | "postgres", body: (repository: ConversationRepository, pool?: Pool) => Promise<void>): Promise<void> {
  if (name === "memory") return body(new InMemoryConversationRepository());
  const schema = `open_access_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const repository = new PostgresConversationRepository(pool);
    repository.bindSubmissionStore(new PostgresStore(pool));
    await repository.initialize();
    await body(repository, pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
}

for (const backend of ["memory", "postgres"] as const) {
  const options = { skip: backend === "postgres" && !databaseUrl };

  test(`${backend}: a visitor's conversations become the account's atomically and exactly once, and its Agents are listed first`, options, async () => withBackend(backend, async (repository, pool) => {
    await repository.createConversation({ ...binding(GUEST), id: "c1", publicId: "conv_1", clientRequestId: "k" });
    await repository.createConversation({ ...binding(GUEST, "p2"), id: "c2", publicId: "conv_2" });
    await repository.createConversation({ ...binding("someone"), id: "c3", publicId: "conv_3" });
    assert.deepEqual((await repository.ownedProductIds(GUEST)).sort(), ["p1", "p2"]);
    if (pool) {
      // Report mode's own record moves with the conversation, in the same transaction.
      await pool.query("CREATE TABLE hatch_artifact_reports (conversation_id TEXT PRIMARY KEY, product_id TEXT, owner_account_id TEXT NOT NULL)");
      await pool.query("INSERT INTO hatch_artifact_reports VALUES ('c1', 'p1', $1), ('c3', 'p1', 'someone')", [GUEST]);
    }

    assert.equal(await repository.reown(GUEST, "account-1"), 2);
    assert.equal(await repository.reown(GUEST, "account-1"), 0);
    assert.deepEqual(await repository.ownedProductIds(GUEST), []);
    assert.equal((await repository.findOwnedConversation({ ownerAccountId: "account-1", creatorId: "creator" }, "conv_2"))?.id, "c2");
    assert.equal((await repository.getConversation("c3"))?.ownerAccountId, "someone");
    if (pool) assert.deepEqual((await pool.query("SELECT conversation_id, owner_account_id FROM hatch_artifact_reports ORDER BY 1")).rows, [{ conversation_id: "c1", owner_account_id: "account-1" }, { conversation_id: "c3", owner_account_id: "someone" }]);
    // The request key went with the old owner: the account can use the same key for a new conversation.
    assert.equal((await repository.createConversation({ ...binding("account-1"), id: "c4", publicId: "conv_4", clientRequestId: "k" })).created, true);
  }));

  test(`${backend}: the Run that starts a task is not a sent message, and the creator's Users view counts each owner once`, options, async () => withBackend(backend, async (repository) => {
    await repository.createConversation({ ...binding(GUEST), id: "c1", publicId: "conv_1" });
    await repository.createConversation({ ...binding(GUEST), id: "c2", publicId: "conv_2" });
    await repository.createConversation({ ...binding("account-1"), id: "c3", publicId: "conv_3" });
    await repository.createConversation({ ...binding("creator"), id: "c4", publicId: "conv_4" });
    await repository.createConversation({ ...binding("contact:conn:person", "p2"), id: "c5", publicId: "conv_5" });
    await repository.acceptSubmission(submit(GUEST, "c1", 1, TASK_START_DIGEST));
    await repository.acceptSubmission(submit(GUEST, "c2", 2));
    await repository.acceptSubmission(submit("account-1", "c3", 3));
    assert.equal(await repository.countSentMessages(binding(GUEST)), 1);

    const audience = await repository.listAudience("creator");
    const rows = audience.map(({ firstAt, lastAt, ...row }) => row).sort((a, b) => a.ownerAccountId.localeCompare(b.ownerAccountId));
    assert.deepEqual(rows, [
      { productId: "p1", ownerAccountId: "account-1", conversations: 1, messages: 1 },
      { productId: "p2", ownerAccountId: "contact:conn:person", conversations: 1, messages: 0 },
      { productId: "p1", ownerAccountId: GUEST, conversations: 2, messages: 1 }
    ], "the creator's own conversations are not their audience");
    assert.deepEqual((await repository.listAudience("creator", { productId: "p2" })).map((row) => row.ownerAccountId), ["contact:conn:person"]);
    assert.deepEqual(await repository.listAudience("someone-else"), []);
  }));
}
