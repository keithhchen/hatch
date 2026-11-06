import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal((await store.listPublic())[0]?.listed, true);
  await store.setListed(CREATOR, PRODUCT, false);
  await store.publish({ ...release, release_digest: "d2" });
  assert.equal(await store.isListed(PRODUCT), false);
  assert.equal((await store.getPublic(PRODUCT))?.listed, false);
  await store.setListed(CREATOR, PRODUCT, true);
  assert.equal(await store.isListed(PRODUCT), true);
});
