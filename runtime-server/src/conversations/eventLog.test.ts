import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { ConversationError } from "./conversation.js";
import { MemoryEventLog, parseCursor, type EventLog } from "./eventLog.js";
import { follow, resumePoint, withoutPartials } from "./follow.js";
import { PostgresEventLog } from "./postgresEventLog.js";

// The same contract runs on the in-memory adapters and, when HATCH_TEST_DATABASE_URL is set, on real
// PostgreSQL through two pools standing in for two Registry processes. Each run owns a random schema.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;

type Processes = { logs: [EventLog, EventLog] };

async function onMemory(body: (processes: Processes) => Promise<void>) {
  const log = new MemoryEventLog();
  await body({ logs: [log, log] });
}

async function onPostgres(body: (processes: Processes) => Promise<void>) {
  const schema = `conv_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pools = [0, 1].map(() => new Pool({ connectionString, options: `-c search_path=${schema}` }));
  try {
    await PostgresEventLog.open(pools[0]!);
    await body({ logs: [await PostgresEventLog.open(pools[0]!), await PostgresEventLog.open(pools[1]!)] });
  } finally { await Promise.all(pools.map(pool => pool.end())); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); }
}

const adapters: Array<[string, (body: (p: Processes) => Promise<void>) => Promise<void>, boolean]> = [["memory", onMemory, false], ["postgres", onPostgres, !connectionString]];

for (const [name, run, skip] of adapters) {
  test(`${name} event log: cursors are consecutive per conversation and replay is exact`, { skip }, () => run(async ({ logs: [log] }) => {
    assert.equal(await log.head("a"), "0");
    assert.deepEqual([await log.append("a", { type: "x" }), await log.append("a", { type: "y" }), await log.append("b", { type: "z" })], ["1", "2", "1"]);
    assert.equal(await log.head("a"), "2");
    assert.deepEqual((await log.after("a", "1")).map(entry => [entry.cursor, entry.event.type]), [["2", "y"]]);
    assert.deepEqual(await log.after("a", "2"), []);
  }));

  test(`${name} event log: concurrent writers in two processes never skip or repeat a cursor`, { skip }, () => run(async ({ logs: [one, two] }) => {
    await Promise.all(Array.from({ length: 60 }, (_, index) => (index % 2 ? one : two).append("k", { type: "e", index })));
    const all = await one.after("k", "0", 500);
    assert.deepEqual(all.map(entry => entry.cursor), Array.from({ length: 60 }, (_, index) => String(index + 1)));
    assert.equal(new Set(all.map(entry => entry.event.index)).size, 60);
  }));

  test(`${name} follow: replay then live across processes, no gap and no duplicate at the seam`, { skip }, () => run(async ({ logs: [writer, reader] }) => {
    for (let index = 0; index < 5; index++) await writer.append("k", { type: "e", index });
    const seen: string[] = [];
    const stop = new AbortController();
    const done = follow(reader, "k", "2", entry => { seen.push(entry.cursor); }, { signal: stop.signal, pollMs: 20 });
    for (let index = 5; index < 12; index++) { await writer.append("k", { type: "e", index }); if (index === 7) await new Promise(resolve => setTimeout(resolve, 40)); }
    await new Promise(resolve => setTimeout(resolve, 100));
    stop.abort(); await done;
    assert.deepEqual(seen, Array.from({ length: 10 }, (_, index) => String(index + 3)));
  }));

  test(`${name} follow: a slow consumer only delays itself`, { skip }, () => run(async ({ logs: [log] }) => {
    const stop = new AbortController();
    const done = follow(log, "k", "0", () => new Promise(resolve => setTimeout(resolve, 50)), { signal: stop.signal, pollMs: 10 });
    const started = Date.now();
    for (let index = 0; index < 20; index++) await log.append("k", { type: "e" });
    assert.ok(Date.now() - started < 500, "appending never waits for the reader");
    stop.abort(); await done;
  }));
}

test("cursors: only positions the log handed out are accepted", async () => {
  const log = new MemoryEventLog();
  await log.append("k", { type: "e" });
  assert.equal(parseCursor(undefined), "0");
  assert.throws(() => parseCursor("abc"), { code: "invalid_cursor" });
  assert.equal(await resumePoint(log, "k", null), "1", "no cursor means from now");
  assert.equal(await resumePoint(log, "k", "0"), "0");
  await assert.rejects(resumePoint(log, "k", "9"), { code: "invalid_cursor" });
});

test("withoutPartials drops token-level progress and keeps results", async () => {
  const seen: string[] = [];
  const deliver = withoutPartials(entry => { seen.push(entry.event.type); });
  for (const type of ["delta", "thinking", "tool", "message", "run_end"]) await deliver({ cursor: "1", event: { type } });
  assert.deepEqual(seen, ["tool", "message", "run_end"]);
});
