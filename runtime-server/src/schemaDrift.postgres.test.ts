import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, PostgresConversationRepository } from "./conversationRepository.js";
import { POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, PostgresCreatorFactoryRepository } from "./creatorLearning/repository.js";

const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };

/** Every column the code declares as text that production once held as uuid. The drift query compares these with the live catalog. */
const EXPECTED_TEXT_COLUMNS = [
  ["hatch_conversations", "owner_account_id"], ["hatch_conversations", "creator_id"], ["hatch_conversations", "agent_id"],
  ["hatch_conversations", "product_id"], ["hatch_conversations", "product_id_at_creation"], ["hatch_creator_factory_runs", "creator_id"]
];

async function drift(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1)",
    [[...new Set(EXPECTED_TEXT_COLUMNS.map(([table]) => table))]]
  );
  return EXPECTED_TEXT_COLUMNS.flatMap(([table, column]) => {
    const actual = rows.find((row) => row.table_name === table && row.column_name === column)?.data_type;
    return actual === "text" ? [] : [`${table}.${column}: ${actual ?? "missing"} (code: text)`];
  });
}

// Real PostgreSQL, opt-in, in a schema of its own.
async function isolated(body: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `schema_drift_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000 });
    await body(pool);
  } finally {
    await pool?.end();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  }
}

const tableDdl = (schemaSql: string, table: string) => {
  const start = schemaSql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  return schemaSql.slice(start, schemaSql.indexOf("\n);", start) + 3);
};

test("ensure-schema converts production's uuid id columns to text, keeps rows, and stores a contact conversation", options, async () => isolated(async (pool) => {
  // The tables as production has them: the code's own DDL with the id columns uuid.
  const uuidColumns = /^(\s+(?:owner_account_id|creator_id|agent_id|product_id|product_id_at_creation)) TEXT/gm;
  await pool.query(tableDdl(POSTGRES_CONVERSATION_REPOSITORY_SCHEMA, "hatch_conversations").replace(uuidColumns, "$1 UUID"));
  await pool.query(tableDdl(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA, "hatch_creator_factory_runs").replace(uuidColumns, "$1 UUID"));
  const [owner, creator, agent] = [randomUUID(), randomUUID(), randomUUID()];
  await pool.query(
    `INSERT INTO hatch_conversations (id, public_id, owner_account_id, creator_id, agent_id, product_id, corpus_digest, product_id_at_creation, status, version)
     VALUES ('old', 'pub-old', $1, $2, $3, $3, 'c', $3, 'active', 1)`, [owner, creator, agent]);
  assert.equal((await drift(pool)).length, 6, "the seed reproduces production's drift");

  const conversations = new PostgresConversationRepository(pool);
  await conversations.initialize();
  await new PostgresCreatorFactoryRepository(pool).initialize();
  await conversations.initialize(); // idempotent: a second boot finds nothing to convert

  assert.deepEqual(await drift(pool), []);
  assert.equal((await pool.query("SELECT owner_account_id FROM hatch_conversations WHERE id = 'old'")).rows[0].owner_account_id, owner);

  const contactOwner = `contact:${randomUUID()}:${randomUUID()}`;
  const input = { ownerAccountId: contactOwner, creatorId: creator, agentId: agent, productId: agent, corpusDigest: "c", id: "contact-conversation", publicId: "pub-contact", clientRequestId: "thread:t1" };
  const created = await conversations.createConversation(input);
  assert.equal(created.created, true);
  assert.equal((await conversations.createConversation({ ...input, id: "other" })).conversation.id, "contact-conversation");
  assert.equal((await conversations.getConversation("contact-conversation"))?.ownerAccountId, contactOwner);
}));
