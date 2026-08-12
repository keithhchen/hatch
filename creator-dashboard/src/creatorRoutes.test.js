import assert from "node:assert/strict";
import test from "node:test";
import { creatorRouteTitle, parseCreatorRoute } from "./creatorRoutes.js";

test("Creator Factory run routes preserve the selected run across refresh", () => {
  assert.deepEqual(parseCreatorRoute("/portal/creator/factory/runs/factory_123"), {
    kind: "factory", section: "products", runId: "factory_123"
  });
  assert.deepEqual(parseCreatorRoute("/portal/creator/products/product-a/factory/runs/factory%2Fencoded"), {
    kind: "factory", section: "products", productId: "product-a", runId: "factory/encoded"
  });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/portal/creator/factory/runs/factory_123")), "Factory run");
});

test("Creator payout settings and transfer details have distinct durable routes", () => {
  assert.deepEqual(parseCreatorRoute("/portal/creator/settings/payouts"), {
    kind: "payout-settings", section: "payouts"
  });
  assert.deepEqual(parseCreatorRoute("/portal/creator/payouts/payout_9"), {
    kind: "payout", section: "payouts", payoutId: "payout_9"
  });
});

test("unknown nested Creator routes do not silently fall back to a parent task", () => {
  assert.equal(parseCreatorRoute("/portal/creator/factory/unknown").kind, "not-found");
  assert.equal(parseCreatorRoute("/portal/creator/nope").kind, "not-found");
});
