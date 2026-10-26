import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_OPS_COPY, eventLabel, statusLabel } from "./studioOpsCopy.js";
import {
  ORDER_FILTER_OPTIONS,
  activeFilterCount,
  dayBoundary,
  formatMinor,
  orderShares,
  ordersQuery,
  payoutSetupState
} from "./studioOpsModel.js";

test("formatMinor converts minor units per currency and locale", () => {
  assert.equal(formatMinor(1999, "USD", "en"), "$19.99");
  assert.equal(formatMinor(0, "USD", "en"), "$0.00");
  assert.equal(formatMinor(1500, "JPY", "ja"), "￥1,500");
  assert.match(formatMinor(123456, "USD", "zh"), /1,234\.56/);
  assert.equal(formatMinor(null, "USD", "en"), "");
});

test("ordersQuery maps filters and paging to the orders API query", () => {
  assert.equal(ordersQuery({}), "");
  const query = new URLSearchParams(ordersQuery(
    { product: "p1", order: "", payment: "paid", delivery: "completed", refund: "none", from: "2026-10-01", to: "2026-10-31" },
    { limit: 500, cursor: "MjU" }
  ).slice(1));
  assert.equal(query.get("product"), "p1");
  assert.equal(query.has("order"), false);
  assert.equal(query.get("payment"), "paid");
  assert.equal(query.get("delivery"), "completed");
  assert.equal(query.get("refund"), "none");
  assert.equal(query.get("from"), new Date("2026-10-01T00:00:00.000").toISOString());
  assert.equal(query.get("to"), new Date("2026-10-31T23:59:59.999").toISOString());
  assert.equal(query.get("limit"), "100");
  assert.equal(query.get("cursor"), "MjU");
  assert.equal(dayBoundary("not-a-date", "start"), "");
  assert.equal(activeFilterCount({ product: "p1", from: "2026-10-01", order: " " }), 2);
});

test("orderShares sums recognized revenue and ignores reversed entries", () => {
  assert.deepEqual(orderShares({ revenue: [
    { status: "recognized", creator_share_minor: 700, hatch_share_minor: 300 },
    { status: "reversed", creator_share_minor: 700, hatch_share_minor: 300 }
  ] }), { recognized: true, creator: 700, hatch: 300 });
  assert.deepEqual(orderShares({ revenue: [] }), { recognized: false, creator: null, hatch: null });
});

test("payout setup state follows the API contract", () => {
  assert.equal(payoutSetupState({ setup_status: "unavailable", setup_available: false }), "unavailable");
  assert.equal(payoutSetupState({ setup_status: "required", setup_available: true }), "required");
  assert.equal(payoutSetupState({ setup_status: "complete", setup_available: true }), "complete");
});

test("copy is complete and consistent across zh, en and ja", () => {
  const shape = (value) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "adapter")
    .map(([key, entry]) => [key, entry && typeof entry === "object" ? Object.keys(entry).sort() : typeof entry]));
  const en = shape(STUDIO_OPS_COPY.en);
  for (const locale of ["zh", "ja"]) {
    assert.deepEqual(shape(STUDIO_OPS_COPY[locale]), en, `${locale} copy keys match en`);
  }
  for (const [locale, copy] of Object.entries(STUDIO_OPS_COPY)) {
    const strings = JSON.stringify(copy, (key, value) => typeof value === "function" ? value(1) : value);
    assert.doesNotMatch(strings, /[!！?？]/, `${locale} copy has no ! or ?`);
  }
  for (const value of Object.values(ORDER_FILTER_OPTIONS).flat()) {
    for (const locale of ["zh", "en", "ja"]) assert.ok(STUDIO_OPS_COPY[locale].status[value], `${locale} status ${value}`);
  }
  assert.equal(statusLabel(STUDIO_OPS_COPY.ja, "refunded"), "返金済み");
  assert.equal(eventLabel(STUDIO_OPS_COPY.en, "custom.event"), "custom.event");
});
