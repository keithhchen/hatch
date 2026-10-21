import assert from "node:assert/strict";
import test from "node:test";
import { creatorFactoryPath, creatorProductPath, creatorRouteTitle, factorySectionForAgent, parseCreatorRoute } from "./creatorRoutes.js";

test("Factory has its own Product-scoped URL namespace", () => {
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a"), {
    kind: "agent", section: "products", productId: "product-a", tab: "build"
  });
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a/sources"), {
    kind: "agent", section: "products", productId: "product-a", tab: "build", factorySection: "sources"
  });
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a/sources/research"), {
    kind: "agent", section: "products", productId: "product-a", tab: "build", factorySection: "sources", factoryAgent: "research"
  });
  assert.deepEqual(parseCreatorRoute("/studio/factory/product-a/sources/uploads"), {
    kind: "agent", section: "products", productId: "product-a", tab: "build", factorySection: "sources", factoryAgent: "uploads"
  });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/factory/product-a")), "Agent");
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
      kind: "agent",
      section: "products",
      productId: "product / 一",
      tab: "build",
      factorySection,
      factoryAgent
    });
    assert.equal(factorySectionForAgent(factoryAgent), factorySection);
  }
  assert.equal(creatorFactoryPath("product-a"), "/studio/factory/product-a");
  assert.equal(creatorFactoryPath("product-a", "build"), "/studio/factory/product-a/build");
  assert.equal(creatorFactoryPath("product-a", "sources", "uploads"), "/studio/factory/product-a/sources/uploads");
  assert.equal(creatorProductPath("product-a"), "/studio/factory/product-a");
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

test("Agent workspace tabs and the create page have their own URLs", () => {
  assert.equal(parseCreatorRoute("/studio/sources").kind, "not-found");
  assert.deepEqual(parseCreatorRoute("/studio/products/new"), { kind: "product-create", section: "products" });
  assert.equal(creatorRouteTitle(parseCreatorRoute("/studio/products/new")), "New Agent");
  assert.equal(parseCreatorRoute("/studio/tasks/new").kind, "not-found");
  for (const tab of ["storefront", "versions", "readiness"]) {
    assert.deepEqual(parseCreatorRoute(`/studio/products/p1/${tab}`), { kind: "agent", section: "products", productId: "p1", tab });
    assert.equal(creatorProductPath("p1", tab), `/studio/products/p1/${tab}`);
  }
  assert.equal(creatorProductPath("p1", "build"), "/studio/factory/p1");
  assert.deepEqual(parseCreatorRoute("/studio/products/p1/releases/r9"), { kind: "agent", section: "products", productId: "p1", tab: "versions", releaseId: "r9" });
  assert.deepEqual(parseCreatorRoute("/studio/products/p1/candidates/c2"), { kind: "candidate", section: "products", productId: "p1", candidateId: "c2" });
});

test("old Product URLs redirect to the matching Agent workspace tab", () => {
  for (const tab of ["", "/files", "/brief", "/overview", "/complete", "/about-you", "/corpus"]) {
    assert.deepEqual(parseCreatorRoute(`/studio/products/p1${tab}`), { kind: "redirect", section: "products", to: "/studio/factory/p1" });
  }
  assert.deepEqual(parseCreatorRoute("/studio/products/p1/preview"), { kind: "redirect", section: "products", to: "/studio/products/p1/storefront" });
});

test("orders, earnings and settings are Studio sections", () => {
  assert.deepEqual(parseCreatorRoute("/studio/orders"), { kind: "orders", section: "orders" });
  assert.deepEqual(parseCreatorRoute("/studio/orders/HAT-1"), { kind: "order", section: "orders", orderId: "HAT-1" });
  assert.deepEqual(parseCreatorRoute("/studio/earnings"), { kind: "earnings", section: "earnings" });
  assert.deepEqual(parseCreatorRoute("/studio/settings"), { kind: "settings", section: "settings" });
  // The payout provider returns to /studio/payouts after onboarding.
  assert.deepEqual(parseCreatorRoute("/studio/payouts"), { kind: "redirect", section: "earnings", to: "/studio/earnings" });
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
  assert.deepEqual(parseCreatorRoute("/studio/factory"), { kind: "redirect", section: "products", to: "/studio/products" });
});
