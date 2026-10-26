import assert from "node:assert/strict";
import test from "node:test";
import { exploreModel } from "./exploreModel.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const ACQUIRED = "55555555-5555-4555-8555-555555555555";
const FRESH = "66666666-6666-4666-8666-666666666666";

test("signed-out Explore lists the whole catalog and no Agents of mine", () => {
  const model = exploreModel({ catalog: [{ creator_id: OTHER, product_id: ACQUIRED }] });
  assert.deepEqual(model.myAgents, []);
  assert.equal(model.draftCount, 0);
  assert.equal(model.discover.length, 1);
});

test("My Agents lists published Products and acquisitions, newest first; drafts are only counted", () => {
  const model = exploreModel({
    accountId: ME,
    ownedProducts: [
      { product_id: LIVE, name: "Live", status: "published", published_at: "2026-01-01T00:00:00Z" },
      { product_id: DRAFT, name: "Draft", status: "candidate_ready" },
      { product_id: "w", status: "withdrawn" }
    ],
    acquired: [
      { entitlement_id: "ent-1", creator_id: OTHER, product_id: ACQUIRED, product: { name: "Theirs" }, granted_at: "2026-03-01T00:00:00Z" },
      { creator_id: ME, product_id: LIVE }
    ]
  });
  assert.deepEqual(model.myAgents.map(({ kind, name, href }) => [kind, name, href]), [
    ["acquired", "Theirs", `/chat/product/${ACQUIRED}`],
    ["owned", "Live", `/chat/product/${LIVE}`]
  ]);
  assert.equal(model.draftCount, 1);
});

test("Discover never lists my own Products or Agents already in My Agents", () => {
  const model = exploreModel({
    accountId: ME,
    acquired: [{ entitlement_id: "ent-1", creator_id: OTHER, product_id: ACQUIRED }],
    catalog: [
      { creator_id: ME, product_id: LIVE },
      { creator_id: OTHER, product_id: ACQUIRED },
      { creator_id: OTHER, product_id: FRESH }
    ]
  });
  assert.deepEqual(model.discover.map((product) => product.product_id), [FRESH]);
});
