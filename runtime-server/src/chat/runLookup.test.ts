import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { InMemoryConversationRepository, PostgresConversationRepository, type ConversationRepository } from "../conversationRepository.js";

const binding = { ownerAccountId: "owner", creatorId: "creator", agentId: "agent", productId: "product", corpusDigest: "corpus" };
const conversation = { ...binding, id: `scope:${"a".repeat(24)}:lookup`, publicId: "lookup" };
const run = { id: "run-1", conversationId: conversation.id, clientMessageId: "message", inputDigest: "digest", corpusDigest: "corpus", executorId: "executor" };

async function contract(repository: ConversationRepository) {
  await repository.createConversation(conversation);
  await repository.createRun(run);
  // A caller that knows no conversation, such as the channel layer, finds a Run by its id alone.
  assert.equal((await repository.findRun("run-1"))?.conversationId, conversation.id);
  assert.equal(await repository.findRun("run-unknown"), undefined);
  assert.equal(await repository.latestRunStateCursor("run-unknown"), undefined);
  // Every state change moves the cursor, so each compaction of a Run is named by its own.
  await repository.transitionRun("run-1", "running");
  const running = await repository.latestRunStateCursor("run-1");
  await repository.transitionRun("run-1", "compacting");
  const first = await repository.latestRunStateCursor("run-1");
  assert.equal(await repository.latestRunStateCursor("run-1"), first, "stable while the Run stays in one state");
  await repository.transitionRun("run-1", "running");
  await repository.transitionRun("run-1", "compacting");
  const second = await repository.latestRunStateCursor("run-1");
  assert.ok(running! < first! && first! < second!);
}

test("memory: a Run is found by its id and each state change has its own cursor", async () => contract(new InMemoryConversationRepository()));

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;
test("real PG: a Run is found by its id and each state change has its own cursor", { skip: !databaseUrl }, async () => {
  const schema = `lookup_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, statement_timeout: 5_000 });
    await contract(new PostgresConversationRepository(pool));
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
