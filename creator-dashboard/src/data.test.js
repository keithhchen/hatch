import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, orderStatusLabel, productStatusLabel } from "./data.js";

test("creator revenue is formatted from integer minor units", () => {
  assert.equal(formatMoney(3510), "$35.10");
  assert.equal(formatMoney(390), "$3.90");
});

test("order status labels stay creator-facing", () => {
  assert.equal(orderStatusLabel("delivered"), "Delivered");
  assert.equal(orderStatusLabel("paid"), "Paid");
  assert.equal(orderStatusLabel("refunded"), "Refunded");
});

test("product status labels stay creator-facing", () => {
  assert.equal(productStatusLabel("ready_to_publish"), "Ready to publish");
  assert.equal(productStatusLabel("preparing"), "Preparing");
  assert.equal(productStatusLabel("published"), "Published");
});
