import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresConversationRepository } from "../conversationRepository.js";
import { migrateUuidAuthorityIds } from "../uuidIdentityMigration.js";
import { ASSISTANT_AGENT_ID } from "./chat.js";

const connectionString = process.env.HATCH_TEST_DATABASE_URL;

// Production's conversations hold UUID identities once the identity migration has run; the Assistant's binding must fit them.
test("The Assistant's conversation can be created where Agent and Product ids are UUIDs", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `assistant_identity_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const repository = new PostgresConversationRepository(pool);
    await repository.initialize();
    await migrateUuidAuthorityIds(pool);
    const types = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'hatch_conversations' AND column_name IN ('agent_id', 'product_id')`, [schema]);
    assert.deepEqual(types.rows.map(row => row.data_type), ["uuid", "uuid"], "the migration made them UUIDs, as in production");
    const account = randomUUID();
    const { created } = await repository.createConversation({
      id: `conversation:assistant:${account}`, publicId: `conv_${randomUUID().replaceAll("-", "")}`, ownerAccountId: account, creatorId: account,
      agentId: ASSISTANT_AGENT_ID, productId: ASSISTANT_AGENT_ID, corpusDigest: ASSISTANT_AGENT_ID, clientRequestId: ASSISTANT_AGENT_ID,
    });
    assert.equal(created, true);
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});
