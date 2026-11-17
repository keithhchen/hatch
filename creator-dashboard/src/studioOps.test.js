import test from "node:test";
import assert from "node:assert/strict";
import { STUDIO_OPS_COPY, statusLabel } from "./studioOpsCopy.js";
import {
  formatMinor,
  payoutSetupState,
  userLabelKey,
  userRows,
  userTotals,
  usersQuery
} from "./studioOpsModel.js";

test("formatMinor converts minor units per currency and locale", () => {
  assert.equal(formatMinor(1999, "USD", "en"), "$19.99");
  assert.equal(formatMinor(0, "USD", "en"), "$0.00");
  assert.equal(formatMinor(1500, "JPY", "ja"), "￥1,500");
  assert.match(formatMinor(123456, "USD", "zh"), /1,234\.56/);
  assert.equal(formatMinor(null, "USD", "en"), "");
});

test("usersQuery filters by Agent only when one is chosen", () => {
  assert.equal(usersQuery(""), "");
  assert.equal(usersQuery("p 1"), "?product_id=p%201");
});

test("userRows sorts by last activity, newest first", () => {
  const rows = userRows([
    { kind: "guest", product_id: "p1", last_at: "2026-11-01T00:00:00Z" },
    { kind: "im", product_id: "p2", last_at: "2026-11-03T00:00:00Z" },
    { kind: "account", product_id: "p1", last_at: "2026-11-02T00:00:00Z" }
  ]);
  assert.deepEqual(rows.map((row) => row.kind), ["im", "account", "guest"]);
  assert.deepEqual(userRows(undefined), []);
});

test("userLabelKey maps each kind to its label and defaults to account", () => {
  assert.equal(userLabelKey("guest"), "userGuest");
  assert.equal(userLabelKey("im"), "userIm");
  assert.equal(userLabelKey("account"), "userAccount");
  assert.equal(userLabelKey("other"), "userAccount");
});

test("userTotals counts users, distinct Agents, conversations and messages", () => {
  assert.deepEqual(userTotals([
    { product_id: "p1", conversations: 2, messages: 10 },
    { product_id: "p1", conversations: 1, messages: 3 },
    { product_id: "p2", conversations: 4, messages: 5 }
  ]), { users: 3, agents: 2, conversations: 7, messages: 18 });
  assert.deepEqual(userTotals([]), { users: 0, agents: 0, conversations: 0, messages: 0 });
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
  assert.equal(statusLabel(STUDIO_OPS_COPY.ja, "refunded"), "返金済み");
});
