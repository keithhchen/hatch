import assert from "node:assert/strict";
import test from "node:test";
import { exploreModel, removeFromLibrary } from "./exploreModel.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const SAVED = "55555555-5555-4555-8555-555555555555";
const FRESH = "66666666-6666-4666-8666-666666666666";

test("signed-out Explore lists the whole catalog and no Agents of mine", () => {
  const model = exploreModel({ catalog: [{ creator_id: OTHER, product_id: SAVED }] });
  assert.deepEqual(model.saved, []);
  assert.deepEqual(model.published, []);
  assert.equal(model.draftCount, 0);
  assert.equal(model.discover.length, 1);
});

test("My library groups saved Agents and my published Products, newest first; drafts are only counted", () => {
  const model = exploreModel({
    accountId: ME,
    ownedProducts: [
      { product_id: LIVE, name: "Live", status: "published", published_at: "2026-01-01T00:00:00Z" },
      { product_id: DRAFT, name: "Draft", status: "candidate_ready" },
      { product_id: "w", status: "withdrawn" }
    ],
    saved: [
      { creator_id: OTHER, product_id: SAVED, product: { name: "Theirs" }, granted_at: "2026-03-01T00:00:00Z" },
      { creator_id: ME, product_id: LIVE }
    ]
  });
  const rows = (list) => list.map(({ kind, name, href }) => [kind, name, href]);
  assert.deepEqual(rows(model.saved), [["saved", "Theirs", `/chat/product/${SAVED}`]]);
  assert.deepEqual(rows(model.published), [["owned", "Live", `/chat/product/${LIVE}`]]);
  assert.equal(model.draftCount, 1);
});

test("Discover lists the whole catalog, including my own and saved Agents", () => {
  const model = exploreModel({
    accountId: ME,
    saved: [{ creator_id: OTHER, product_id: SAVED }],
    catalog: [
      { creator_id: ME, product_id: LIVE },
      { creator_id: OTHER, product_id: SAVED },
      { creator_id: OTHER, product_id: FRESH }
    ]
  });
  assert.deepEqual(model.discover.map((product) => product.product_id), [LIVE, SAVED, FRESH]);
});

test("an Agent I publish and also hold a library entry for is listed once, as mine", () => {
  const model = exploreModel({
    accountId: ME,
    ownedProducts: [{ product_id: LIVE, name: "Live", status: "published" }],
    saved: [{ creator_id: OTHER, product_id: LIVE }]
  });
  assert.deepEqual(model.published.map((row) => row.productId), [LIVE]);
  assert.deepEqual(model.saved, []);
});

test("removing from the library is a DELETE of that Agent, and its failure reaches the caller", async () => {
  const calls = [];
  const result = await removeFromLibrary(async (url, init) => { calls.push([url, init.method]); return { removed: true }; }, "a/b");
  assert.deepEqual(result, { removed: true });
  assert.deepEqual(calls, [["/v1/library/a%2Fb", "DELETE"]]);
  await assert.rejects(removeFromLibrary(async () => { throw new Error("down"); }, SAVED), /down/);
});
