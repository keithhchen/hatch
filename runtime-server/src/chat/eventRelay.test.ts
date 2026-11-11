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

test("live deltas reach observers on another instance, and observers on the same instance see each once", { skip: !databaseUrl }, async () => {
  const pools = [new Pool({ connectionString: databaseUrl }), new Pool({ connectionString: databaseUrl })];
  const [a, b] = pools.map((pool) => new RunEventHub(new PostgresEventRelay(pool, { channel: `relay_test_${process.pid}` })));
  const stops = await Promise.all([a!.listen(), b!.listen()]);
  try {
    const onA: unknown[] = [];
    const onB: unknown[] = [];
    a!.subscribe("c1", { push: (event) => { onA.push(event); } });
    b!.subscribe("c1", { push: (event) => { onB.push(event); } });
    b!.subscribe("other", { push: () => assert.fail("another conversation's event") });
    for (let n = 0; n < 5; n++) a!.publish("c1", { type: "assistant.delta", n });
    await settled(() => onB.length === 5);
    assert.deepEqual(onB.map((event) => (event as { n: number }).n), [0, 1, 2, 3, 4], "in order");
    assert.equal(onA.length, 5, "the executing instance's own observers are not served twice");
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await Promise.all(pools.map((pool) => pool.end()));
  }
});

test("publishing never waits for the database: a stalled connection costs events, not time, and the backlog is bounded", async () => {
  const batches: string[][] = [];
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => { release = resolve; });
  const pool = {
    query: async (_text: string, values?: unknown[]) => { batches.push(values![1] as string[]); if (batches.length === 1) await stalled; },
    connect: async () => { throw new Error("not used"); }
  };
  const hub = new RunEventHub(new PostgresEventRelay(pool as never, { maxQueue: 5 }));
  const seen: unknown[] = [];
  hub.subscribe("c", { push: (event) => { seen.push(event); } });
  const started = performance.now();
  for (let n = 0; n < 1000; n++) hub.publish("c", { type: "assistant.delta", n });
  assert.ok(performance.now() - started < 100, "publishing 1000 events took no time on the Run");
  assert.equal(seen.length, 1000, "local observers get everything at once");
  release();
  await settled(() => batches.length === 2);
  assert.equal(batches[1]!.length, 5, "only the newest events waited");
  assert.equal((JSON.parse(batches[1]!.at(-1)!) as { e: { n: number } }).e.n, 999);
});

test("an event too large for a notification is not relayed", async () => {
  const batches: string[][] = [];
  const pool = { query: async (_text: string, values?: unknown[]) => { batches.push(values![1] as string[]); }, connect: async () => { throw new Error("not used"); } };
  const hub = new RunEventHub(new PostgresEventRelay(pool as never, { maxPayloadBytes: 200 }));
  hub.publish("c", { type: "session.compacted", replacement_history: "x".repeat(1000) });
  hub.publish("c", { type: "assistant.delta" });
  await settled(() => batches.length === 1);
  assert.equal(batches[0]!.length, 1);
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
