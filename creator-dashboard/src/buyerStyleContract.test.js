import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesheet = readFileSync(new URL("./buyerPortalV2.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./BuyerPortalV2.jsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");

test("buyer detail values remain inside their grid at long real identifiers", () => {
  assert.match(stylesheet, /\.buyer-v2__detail-card\s*\{[^}]*min-width:\s*0;/);
  assert.match(stylesheet, /\.buyer-v2__definition-list dd\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
});

test("creator identity stays circular and never falls back to a byline", () => {
  assert.match(stylesheet, /\.buyer-v2__creator-avatar\s*\{[^}]*border-radius:\s*50%;/);
  assert.match(stylesheet, /\.buyer-v2__creator-profile-avatar\s*\{[^}]*border-radius:\s*50%;/);
  assert.doesNotMatch(source, />by\s+\{/);
});

test("a non-Creator account is sent to the real Creator signup intent", () => {
  assert.match(appSource, /profile\?\.role !== "creator"/);
  assert.match(appSource, /Create a Creator account/);
  assert.match(appSource, /if \(sessionStatus !== "authenticated"\) \{\s+return <RouteRedirect to=\{`\/sign-up\?returnTo=/);
  assert.match(appSource, /location\.navigate\(`\/sign-up\?returnTo=/);
  assert.match(source, /const creatorIntent = returnTo === "\/studio" \|\| returnTo\.startsWith\("\/studio\/"\)/);
  assert.match(source, /creatorIntent \? "\/v1\/auth\/creator-signup" : "\/v1\/auth\/signup"/);
});

test("buyer navigation uses a standard hamburger menu on narrow screens", () => {
  assert.match(source, /className="buyer-v2__mobile-nav"/);
  assert.match(source, /<DropdownMenu[\s\S]*label="Buyer navigation"/);
  assert.match(stylesheet, /\.buyer-v2__mobile-nav\s*\{\s*display:\s*none;\s*\}/);
  assert.match(stylesheet, /@media\s*\(max-width:\s*840px\)[\s\S]*?\.buyer-v2__nav\s*\{\s*display:\s*none;\s*\}/s);
  assert.match(stylesheet, /@media\s*\(max-width:\s*840px\)[\s\S]*?\.buyer-v2__mobile-nav\s*\{[\s\S]*?display:\s*block;/s);
  assert.match(stylesheet, /\.buyer-v2__mobile-nav \.hui-icon-button\s*\{[\s\S]*?min-height:\s*40px;[\s\S]*?min-width:\s*40px;/s);
});
