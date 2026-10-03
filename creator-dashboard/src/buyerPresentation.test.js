import assert from "node:assert/strict";
import test from "node:test";
import { accountInitials, humanizeIdentifier, meaningfulReversalStatus } from "./buyerPresentation.js";

test("buyer avatar initials come from the signed-in account identity", () => {
  assert.equal(accountInitials({ initials: "KC" }), "KC");
  assert.equal(accountInitials({ display_name: "Keith Chen" }), "KC");
  assert.equal(accountInitials({ email: "keith@example.com" }), "KE");
  assert.equal(accountInitials({}), "A");
});

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
