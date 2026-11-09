import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { Asset, AssetError, type AssetRepository } from "./domain.js";
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
  const attachResults = await Promise.all(["m1", "m2", "m1", "m2"].map(m => code(repo.attach(scopeA, winner.id, m))));
  assert.equal(attachResults.filter(r => r === "conflict").length, 2);
  assert.equal((await repo.listAttached(scopeA)).length, 1);
  assert.equal((await repo.listAttached(scopeB)).length, 0);
  const bound = (await repo.listAttached(scopeA))[0]!.messageId!;
  const other = bound === "m1" ? "m2" : "m1";
  await repo.release(scopeA, winner.id, other);
  assert.equal((await repo.get(scopeA, winner.id))!.messageId, bound, "release frees only the message that holds it");
  await repo.release(scopeA, winner.id, bound);
  assert.equal((await repo.get(scopeA, winner.id))!.messageId, undefined);
  assert.equal((await repo.listAttached(scopeA)).length, 0);
  assert.equal(await code(repo.attach(scopeA, winner.id, other)), "ok", "a released asset can be sent again");
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
    for (let i = 0; i < 5; i++) { await pool.query("TRUNCATE hatch_assets"); await contract(repo); }
    await assert.rejects(pool.query(`INSERT INTO hatch_assets (id, scope_key, sha256, state, message_id, record) VALUES ('x','k','h','processing','m','{}')`), /check/i);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
