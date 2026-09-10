import assert from "node:assert/strict";
import test from "node:test";
import { buyerT, buyerDictionary } from "./buyerI18n.js";

test("buyer copy provides distinct Chinese and Japanese navigation and task states", () => {
  for (const locale of ["zh", "ja"]) {
    for (const key of ["Explore", "Library", "Orders", "Sign in", "Methods you can put to work.", "Your Agent library", "Confirm order", "Page not found", "Loading details"]) {
      assert.notEqual(buyerT(locale, key), key, `${locale} must translate ${key}`);
    }
  }
});

test("buyer copy falls back to source English and interpolates values", () => {
  assert.equal(buyerT("en", "Explore"), "Explore");
  assert.equal(buyerT("zh", "Unknown {value}", { value: 3 }), "Unknown 3");
  assert.ok(Object.keys(buyerDictionary("ja")).length > 50);
});
