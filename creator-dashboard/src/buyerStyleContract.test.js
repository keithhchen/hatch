import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesheet = readFileSync(new URL("./buyerPortalV2.css", import.meta.url), "utf8");
const source = readFileSync(new URL("./BuyerPortalV2.jsx", import.meta.url), "utf8");
const appSource = readFileSync(new URL("./main.jsx", import.meta.url), "utf8");
const accountSource = readFileSync(new URL("./BuyerAccountControls.jsx", import.meta.url), "utf8");
const avatarSource = readFileSync(new URL("./AccountAvatar.jsx", import.meta.url), "utf8");
const avatarStyles = readFileSync(new URL("./accountAvatar.css", import.meta.url), "utf8");
const sharedUiStyles = readFileSync(new URL("../../packages/ui/src/hatch-ui.css", import.meta.url), "utf8");

test("buyer detail values remain inside their grid at long real identifiers", () => {
  assert.match(stylesheet, /\.buyer-v2__detail-card\s*\{[^}]*min-width:\s*0;/);
  assert.match(stylesheet, /\.buyer-v2__definition-list dd\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/);
});

test("creator identity stays circular and never falls back to a byline", () => {
  assert.match(stylesheet, /\.buyer-v2__creator-avatar\s*\{[^}]*border-radius:\s*50%;/);
  assert.match(stylesheet, /\.buyer-v2__creator-profile-avatar\s*\{[^}]*border-radius:\s*50%;/);
  assert.doesNotMatch(source, />by\s+\{/);
});

test("account avatars share a gradient circular single-letter fallback", () => {
  assert.match(avatarSource, /charAt\(0\)\.toLocaleUpperCase\(\)/);
  assert.match(avatarStyles, /aspect-ratio:\s*1;/);
  assert.match(avatarStyles, /border-radius:\s*50%;/);
  assert.match(sharedUiStyles, /\.hui-avatar__fallback\s*\{[^}]*background:\s*var\(--hatch-avatar-gradient\);/);
  assert.match(sharedUiStyles, /\.hui-avatar__fallback\s*\{[^}]*font-family:\s*var\(--hatch-font-ui\);[^}]*font-weight:\s*var\(--hatch-weight-bold\);/);
});

test("Studio opens for any signed-in account; signed-out visitors go to the one sign-up flow", () => {
  assert.doesNotMatch(appSource, /\brole\b|RoleBoundary|WebChatRoleGate|creator-signup/);
  assert.match(appSource, /if \(sessionStatus !== "authenticated"\) \{\s+return <RouteRedirect to=\{`\/sign-up\?returnTo=/);
  assert.doesNotMatch(source, /creatorIntent|creator-signup|isExpert|\.role\b/);
  assert.match(source, /params\.get\("returnTo"\) \|\| EXPLORE_ROOT/);
});

test("buyer navigation is two tabs, Explore and Studio, with orders/download/settings in the avatar menu and no search", () => {
  const nav = source.match(/<nav className="buyer-v2__nav"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/<RouterLink to=\{(\w+)\}/g)].map((match) => match[1]), ["EXPLORE_ROOT", "STUDIO_ROOT"]);
  assert.match(source, /<WebBrand as=\{RouterLink\} className="buyer-v2__brand" to=\{EXPLORE_ROOT\}/);
  assert.doesNotMatch(source, /buyer-v2__mobile-nav|buyer-v2__studio-link|HOME_ROOT|LIBRARY_ROOT|type="search"/);
  assert.match(accountSource, /href: "\/explore\/orders"[\s\S]*href: "\/download"[\s\S]*href: "\/account"/);
  assert.match(source, /const DEFAULT_DOWNLOAD_URL = "\/download"/);
  assert.doesNotMatch(source, /github\.com\/keithhchen\/hatch-releases\/releases\/latest/);
});

test("Explore shows one panel at a time behind a remembered segmented switcher on narrow screens", () => {
  assert.match(source, /<SegmentedControl[\s\S]*?className="buyer-v2__explore-tabs"/);
  assert.match(source, /localStorage\.getItem\(EXPLORE_TAB_KEY\)[\s\S]*?catch \{\s*return "discover";/);
  assert.match(stylesheet, /\.buyer-v2__explore-tabs \{ display: none; \}/);
  assert.match(stylesheet, /@media \(max-width: 840px\)[\s\S]*?\.buyer-v2__explore\.is-discover \.buyer-v2__explore-side, \.buyer-v2__explore\.is-mine \.buyer-v2__explore-main \{ display: none; \}/);
  assert.doesNotMatch(source, /Skip to content/);
  assert.doesNotMatch(stylesheet, /buyer-v2__skip/);
});
