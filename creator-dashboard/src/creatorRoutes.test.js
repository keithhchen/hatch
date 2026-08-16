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

test("Product files are nested under one Product", () => {
  assert.equal(parseCreatorRoute("/studio/sources").kind, "not-found");
  assert.deepEqual(parseCreatorRoute("/studio/products/new"), {
    kind: "product-create",
    section: "products"
  });
  assert.deepEqual(parseCreatorRoute("/studio/products/product_123/files"), {
    kind: "product",
    section: "products",
    productId: "product_123",
    tab: "files"
  });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/products/new")), "Create product");
  assert.equal(parseCreatorRoute("/studio/tasks/new").kind, "not-found");
  assert.equal(parseCreatorRoute("/studio/products/product_123/brief").kind, "not-found");
  assert.deepEqual(parseCreatorRoute("/studio/products/product_123/complete"), {
    kind: "product",
    section: "products",
    productId: "product_123",
    tab: "complete"
  });
});

test("paid payout routes stay outside the free Creator product", () => {
  assert.equal(parseCreatorRoute("/studio/settings/payouts").kind, "not-found");
  assert.equal(parseCreatorRoute("/studio/payouts/payout_9").kind, "not-found");
});

test("unknown nested Creator routes do not silently fall back to a parent Product", () => {
  assert.equal(parseCreatorRoute("/studio/factory/unknown/extra").kind, "not-found");
  assert.equal(parseCreatorRoute("/studio/nope").kind, "not-found");
});

test("legacy portal paths are not aliases after the UUID cutover", () => {
  assert.equal(parseCreatorRoute("/portal").kind, "not-found");
  assert.equal(parseCreatorRoute("/portal/creator/factory/runs/factory_123").kind, "not-found");
});
