import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresConversationRepository } from "../conversationRepository.js";
import { migrateUuidAuthorityIds } from "../uuidIdentityMigration.js";
import { ASSISTANT_AGENT_ID } from "./chat.js";

const connectionString = process.env.HATCH_TEST_DATABASE_URL;

// Conversation id columns are text (matching the code DDL, so contact principals fit); the Assistant's UUID-valued binding must still be stored and read back.
test("The Assistant's conversation with UUID-valued Agent and Product ids is created and read after the identity migration", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `assistant_identity_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const repository = new PostgresConversationRepository(pool);
    await repository.initialize();
    await migrateUuidAuthorityIds(pool);
    const types = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'hatch_conversations' AND column_name IN ('agent_id', 'product_id')`, [schema]);
    assert.deepEqual(types.rows.map(row => row.data_type), ["text", "text"], "the migration leaves them text, as the code declares");
    const account = randomUUID();
    const id = `conversation:assistant:${account}`;
    const { created } = await repository.createConversation({
      id, publicId: `conv_${randomUUID().replaceAll("-", "")}`, ownerAccountId: account, creatorId: account,
      agentId: ASSISTANT_AGENT_ID, productId: ASSISTANT_AGENT_ID, corpusDigest: ASSISTANT_AGENT_ID, clientRequestId: ASSISTANT_AGENT_ID,
    });
    assert.equal(created, true);
    const stored = await repository.getConversation(id);
    assert.deepEqual([stored?.agentId, stored?.productId], [ASSISTANT_AGENT_ID, ASSISTANT_AGENT_ID]);
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});
