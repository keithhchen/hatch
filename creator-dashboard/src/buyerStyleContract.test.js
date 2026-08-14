import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesheet = readFileSync(new URL("./buyerPortalV2.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./BuyerPortalV2.jsx", import.meta.url), "utf8");

test("buyer detail values remain inside their grid at long real identifiers", () => {
  assert.match(stylesheet, /\.buyer-v2__detail-card\s*\{[^}]*min-width:\s*0;/);
  assert.match(stylesheet, /\.buyer-v2__definition-list dd\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
});

test("creator identity stays circular and never falls back to a byline", () => {
  assert.match(stylesheet, /\.buyer-v2__creator-avatar\s*\{[^}]*border-radius:\s*50%;/);
  assert.match(stylesheet, /\.buyer-v2__creator-profile-avatar\s*\{[^}]*border-radius:\s*50%;/);
  assert.doesNotMatch(source, />by\s+\{/);
});
