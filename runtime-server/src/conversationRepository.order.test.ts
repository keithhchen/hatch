import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Pool } from "pg";
import {
  FileConversationRepository,
  InMemoryConversationRepository,
  PostgresConversationRepository,
  type ConversationRepository
} from "./conversationRepository.js";

const binding = {
  ownerAccountId: "order-owner", creatorId: "order-creator", agentId: "order-agent",
  productId: "order-product", corpusDigest: "order-corpus"
};
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const oldTime = "2025-01-01T00:00:00.000Z";
const tiedTime = "2025-01-02T00:00:00.000Z";
const newTime = "2025-01-03T00:00:00.000Z";
const expected = ["new", "中文", "z", "a", "_", "Z", "A", "old"];

// Real PostgreSQL, opt-in, with no access to public/application tables.
async function isolatedPostgres(body: (pool: Pool) => Promise<void>): Promise<void> {
  const schema = `conversation_order_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000 });
    await body(pool);
  } finally {
    await pool?.end();
    try { if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await admin.end(); }
  }
}

for (const backend of ["memory", "file", "postgres"] as const) {
  test(`${backend}: creation order and saved cursors survive messages, run changes, edits and new conversations`, {
    skip: backend === "postgres" && !connectionString,
    timeout: 30_000
  }, async (t) => {
    if (backend !== "postgres") t.mock.timers.enable({ apis: ["Date"], now: new Date(oldTime) });
    const exercise = async (pool?: Pool) => {
      const root = backend === "file" ? await mkdtemp(path.join(os.tmpdir(), "conversation-order-")) : undefined;
      let repository: ConversationRepository = pool ? new PostgresConversationRepository(pool)
        : root ? new FileConversationRepository(root) : new InMemoryConversationRepository();
      try {
        const createAt = async (id: string, createdAt: string, scope = binding) => {
          if (!pool) t.mock.timers.setTime(Date.parse(createdAt));
          await repository.createConversation({ ...scope, id, publicId: `public-${id}` });
          // Deterministic historical timestamps, including ties, in the real DB.
          if (pool) await pool.query(
            "UPDATE hatch_conversations SET created_at = $2::timestamptz, updated_at = $2::timestamptz WHERE id = $1",
            [id, createdAt]
          );
        };
        await createAt("old", oldTime);
        for (const id of ["A", "a", "Z", "z", "_", "中文"]) await createAt(id, tiedTime);
        await createAt("new", newTime);
        for (const key of ["ownerAccountId", "creatorId", "agentId"] as const) {
          await createAt(`foreign-${key}`, newTime, { ...binding, [key]: "foreign" });
        }
        const ids = async () => (await repository.listConversations(binding)).conversations.map((row) => row.id);
        assert.deepEqual(await ids(), expected, "creation DESC, bytewise ID DESC, scoped to the binding");
        const first = await repository.listConversations(binding, { status: "active", limit: 3 });
        assert.deepEqual(first.conversations.map((row) => row.id), expected.slice(0, 3));
        assert.ok(first.nextCursor);
        const cursor = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"));
        assert.equal(cursor.id, "z");
        assert.equal(Date.parse(cursor.createdAt), Date.parse(tiedTime));
        assert.equal("updatedAt" in cursor, false);

        if (!pool) t.mock.timers.setTime(Date.parse("2026-01-01T00:00:00.000Z"));
        // Update a not-yet-delivered row, the cursor anchor, and an earlier row.
        for (const id of ["old", "z", "new"]) {
          await repository.updateConversation(id, { title: `renamed ${id}` });
          assert.deepEqual(await ids(), expected);
        }
        await repository.createRun({
          id: "run-old", conversationId: "old", clientMessageId: "message-old",
          inputDigest: "input", corpusDigest: binding.corpusDigest
        });
        assert.deepEqual(await ids(), expected);
        for (const status of ["running", "waiting_for_tool", "completed"] as const) {
          await repository.transitionRun("run-old", status);
          assert.deepEqual(await ids(), expected);
        }
        await repository.appendEvent({
          conversationId: "old", runId: "run-old", type: "message.created", payload: { content: "new message" }
        });
        assert.deepEqual(await ids(), expected);
        const old = await repository.getConversation("old");
        assert.equal(old?.createdAt, oldTime);
        assert.ok(old!.updatedAt > newTime, "activity timestamp still advances independently");

        // Even removing the cursor anchor from the status filter cannot move it.
        await repository.updateConversation("z", { status: "archived" });
        assert.deepEqual((await repository.listConversations(binding, { status: "archived" })).conversations.map((row) => row.id), ["z"]);
        await createAt("newest", "2026-02-01T00:00:00.000Z");
        if (root) {
          await repository.close();
          repository = new FileConversationRepository(root);
        }
        assert.deepEqual(await ids(), ["newest", ...expected]);
        const second = await repository.listConversations(binding, { status: "active", cursor: first.nextCursor, limit: 3 });
        assert.deepEqual(second.conversations.map((row) => row.id), expected.slice(3, 6));
        assert.ok(second.nextCursor);
        const third = await repository.listConversations(binding, { status: "active", cursor: second.nextCursor, limit: 3 });
        assert.deepEqual(third.conversations.map((row) => row.id), expected.slice(6));
        assert.equal(third.nextCursor, undefined);
        assert.deepEqual([...first.conversations, ...second.conversations, ...third.conversations].map((row) => row.id), expected);
        const replay = await repository.listConversations(binding, { status: "active", cursor: first.nextCursor, limit: 3 });
        assert.deepEqual(replay, second, "the same saved cursor returns the same remaining page");

        for (const invalid of ["broken", Buffer.from(JSON.stringify({ updatedAt: tiedTime, id: "z" })).toString("base64url")]) {
          await assert.rejects(repository.listConversations(binding, { cursor: invalid }), RangeError);
        }
      } finally {
        await repository.close();
        if (root) await rm(root, { recursive: true, force: true });
      }
    };
    if (backend === "postgres") await isolatedPostgres(exercise);
    else await exercise();
  });
}

test("postgres: creation cursor retains microseconds and replaces the legacy activity index", {
  skip: !connectionString, timeout: 30_000
}, async () => isolatedPostgres(async (pool) => {
  const repository = new PostgresConversationRepository(pool);
  await repository.initialize();
  await pool.query(`CREATE INDEX hatch_conversations_library_idx
    ON hatch_conversations (owner_account_id, creator_id, agent_id, updated_at DESC, id DESC)`);
  await new PostgresConversationRepository(pool).initialize();
  const indexes = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()");
  assert.equal(indexes.rows.some((row) => row.indexname === "hatch_conversations_library_idx"), false);
  assert.match(indexes.rows.find((row) => row.indexname === "hatch_conversations_library_created_idx")!.indexdef,
    /created_at DESC, id COLLATE "C" DESC/);
  for (const [id, fraction] of [["a", "000900"], ["z", "000800"], ["m", "000100"]]) {
    await repository.createConversation({ ...binding, id, publicId: id });
    await pool.query("UPDATE hatch_conversations SET created_at = $2::timestamptz WHERE id = $1", [id, `2025-01-01T00:00:00.${fraction}Z`]);
  }
  const first = await repository.listConversations(binding, { limit: 1 });
  assert.equal(first.conversations[0]?.id, "a");
  assert.ok(first.nextCursor);
  assert.equal(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8")).createdAt, "2025-01-01T00:00:00.000900Z");
  await repository.updateConversation("a", { title: "updated cursor anchor" });
  const second = await repository.listConversations(binding, { cursor: first.nextCursor, limit: 1 });
  assert.equal(second.conversations[0]?.id, "z");
  assert.ok(second.nextCursor);
  const third = await repository.listConversations(binding, { cursor: second.nextCursor, limit: 1 });
  assert.equal(third.conversations[0]?.id, "m");
  assert.equal(third.nextCursor, undefined);
}));
