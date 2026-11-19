import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresKimiSessions } from "./sessions.js";

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

test("Postgres sessions: one open session per conversation, the first page of an artifact stays, concurrent records agree", { skip: !databaseUrl && "HATCH_TEST_DATABASE_URL is not set" }, async () => {
  const schema = `kimi_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  const pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 4 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const sessions = new PostgresKimiSessions(pool as never);
    await sessions.initialize();
    await sessions.create({ sessionId: "s1", conversationId: "c1", runId: "r1" });
    await sessions.create({ sessionId: "s1", conversationId: "c1", runId: "r1" });
    assert.equal((await sessions.open("c1"))?.sessionId, "s1");
    await sessions.markMessageSent("s1");
    await sessions.saveCursor("s1", "e7");
    await sessions.adopt("s1", "r2");
    assert.deepEqual(await sessions.open("c1"), { sessionId: "s1", conversationId: "c1", runId: "r2", messageSent: true, cursor: "e7", pages: {}, finished: false });
    const urls = await Promise.all(["a", "b", "c", "d"].map(label => sessions.recordPage("s1", "art_1", `https://x/${label}`)));
    assert.equal(new Set(urls).size, 1);
    assert.equal((await sessions.open("c1"))?.pages.art_1, urls[0]);
    await sessions.finish("s1");
    assert.equal(await sessions.open("c1"), undefined);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
