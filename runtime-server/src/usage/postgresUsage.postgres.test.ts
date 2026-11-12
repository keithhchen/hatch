import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresUsageLedger } from "./postgresUsage.js";
import type { UsageEvent } from "./usage.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const options = { skip: !connectionString, timeout: 60_000 };
const at = new Date("2026-11-10T12:00:00Z");
const now = new Date("2026-11-13T00:00:00Z");
const event = (id: string, overrides: Partial<UsageEvent> = {}): UsageEvent => ({
  id, accountId: "acct", surface: "chat_web", model: "m", inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, reasoningTokens: 5, at, ...overrides
});

async function isolated(body: (pool: Pool) => Promise<void>) {
  const schema = `usage_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 8 });
    await body(pool);
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

test("a call recorded twice, even at once, is one event and one increment", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await Promise.all(Array.from({ length: 10 }, () => ledger.record(event("same"))));
  await ledger.record(event("same"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_usage_events")).rows[0].n, 1);
  assert.deepEqual((await ledger.monthToDate("acct", now)).chat_web, { input: 100, cachedInput: 40, output: 20, reasoning: 5 });
}));

test("concurrent increments of one day's rollup lose nothing, and the rollup equals the events", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await Promise.all(Array.from({ length: 40 }, (_, index) => ledger.record(event(`call-${index}`, { surface: index % 2 ? "studio" : "chat_api" }))));
  const month = await ledger.monthToDate("acct", now);
  assert.equal(month.studio.input, 2_000);
  assert.equal(month.chat_api.output, 400);
  const { rows } = await pool.query("SELECT sum(input_tokens)::int AS events, (SELECT sum(input_tokens)::int FROM hatch_usage_daily) AS rollup FROM hatch_usage_events");
  assert.equal(rows[0].events, rows[0].rollup);
}));

test("an event that cannot be written leaves the rollup untouched", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await ledger.record(event("first"));
  await assert.rejects(ledger.record(event("bad", { surface: "nowhere" as never })));
  assert.deepEqual((await ledger.monthToDate("acct", now)).chat_web.input, 100);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_usage_daily")).rows[0].n, 1);
}));

test("daily reads a range by surface, and the month starts on the first (UTC)", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await ledger.record(event("a"));
  await ledger.record(event("b", { surface: "studio", at: new Date("2026-11-01T00:00:00Z") }));
  await ledger.record(event("c", { at: new Date("2026-10-31T23:59:59Z") }));
  const days = await ledger.daily("acct", "2026-10-31", "2026-11-10");
  assert.deepEqual(days.map(({ day }) => day), ["2026-10-31", "2026-11-01", "2026-11-10"]);
  assert.equal(days[1]!.usage.studio.input, 100);
  const month = await ledger.monthToDate("acct", now);
  assert.equal(month.chat_web.input, 100);
  assert.equal(month.studio.input, 100);
}));
