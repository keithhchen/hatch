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
  assert.equal(batches[1]!.length, 6, "only the newest events waited, then a resync for what was dropped");
  assert.equal((JSON.parse(batches[1]!.at(-2)!) as { e: { n: number } }).e.n, 999);
  assert.equal((JSON.parse(batches[1]!.at(-1)!) as { e: { type: string } }).e.type, "resync");
});

test("an event too large for one notification is relayed in chunks and arrives whole, in order with the small ones", { skip: !databaseUrl }, async () => {
  const pools = [new Pool({ connectionString: databaseUrl }), new Pool({ connectionString: databaseUrl })];
  const [a, b] = pools.map((pool) => new RunEventHub(new PostgresEventRelay(pool, { channel: `relay_big_${process.pid}` })));
  const stops = await Promise.all([a!.listen(), b!.listen()]);
  try {
    const heard: Array<Record<string, unknown>> = [];
    b!.subscribe("c1", { push: (event) => { heard.push(event); } });
    const big = { type: "session.compacted", replacement_history: "héllo 日本語 \u{1F600} ".repeat(20_000) };
    a!.publish("c1", { type: "assistant.delta", n: 0 });
    a!.publish("c1", big);
    a!.publish("c1", { type: "assistant.delta", n: 1 });
    await settled(() => heard.length === 3);
    assert.deepEqual(heard[1], big, "the large event is intact");
    assert.deepEqual(heard.map((event) => event.type), ["assistant.delta", "session.compacted", "assistant.delta"]);
  } finally {
    await Promise.all(stops.map((stop) => stop()));
    await Promise.all(pools.map((pool) => pool.end()));
  }
});

test("an event beyond any size, and a backlog the database cannot keep up with, tell the other instances to resync that conversation", async () => {
  const batches: string[][] = [];
  const pool = { query: async (_text: string, values?: unknown[]) => { batches.push(values![1] as string[]); }, connect: async () => { throw new Error("not used"); } };
  const relay = new PostgresEventRelay(pool as never, { maxPayloadBytes: 600, maxEventBytes: 2_000 });
  relay.publish("c", { type: "session.compacted", replacement_history: "x".repeat(5000) });
  await settled(() => batches.length === 1);
  assert.deepEqual(batches[0]!.map((payload) => (JSON.parse(payload) as { c: string; e: unknown }).e), [{ type: "resync" }]);
  assert.equal((JSON.parse(batches[0]![0]!) as { c: string }).c, "c");
});

test("a failed send is not silent: the next send carries a resync for what was dropped", async () => {
  const batches: string[][] = [];
  let fail = true;
  const pool = { query: async (_text: string, values?: unknown[]) => { if (fail) throw new Error("down"); batches.push(values![1] as string[]); }, connect: async () => { throw new Error("not used"); } };
  const relay = new PostgresEventRelay(pool as never);
  relay.publish("c1", { type: "assistant.delta", n: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  fail = false;
  relay.publish("c2", { type: "assistant.delta", n: 1 });
  await settled(() => batches.length === 1);
  const sent = batches[0]!.map((payload) => JSON.parse(payload) as { c: string; e: { type: string } });
  assert.deepEqual(sent.map((item) => [item.c, item.e.type]), [["c2", "assistant.delta"], ["c1", "resync"]]);
});

test("a lost LISTEN connection is replaced, and the observers on that instance are told to read again", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const admin = new Pool({ connectionString: databaseUrl });
  const channel = `relay_gap_${process.pid}`;
  const hub = new RunEventHub(new PostgresEventRelay(pool, { channel, retryMs: 20 }));
  const stop = await hub.listen();
  try {
    const heard: Array<Record<string, unknown>> = [];
    hub.subscribe("c1", { push: (event) => { heard.push(event); } });
    hub.subscribe("c2", { push: (event) => { heard.push(event); } });
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = $1", [`LISTEN ${channel}`]);
    await settled(() => heard.filter((event) => event.type === "resync").length === 2);
    // And it listens again: another instance's event arrives.
    const other = new Pool({ connectionString: databaseUrl });
    const sender = new RunEventHub(new PostgresEventRelay(other, { channel }));
    sender.publish("c1", { type: "assistant.delta", n: 7 });
    await settled(() => heard.some((event) => event.n === 7));
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
