import assert from "node:assert/strict";
import test from "node:test";
import { creatorRouteTitle, parseCreatorRoute } from "./creatorRoutes.js";

test("Factory is scoped by the existing Product route", () => {
  assert.deepEqual(parseCreatorRoute("/studio/products/product-a/factory"), {
    kind: "factory-agents", section: "products", productId: "product-a"
  });
  assert.equal(parseCreatorRoute("/studio/products/product-a/factory/runs/old").kind, "not-found");
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/products/product-a/factory")), "Factory");
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
  assert.deepEqual(parseCreatorRoute("/studio/products/product_123/brief"), {
    kind: "product",
    section: "products",
    productId: "product_123",
    tab: "brief"
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


test("the unscoped Factory URL redirects to Products without creating a workspace", () => {
  assert.deepEqual(parseCreatorRoute("/studio/factory"), { kind: "factory-index", section: "products" });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/factory")), "Factory");
});
