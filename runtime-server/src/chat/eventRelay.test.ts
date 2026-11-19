import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresEventRelay } from "./eventRelay.js";
import { PostgresStopRelay } from "./stopRelay.js";
import { RunEventHub } from "./runEventHub.js";

const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

const settled = async (condition: () => boolean) => {
  for (let i = 0; i < 300; i++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("condition not reached");
};

test("a notification reaches observers on another instance, and observers on the same instance hear it once", { skip: !databaseUrl }, async () => {
  const pools = [new Pool({ connectionString: databaseUrl }), new Pool({ connectionString: databaseUrl })];
  const [a, b] = pools.map((pool) => new RunEventHub(new PostgresEventRelay(pool, { channel: `relay_test_${process.pid}` })));
  const stops = await Promise.all([a!.listen(), b!.listen()]);
  try {
    const onA: number[] = [];
    const onB: number[] = [];
    a!.subscribe("c1", (position) => { onA.push(position); });
    b!.subscribe("c1", (position) => { onB.push(position); });
    b!.subscribe("other", () => assert.fail("another conversation's news"));
    a!.advanced("c1", 7);
    await settled(() => onB.length >= 1);
    assert.equal(onB.at(-1), 7);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(onA, [7], "the instance that appended is not told twice");
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await Promise.all(pools.map((pool) => pool.end()));
  }
});

test("publishing never waits for the database: a stalled connection costs delay, not time, and only the newest position per conversation is sent", async () => {
  const batches: string[][] = [];
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const pool = {
    query: async (_text: string, values?: unknown[]) => { batches.push(values![1] as string[]); if (batches.length === 1) await stalled; },
    connect: async () => { throw new Error("not used"); }
  };
  const hub = new RunEventHub(new PostgresEventRelay(pool as never));
  const seen: number[] = [];
  hub.subscribe("c", (position) => { seen.push(position); });
  const started = performance.now();
  for (let n = 1; n <= 1000; n++) hub.advanced("c", n);
  assert.ok(performance.now() - started < 100, "1000 appends took no time on the Run");
  assert.equal(seen.length, 1000, "local observers hear everything at once");
  release();
  await settled(() => batches.length === 2);
  assert.equal(batches[1]!.length, 1);
  assert.equal((JSON.parse(batches[1]![0]!) as { p: number }).p, 1000);
});

test("a failed send is retried by the next publish with the newest position", async () => {
  const batches: string[][] = [];
  let fail = true;
  const pool = { query: async (_text: string, values?: unknown[]) => { if (fail) throw new Error("down"); batches.push(values![1] as string[]); }, connect: async () => { throw new Error("not used"); } };
  const relay = new PostgresEventRelay(pool as never);
  relay.publish("c1", 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fail = false;
  relay.publish("c2", 4);
  await settled(() => batches.length === 1);
  const sent = batches[0]!.map((payload) => JSON.parse(payload) as { c: string; p: number });
  assert.deepEqual(sent.map((item) => [item.c, item.p]).sort(), [["c1", 3], ["c2", 4]]);
});

test("a lost LISTEN connection is replaced and listens again", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const admin = new Pool({ connectionString: databaseUrl });
  const channel = `relay_gap_${process.pid}`;
  const hub = new RunEventHub(new PostgresEventRelay(pool, { channel, retryMs: 20 }));
  const stop = await hub.listen();
  try {
    const heard: number[] = [];
    hub.subscribe("c1", (position) => { heard.push(position); });
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = $1", [`LISTEN ${channel}`]);
    const other = new Pool({ connectionString: databaseUrl });
    const sender = new RunEventHub(new PostgresEventRelay(other, { channel }));
    for (let n = 0; n < 100 && !heard.includes(7); n++) { sender.advanced("c1", 7); await new Promise((resolve) => setTimeout(resolve, 30)); }
    assert.ok(heard.includes(7), "news arrives again after the connection was replaced");
    await other.end();
  } finally {
    await stop();
    await Promise.all([pool.end(), admin.end()]);
  }
});

test("a stop announced by one instance reaches another over LISTEN/NOTIFY within a second", { skip: !databaseUrl }, async () => {
  const pools = [new Pool({ connectionString: databaseUrl }), new Pool({ connectionString: databaseUrl })];
  const channel = `stop_test_${process.pid}`;
  const [a, b] = pools.map((pool) => new PostgresStopRelay(pool, { channel }));
  const heard: string[] = [];
  const unsubscribe = await a!.subscribe((runId) => heard.push(runId));
  try {
    const began = Date.now();
    b!.publish("run-1");
    await settled(() => heard.length === 1);
    assert.deepEqual(heard, ["run-1"]);
    assert.ok(Date.now() - began < 1000);
  } finally {
    await unsubscribe();
    await Promise.all(pools.map((pool) => pool.end()));
  }
});
