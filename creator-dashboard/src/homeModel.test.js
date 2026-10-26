import assert from "node:assert/strict";
import test from "node:test";
import { homeModel } from "./homeModel.js";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const LIVE = "33333333-3333-4333-8333-333333333333";
const DRAFT = "44444444-4444-4444-8444-444444444444";
const ACQUIRED = "55555555-5555-4555-8555-555555555555";

test("an account with nothing owned or acquired sees the empty home", () => {
  const home = homeModel({ accountId: ME, catalog: [{ creator_id: OTHER, product_id: ACQUIRED }] });
  assert.equal(home.empty, true);
  assert.deepEqual(home.mine, []);
  assert.equal(home.discover.length, 1);
});

test("my published Agents open chat, in-progress ones open Studio", () => {
  const home = homeModel({
    accountId: ME,
    ownedProducts: [
      { product_id: LIVE, name: "Live", status: "published" },
      { product_id: DRAFT, name: "Draft", status: "candidate_ready" }
    ]
  });
  assert.equal(home.empty, false);
  assert.deepEqual(home.mine.map(({ kind, href }) => [kind, href]), [
    ["owned_live", `/chat/product/${LIVE}`],
    ["owned_draft", `/studio/factory/${DRAFT}`]
  ]);
});

test("acquired Agents open chat; owned rows without entitlement are not acquisitions", () => {
  const home = homeModel({
    accountId: ME,
    acquired: [
      { entitlement_id: "ent-1", creator_id: OTHER, product_id: ACQUIRED, product: { name: "Theirs" }, creator: { id: OTHER, name: "Other" } },
      { creator_id: ME, product_id: LIVE }
    ]
  });
  assert.deepEqual(home.acquired.map(({ kind, name, href }) => [kind, name, href]), [["acquired", "Theirs", `/chat/product/${ACQUIRED}`]]);
});

test("Discover never lists my own Agents", () => {
  const home = homeModel({
    accountId: ME,
    catalog: [{ creator_id: ME, product_id: LIVE }, { creator_id: OTHER, product_id: ACQUIRED }]
  });
  assert.deepEqual(home.discover.map((product) => product.product_id), [ACQUIRED]);
});
