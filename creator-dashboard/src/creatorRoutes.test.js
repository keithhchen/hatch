import assert from "node:assert/strict";
import test from "node:test";
import { creatorRouteTitle, parseCreatorRoute } from "./creatorRoutes.js";

test("Creator Factory run routes preserve the selected run across refresh", () => {
  assert.deepEqual(parseCreatorRoute("/studio/factory/runs/factory_123"), {
    kind: "factory", section: "products", runId: "factory_123"
  });
  assert.deepEqual(parseCreatorRoute("/studio/products/product-a/factory/runs/factory%2Fencoded"), {
    kind: "factory", section: "products", productId: "product-a", runId: "factory/encoded"
  });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/factory/runs/factory_123")), "Factory run");
});

test("paid payout routes stay outside the free Creator product", () => {
  assert.equal(parseCreatorRoute("/studio/settings/payouts").kind, "not-found");
  assert.equal(parseCreatorRoute("/studio/payouts/payout_9").kind, "not-found");
});

test("unknown nested Creator routes do not silently fall back to a parent task", () => {
  assert.equal(parseCreatorRoute("/studio/factory/unknown/extra").kind, "not-found");
  assert.equal(parseCreatorRoute("/studio/nope").kind, "not-found");
});

test("legacy portal paths are not aliases after the UUID cutover", () => {
  assert.equal(parseCreatorRoute("/portal").kind, "not-found");
  assert.equal(parseCreatorRoute("/portal/creator/factory/runs/factory_123").kind, "not-found");
});
