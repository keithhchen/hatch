import assert from "node:assert/strict";
import test from "node:test";
import {
  creatorOrderQuery,
  payoutActionLabel,
  payoutCanRetry,
  storefrontModel
} from "./storefrontModel.js";

test("shared storefront model preserves client-safe content and never invents missing evidence", () => {
  const model = storefrontModel({
    product_name: "Signal Review",
    product_promise: "A bounded review.",
    inputs: ["Resume", { label: "Target role" }],
    boundaries: [{ description: "No hiring guarantee" }]
  });
  assert.equal(model.name, "Signal Review");
  assert.deepEqual(model.inputs, ["Resume", "Target role"]);
  assert.deepEqual(model.outputs, []);
  assert.deepEqual(model.boundaries, ["No hiring guarantee"]);
  assert.equal(model.privacy, "");
  assert.equal(model.desktopRequirement, "");
  assert.equal(model.refundPolicy, "");

  const registryPresentation = storefrontModel({
    presentation: {
      inputs: ["Local brief"],
      outputs: ["Reviewed artifact"],
      boundaries: ["No automatic publishing"]
    }
  });
  assert.deepEqual(registryPresentation.inputs, ["Local brief"]);
  assert.deepEqual(registryPresentation.outputs, ["Reviewed artifact"]);
  assert.deepEqual(registryPresentation.boundaries, ["No automatic publishing"]);
});

test("Creator order query carries complete server-side filters and page size", () => {
  const query = new URLSearchParams(creatorOrderQuery({
    order: "fulfilled",
    payment: "paid",
    delivery: "completed",
    product: "product-a",
    from: "2026-08-01",
    to: "2026-08-12",
    refund: "none",
    limit: 25,
    ignored: "private"
  }));
  assert.deepEqual(Object.fromEntries(query), {
    order: "fulfilled",
    payment: "paid",
    delivery: "completed",
    product: "product-a",
    from: "2026-08-01",
    to: "2026-08-12",
    refund: "none",
    limit: "25"
  });
});

test("payout actions distinguish onboarding and idempotent failure retry", () => {
  assert.equal(payoutActionLabel("not_connected"), "Connect payouts");
  assert.equal(payoutActionLabel("onboarding_incomplete"), "Continue setup");
  assert.equal(payoutCanRetry("failed"), true);
  assert.equal(payoutCanRetry("in_transit"), false);
});
