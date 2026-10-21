import assert from "node:assert/strict";
import test from "node:test";
import { createPublicProductDirectory, identityIsComplete, indexPublicProducts, recordProductId, resolveProductIdentity } from "./buyerProductIdentity.js";

const PRODUCT_ID = "958e888a-6557-4420-b293-35097304f0e9";
const CREATOR_ID = "489ae0a9-2009-434d-82ac-30426cc93f75";

// Shape the server returns when the entitlement has no catalog match.
const bareEntitlement = {
  entitlement_id: "ent_1",
  product_id: PRODUCT_ID,
  creator_id: CREATOR_ID,
  product: { id: PRODUCT_ID, product_id: PRODUCT_ID, name: PRODUCT_ID },
  creator: { id: CREATOR_ID }
};

// Shape of an item from GET /v1/public/products.
const publicProduct = {
  product_id: PRODUCT_ID,
  creator_id: CREATOR_ID,
  product_name: "业务文案助手",
  creator_name: "Hao",
  creator: { id: CREATOR_ID, name: "Hao", avatar_url: null },
  product: { id: PRODUCT_ID, name: "业务文案助手" }
};

test("a raw product or creator identifier is never used as a name", () => {
  const identity = resolveProductIdentity(bareEntitlement);
  assert.deepEqual(identity, { name: null, creatorName: null });
  assert.equal(identityIsComplete(identity), false);
  assert.equal(resolveProductIdentity({ product_id: "p1", product_name: "p1" }).name, null);
  assert.equal(resolveProductIdentity({ product_name: "  " }).name, null);
});

test("a record without a snapshot is named from the public product record", () => {
  assert.deepEqual(resolveProductIdentity(bareEntitlement, publicProduct), { name: "业务文案助手", creatorName: "Hao" });
});

test("snapshot names on the record win over the public product record", () => {
  const order = { product_id: PRODUCT_ID, creator_name: "Hao Chen", product_snapshot: { product_name: "Copy assistant v1" } };
  assert.deepEqual(resolveProductIdentity(order, publicProduct), { name: "Copy assistant v1", creatorName: "Hao Chen" });
  assert.equal(identityIsComplete(resolveProductIdentity(order)), true);
});

test("the Expert name stays known even when the product name is not", () => {
  const entitlement = { ...bareEntitlement, creator_name: "Hao" };
  assert.deepEqual(resolveProductIdentity(entitlement, null), { name: null, creatorName: "Hao" });
});

test("product id is read from the record or its snapshot", () => {
  assert.equal(recordProductId(bareEntitlement), PRODUCT_ID);
  assert.equal(recordProductId({ product_snapshot: { product_id: "p2" } }), "p2");
  assert.equal(recordProductId(null), null);
});

test("the public catalog is indexed by product id in either response shape", () => {
  assert.equal(indexPublicProducts([publicProduct]).get(PRODUCT_ID), publicProduct);
  assert.equal(indexPublicProducts({ products: [publicProduct] }).get(PRODUCT_ID), publicProduct);
  assert.equal(indexPublicProducts(null).size, 0);
});

test("the public catalog is fetched once and a failure is retried", async () => {
  let calls = 0;
  let fail = true;
  const index = createPublicProductDirectory(async () => {
    calls += 1;
    if (fail) throw new Error("unavailable");
    return [publicProduct];
  });
  await assert.rejects(index(), /unavailable/);
  fail = false;
  const [first, second] = await Promise.all([index(), index()]);
  assert.equal(first, second);
  assert.equal(first.get(PRODUCT_ID), publicProduct);
  await index();
  assert.equal(calls, 2);
});
