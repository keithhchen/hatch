import assert from "node:assert/strict";
import test from "node:test";
import { creatorFactoryPath, creatorRouteTitle, factorySectionForAgent, parseCreatorRoute } from "./creatorRoutes.js";

test("Factory has its own Product-scoped URL namespace", () => {
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a"), {
    kind: "factory-agents", section: "products", productId: "product-a"
  });
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a/sources"), {
    kind: "factory-agents", section: "products", productId: "product-a", factorySection: "sources"
  });
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a/sources/research"), {
    kind: "factory-agents", section: "products", productId: "product-a", factorySection: "sources", factoryAgent: "research"
  });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/factory/product-a")), "Factory");
  assert.equal(parseCreatorRoute("/studio/products/product-a/factory").kind, "not-found");
});

test("every Factory Agent has one stable section URL", () => {
  const paths = [
    ["sources", "research"],
    ["sources", "voice"],
    ["build", "generation"],
    ["evaluate", "case-generation"],
    ["evaluate", "evaluator"]
  ];
  for (const [factorySection, factoryAgent] of paths) {
    const pathname = creatorFactoryPath("product / 一", factorySection, factoryAgent);
    assert.deepEqual(parseCreatorRoute(pathname), {
      kind: "factory-agents",
      section: "products",
      productId: "product / 一",
      factorySection,
      factoryAgent
    });
    assert.equal(factorySectionForAgent(factoryAgent), factorySection);
  }
  assert.equal(creatorFactoryPath("product-a"), "/studio/factory/product-a");
  assert.equal(creatorFactoryPath("product-a", "build"), "/studio/factory/product-a/build");
});

test("Factory rejects unknown or mismatched section and Agent URLs", () => {
  for (const pathname of [
    "/studio/factory/product-a/unknown",
    "/studio/factory/product-a/runs/old",
    "/studio/factory/product-a/sources/generation",
    "/studio/factory/product-a/build/research",
    "/studio/factory/product-a/evaluate/voice",
    "/studio/factory/product-a/evaluate/evaluator/extra"
  ]) assert.equal(parseCreatorRoute(pathname).kind, "not-found", pathname);
  assert.throws(() => creatorFactoryPath("product-a", "sources", "evaluator"), /does not belong/);
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
