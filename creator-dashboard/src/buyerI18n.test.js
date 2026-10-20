import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buyerT, buyerDictionary, buyerCopyKeys } from "./buyerI18n.js";

const sourceKeys = (file) => {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/\bt\(\s*(["'])((?:(?!\1).)*)\1/g)].map((match) => match[2]);
};

test("every visible buyer string has a Chinese and Japanese translation", () => {
  const keys = new Set(buyerCopyKeys());
  const used = ["BuyerPortalV2.jsx", "StorefrontDetails.jsx", "BuyerAccountControls.jsx", "AccountAvatarSettings.jsx"]
    .flatMap(sourceKeys)
    .filter((key) => !key.startsWith("/") && !["2d", "canvas"].includes(key));
  const missing = [...new Set(used)].filter((key) => !keys.has(key));
  assert.deepEqual(missing, []);
});

test("Japanese copy never reuses the Chinese text", () => {
  const zh = buyerDictionary("zh");
  const han = /[\u4e00-\u9fff]/;
  for (const [key, ja] of Object.entries(buyerDictionary("ja"))) {
    assert.ok(!(han.test(ja) && ja === zh[key]), `ja copy for "${key}" is the Chinese text`);
  }
});

test("buyer copy provides distinct Chinese and Japanese navigation and task states", () => {
  for (const locale of ["zh", "ja"]) {
    for (const key of ["Explore", "Library", "Orders", "Sign in", "Ask an expert who has done it before.", "You're signed in as an expert.", "Please sign in again.", "Confirm order", "Page not found", "Loading details"]) {
      assert.notEqual(buyerT(locale, key), key, `${locale} must translate ${key}`);
    }
  }
});

test("buyer copy falls back to source English and interpolates values", () => {
  assert.equal(buyerT("en", "Explore"), "Explore");
  assert.equal(buyerT("zh", "Unknown {value}", { value: 3 }), "Unknown 3");
  assert.equal(buyerT("zh", "Order #{reference}", { reference: "A1" }), "订单号 A1");
  assert.ok(Object.keys(buyerDictionary("ja")).length > 200);
});
