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

test("a run's usage is the sum of its calls, and only its own", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await ledger.record(event("r1-a", { runId: "run_one", inputTokens: 100, cachedInputTokens: 30, outputTokens: 20, reasoningTokens: 5 }));
  await ledger.record(event("r1-b", { runId: "run_one", inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 0 }));
  await ledger.record(event("r2-a", { runId: "run_two" }));
  assert.deepEqual(await ledger.forRun("run_one"), { input: 110, cachedInput: 30, output: 25, reasoning: 5 });
  assert.deepEqual(await ledger.forRun("run_none"), { input: 0, cachedInput: 0, output: 0, reasoning: 0 });
}));

test("a call recorded twice, even at once, is one event and one increment", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await Promise.all(Array.from({ length: 10 }, () => ledger.record(event("same"))));
  await ledger.record(event("same"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_usage_events")).rows[0].n, 1);
  assert.deepEqual((await ledger.monthToDate("acct", now)).chat_web, { input: 100, cachedInput: 40, output: 20, reasoning: 5 });
}));

test("concurrent increments of one day's rollup lose nothing, and the rollup equals the events", options, () => isolated(async (pool) => {
  const ledger = new PostgresUsageLedger(pool);
  await Promise.all(Array.from({ length: 40 }, (_, index) => ledger.record(event(`call-${index}`, { surface: index % 2 ? "studio_web" : "responses_api" }))));
  const month = await ledger.monthToDate("acct", now);
  assert.equal(month.studio_web.input, 2_000);
  assert.equal(month.responses_api.output, 400);
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
  await ledger.record(event("b", { surface: "studio_web", at: new Date("2026-11-01T00:00:00Z") }));
  await ledger.record(event("c", { at: new Date("2026-10-31T23:59:59Z") }));
  const days = await ledger.daily("acct", "2026-10-31", "2026-11-10");
  assert.deepEqual(days.map(({ day }) => day), ["2026-10-31", "2026-11-01", "2026-11-10"]);
  assert.equal(days[1]!.usage.studio_web.input, 100);
  const month = await ledger.monthToDate("acct", now);
  assert.equal(month.chat_web.input, 100);
  assert.equal(month.studio_web.input, 100);
}));

/** The tables as the three-surface release created them, with rows from before the split. */
const OLD_DDL = [
  `CREATE TABLE hatch_usage_events (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('studio', 'chat_api', 'chat_web')),
    api_key_id TEXT, product_id TEXT, run_id TEXT, model TEXT NOT NULL,
    input_tokens BIGINT NOT NULL, cached_input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL)`,
  `CREATE TABLE hatch_usage_daily (
    account_id TEXT NOT NULL, surface TEXT NOT NULL, day DATE NOT NULL,
    input_tokens BIGINT NOT NULL, cached_input_tokens BIGINT NOT NULL, output_tokens BIGINT NOT NULL, reasoning_tokens BIGINT NOT NULL,
    PRIMARY KEY (account_id, surface, day))`,
  `INSERT INTO hatch_usage_events VALUES
    ('s-web', 'acct', 'studio', NULL, 'p', 'r1', 'm', 10, 0, 1, 0, '2026-11-10T12:00:00Z'),
    ('s-web2', 'acct', 'studio', NULL, 'p', 'r1', 'm', 20, 0, 2, 0, '2026-11-10T13:00:00Z'),
    ('s-api', 'acct', 'studio', 'key-1', 'p', 'r2', 'm', 30, 0, 3, 0, '2026-11-10T12:00:00Z'),
    ('c-api', 'acct', 'chat_api', 'key-1', 'p', 'r3', 'm', 40, 0, 4, 0, '2026-11-11T12:00:00Z'),
    ('c-web', 'acct', 'chat_web', NULL, 'p', 'r4', 'm', 50, 0, 5, 0, '2026-11-11T12:00:00Z')`,
  `INSERT INTO hatch_usage_daily VALUES
    ('acct', 'studio', '2026-11-10', 60, 0, 6, 0), ('acct', 'chat_api', '2026-11-11', 40, 0, 4, 0), ('acct', 'chat_web', '2026-11-11', 50, 0, 5, 0)`
];

test("tables from the three-surface release are moved to the four, once, even when boots race", options, () => isolated(async (pool) => {
  for (const statement of OLD_DDL) await pool.query(statement);
  // Two processes booting at once: both ask the ledger for something, so both run the schema step.
  await Promise.all([new PostgresUsageLedger(pool).monthToDate("acct", now), new PostgresUsageLedger(pool).monthToDate("acct", now)]);
  const surfaces = (await pool.query("SELECT id, surface FROM hatch_usage_events ORDER BY id")).rows.map(row => `${row.id}:${row.surface}`);
  assert.deepEqual(surfaces, ["c-api:responses_api", "c-web:chat_web", "s-api:studio_api", "s-web:studio_web", "s-web2:studio_web"]);

  const ledger = new PostgresUsageLedger(pool);
  const month = await ledger.monthToDate("acct", now);
  assert.deepEqual(month.studio_web, { input: 30, cachedInput: 0, output: 3, reasoning: 0 });
  assert.deepEqual(month.studio_api, { input: 30, cachedInput: 0, output: 3, reasoning: 0 });
  assert.deepEqual(month.responses_api, { input: 40, cachedInput: 0, output: 4, reasoning: 0 });
  assert.deepEqual(month.chat_web, { input: 50, cachedInput: 0, output: 5, reasoning: 0 });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_usage_daily WHERE surface IN ('studio', 'chat_api')")).rows[0].n, 0);

  // Booting again changes nothing, and the new CHECK takes the new ids only.
  await new PostgresUsageLedger(pool).monthToDate("acct", now);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM hatch_usage_events")).rows[0].n, 5);
  await ledger.record(event("new", { surface: "studio_api", apiKeyId: "key-2" }));
  await assert.rejects(ledger.record(event("old", { surface: "studio" as never })));
}));
