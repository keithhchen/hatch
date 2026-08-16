import assert from "node:assert/strict";
import test from "node:test";
import { canAcceptReviewCase, completeReviewMode } from "./creatorReviewUi.js";

test("only an unresolved passing case can be accepted", () => {
  assert.equal(canAcceptReviewCase({ status: "needs_review", verdict: "PASS" }), true);
  assert.equal(canAcceptReviewCase({ status: "needs_review", verdict: "FAIL" }), false);
  assert.equal(canAcceptReviewCase({ status: "accepted", verdict: "PASS" }), false);
});

test("another version is generated only from accumulated corrections", () => {
  assert.equal(completeReviewMode({ rerun_ready: true, release_ready: false }), "rerun");
  assert.equal(completeReviewMode({ rerun_ready: false, release_ready: true }), "publish");
  assert.equal(completeReviewMode({ rerun_ready: false, release_ready: false }), "review");
});
