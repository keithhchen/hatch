import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { Asset, AssetError, scopeKey, type AssetRepository } from "./domain.js";
import { scopeA, scopeB } from "./kit.test.js";
import { InMemoryAssetRepository, PostgresAssetRepository } from "./repositories.js";

const fresh = (sha256: string = randomUUID(), scope = scopeA) => Asset.received({ scope, sha256, kind: "file", mime: "text/plain", name: "a.txt", bytes: 1 });
const code = (promise: Promise<unknown>) => promise.then(() => "ok", (e: unknown) => e instanceof AssetError ? e.code : String(e));

/** The contract both adapters must meet. The database one is what makes it true under concurrency. */
async function contract(repo: AssetRepository) {
  const a = fresh("s1");
  const results = await Promise.all(Array.from({ length: 10 }, () => repo.insertIfAbsent(fresh("s1"))));
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(new Set(results.map(r => r.asset.id)).size, 1);
  assert.equal((await repo.insertIfAbsent(fresh("s1", scopeB))).created, true);

  const first = (await repo.insertIfAbsent(a)).asset;
  const winner = first.id === a.id ? a : first;
  // compare-and-set: exactly one of two competing transitions wins
  const moves = await Promise.all([repo.transition("processing", winner.ready([])), repo.transition("processing", winner.failed({ code: "x", message: "y" }))]);
  assert.equal(moves.filter(Boolean).length, 1);
  const current = (await repo.get(scopeA, winner.id))!;
  if (current.state === "failed") {
    assert.equal((await repo.insertIfAbsent(fresh("s1"))).created, true); // a failed asset does not block a retry
    return;
  }
  assert.equal(await repo.get(scopeB, winner.id), undefined);
  assert.equal(await code(repo.attach(scopeB, winner.id, "m1")), "not_found");
  // One asset joins many messages; binding the same message twice is one link.
  assert.deepEqual(await Promise.all(["m1", "m2", "m1", "m2"].map(m => code(repo.attach(scopeA, winner.id, m)))), ["ok", "ok", "ok", "ok"]);
  const links = await repo.listAttached(scopeA);
  assert.deepEqual(links.map(link => link.messageId).sort(), ["m1", "m2"]);
  assert.ok(links.every(link => link.asset.id === winner.id));
  assert.equal((await repo.listAttached(scopeB)).length, 0);
  await repo.release(scopeA, winner.id, "m1");
  assert.deepEqual((await repo.listAttached(scopeA)).map(link => link.messageId), ["m2"], "release frees only the message it names");
  await repo.release(scopeA, winner.id, "m2");
  assert.equal((await repo.listAttached(scopeA)).length, 0);
  assert.equal(await code(repo.attach(scopeA, winner.id, "m1")), "ok", "a released asset can be sent again");
  const pending = (await repo.insertIfAbsent(fresh("s2"))).asset;
  assert.equal(await code(repo.attach(scopeA, pending.id, "m1")), "not_ready");
}

test("in-memory repository meets the contract", async () => {
  for (let i = 0; i < 20; i++) await contract(new InMemoryAssetRepository());
});

const url = process.env.HATCH_TEST_DATABASE_URL;
test("PostgreSQL repository meets the contract, enforced by the database", { skip: !url, timeout: 60_000 }, async () => {
  const schema = `hatch_assets_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    const repo = new PostgresAssetRepository(pool);
    await repo.initialize();
    for (let i = 0; i < 5; i++) { await pool.query("TRUNCATE hatch_assets CASCADE"); await contract(repo); }
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

test("rows written when an asset held one message become links, once", { skip: !url, timeout: 60_000 }, async () => {
  const schema = `hatch_assets_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await pool.query(`CREATE TABLE hatch_assets (id text PRIMARY KEY, scope_key text NOT NULL, sha256 text NOT NULL, state text NOT NULL, message_id text, record jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);
    const record = { ...fresh("s1").record, state: "ready" as const, messageId: "m-old" };
    await pool.query(`INSERT INTO hatch_assets (id, scope_key, sha256, state, message_id, record) VALUES ($1, $2, 's1', 'ready', 'm-old', $3)`, [record.id, scopeKey(scopeA), JSON.stringify(record)]);
    const repo = new PostgresAssetRepository(pool);
    await repo.initialize();
    await repo.initialize();
    assert.deepEqual((await repo.listAttached(scopeA)).map(link => [link.asset.id, link.messageId]), [[record.id, "m-old"]]);
    assert.equal(await code(repo.attach(scopeA, record.id, "m-new")), "ok", "and the asset takes another message");
    assert.equal((await repo.listAttached(scopeA)).length, 2);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
