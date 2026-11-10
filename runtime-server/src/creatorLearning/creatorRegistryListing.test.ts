import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { CreatorRegistryReleaseStore } from "./creatorRegistryRelease.js";

const CREATOR = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";

test("unlisting is a Product setting that public listings carry and republish keeps", async () => {
  const store = new CreatorRegistryReleaseStore();
  const release = {
    product_id: PRODUCT, creator_id: CREATOR, release_digest: "d1", corpus_digest: "c1", corpus_ref: "c",
    release_ref: `registry/${PRODUCT}/releases/d1`, runtime_manifest_ref: "r/runtime/manifest.json", brief_spec: null
  };
  await store.publish(release);
  assert.equal((await store.listPublic())[0]?.listed, false, "a first publish is unlisted");
  await store.setListed(CREATOR, PRODUCT, true);
  await store.publish({ ...release, release_digest: "d1b" });
  assert.equal(await store.isListed(PRODUCT), true, "republishing never unlists a Product the Expert listed");
  await store.setListed(CREATOR, PRODUCT, false);
  await store.publish({ ...release, release_digest: "d2" });
  assert.equal(await store.isListed(PRODUCT), false);
  assert.equal((await store.getPublic(PRODUCT))?.listed, false);
  await store.setListed(CREATOR, PRODUCT, true);
  assert.equal(await store.isListed(PRODUCT), true);
});

const connectionString = process.env.HATCH_TEST_DATABASE_URL;

test("real PostgreSQL: the first publish writes unlisted with the release; Products published before listing rows stay listed", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `hatch_listing_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    const store = new CreatorRegistryReleaseStore(pool);
    await store.ensureSchema();
    const release = (product: string, digest: string) => ({
      product_id: product, creator_id: CREATOR, release_digest: digest, corpus_digest: "c1", corpus_ref: "c",
      release_ref: `registry/${product}/releases/${digest}`, runtime_manifest_ref: "r/runtime/manifest.json", brief_spec: null
    });
    await store.publish(release(PRODUCT, "d1"));
    assert.equal(await store.isListed(PRODUCT), false);
    await store.setListed(CREATOR, PRODUCT, true);
    await store.publish(release(PRODUCT, "d2"));
    assert.equal(await store.isListed(PRODUCT), true);

    const LEGACY = "33333333-3333-4333-8333-333333333333";
    await store.publish(release(LEGACY, "d1"));
    await pool.query(`DELETE FROM hatch_creator_product_listing WHERE product_id=$1`, [LEGACY]);
    assert.equal(await store.isListed(LEGACY), true, "no row reads as listed");
    await store.publish(release(LEGACY, "d2"));
    assert.equal(await store.isListed(LEGACY), true, "a Product that already had a release is not unlisted by republishing");
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
