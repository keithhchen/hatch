import assert from "node:assert/strict";
import test from "node:test";
import { meaningfulReversalStatus } from "./buyerPresentation.js";

test("buyer presentation omits no-op refund and cancellation states", () => {
  assert.equal(meaningfulReversalStatus(undefined, "none"), null);
  assert.equal(meaningfulReversalStatus("not_requested"), null);
  assert.equal(meaningfulReversalStatus("not_required"), null);
  assert.equal(meaningfulReversalStatus(" pending "), "pending");
  assert.equal(meaningfulReversalStatus(undefined, "cancelled"), "cancelled");
});
