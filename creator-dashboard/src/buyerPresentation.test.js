import assert from "node:assert/strict";
import test from "node:test";
import { humanizeIdentifier, meaningfulReversalStatus } from "./buyerPresentation.js";

test("buyer presentation omits no-op refund and cancellation states", () => {
  assert.equal(meaningfulReversalStatus(undefined, "none"), null);
  assert.equal(meaningfulReversalStatus("not_requested"), null);
  assert.equal(meaningfulReversalStatus("not_required"), null);
  assert.equal(meaningfulReversalStatus(" pending "), "pending");
  assert.equal(meaningfulReversalStatus(undefined, "cancelled"), "cancelled");
});

test("buyer presentation turns backend identifiers into readable labels", () => {
  assert.equal(humanizeIdentifier("order.placed"), "Order placed");
  assert.equal(humanizeIdentifier("entitlement_units-reserved"), "Entitlement units reserved");
  assert.equal(humanizeIdentifier(""), "Unknown");
});
