import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresConversationRepository } from "./conversationRepository.js";

const binding = { ownerAccountId: "cursor-owner", creatorId: "cursor-creator", agentId: "cursor-agent", productId: "cursor-product", corpusDigest: "cursor-corpus" };
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };

// Real PostgreSQL, opt-in, in a schema of its own.
async function isolated(body: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `conversation_cursor_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 12 });
    await body(pool);
  } finally {
    await pool?.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  }
}

const event = (conversationId: string, n: number) => ({ conversationId, type: "conversation.updated" as const, payload: { n } });

test("A journal event that commits late is never behind one an observer has already passed", options, async () => isolated(async pool => {
  const repository = new PostgresConversationRepository(pool);
  await repository.createConversation({ ...binding, id: "c1", publicId: "public-c1" });
  const head = await repository.journalHead("c1");
  // A transaction takes its number first and commits last; another append, outside it, comes in the meantime.
  const client = await pool.connect();
  await client.query("BEGIN");
  await PostgresConversationRepository.inTransaction(client).appendEvent(event("c1", 1));
  let settled = false;
  const outside = repository.appendEvent(event("c1", 2)).finally(() => { settled = true; });
  await sleep(200);
  try {
    assert.equal(settled, false, "the second append waits for the first to commit, so it cannot be seen before it");
    assert.deepEqual((await repository.journalPage("c1", head)).events, [], "an observer sees neither");
  } finally {
    await client.query("COMMIT");
    client.release();
  }
  await outside;
  const page = await repository.journalPage("c1", head);
  assert.deepEqual(page.events.map(entry => entry.payload.n), [1, 2]);
  assert.ok(page.events[0]!.cursor < page.events[1]!.cursor);
}));

test("Observers polling while appends commit in any interleaving never skip a cursor", options, async () => isolated(async pool => {
  const repository = new PostgresConversationRepository(pool);
  await repository.createConversation({ ...binding, id: "c1", publicId: "public-c1" });
  let seen = await repository.journalHead("c1");
  const observed: number[] = [];
  let writing = true;
  const observer = (async () => {
    const poll = async () => { const page = await repository.journalPage("c1", seen, undefined, 500); for (const entry of page.events) observed.push(entry.cursor); seen = page.cursor; };
    while (writing) { await poll(); await sleep(2); }
    await poll();
  })();
  const writers = Array.from({ length: 40 }, async (_unused, n) => {
    if (n % 2) return repository.appendEvent(event("c1", n));
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await PostgresConversationRepository.inTransaction(client).appendEvent(event("c1", n));
      await sleep(n % 5 * 3);
      await client.query("COMMIT");
    } finally { client.release(); }
  });
  await Promise.all(writers);
  writing = false;
  await observer;
  const all = (await pool.query("SELECT cursor FROM hatch_conversation_journal WHERE conversation_id = 'c1' AND event_type = 'conversation.updated' ORDER BY cursor")).rows.map(row => Number(row.cursor));
  assert.equal(all.length, 40);
  assert.deepEqual(observed.filter(cursor => all.includes(cursor)), all, "every event was seen, in order, once");
}));
