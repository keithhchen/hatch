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
  const brandTokens = readFileSync(new URL("../../packages/brand/tokens.css", import.meta.url), "utf8");
  assert.match(brandTokens, /^:root\s*\{[^}]*--hatch-avatar-gradient:\s*linear-gradient\(135deg, #f5b700, #e08a3c\);/m);
  assert.doesNotMatch(readFileSync(new URL("./webTheme.css", import.meta.url), "utf8"), /--hatch-avatar-gradient/);
  assert.match(sharedUiStyles, /\.hui-avatar__fallback\s*\{[^}]*font-family:\s*var\(--hatch-font-ui\);[^}]*font-weight:\s*var\(--hatch-weight-bold\);/);
});

test("Studio opens for any signed-in account; signed-out visitors go to the one sign-up flow", () => {
  assert.doesNotMatch(appSource, /\brole\b|RoleBoundary|WebChatRoleGate|creator-signup/);
  assert.match(appSource, /if \(sessionStatus !== "authenticated"\) \{\s+return <RouteRedirect to=\{`\/sign-up\?returnTo=/);
  assert.doesNotMatch(source, /creatorIntent|creator-signup|isExpert|\.role\b/);
  assert.match(source, /params\.get\("returnTo"\) \|\| STUDIO_ROOT/);
});

test("buyer navigation is two tabs, Explore and Studio, with My library/settings in the avatar menu and no search", () => {
  const nav = source.match(/<nav className="buyer-v2__nav"[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/<RouterLink to=\{(\w+)\}/g)].map((match) => match[1]), ["EXPLORE_ROOT", "STUDIO_ROOT"]);
  assert.match(source, /<WebBrand as=\{RouterLink\} className="buyer-v2__brand" to="\/"/);
  assert.doesNotMatch(source, /buyer-v2__mobile-nav|buyer-v2__studio-link|HOME_ROOT|type="search"/);
  assert.match(accountSource, /href: "\/library"[\s\S]*href: "\/account"/);
  assert.doesNotMatch(source, /github\.com\/keithhchen\/hatch-releases\/releases\/latest/);
});

test("the web app offers no Desktop link or instruction: success page, account menus, storefront", () => {
  const creatorPortal = readFileSync(new URL("./CreatorPortalV2.jsx", import.meta.url), "utf8");
  const storefront = readFileSync(new URL("./StorefrontDetails.jsx", import.meta.url), "utf8");
  for (const [name, text] of Object.entries({ source, accountSource, creatorPortal, storefront })) {
    assert.doesNotMatch(text, /\/download|Hatch Desktop|hatch:\/\/|desktopRequirement|desktop_(download|open)_clicked/, name);
  }
});

test("Explore is Discover | My library, one URL each, with no remembered tab and no side column", () => {
  assert.match(source, /<SegmentedControl[\s\S]*?className="buyer-v2__explore-tabs"[\s\S]*?value === "library" \? LIBRARY_ROOT : EXPLORE_ROOT/);
  assert.doesNotMatch(source, /EXPLORE_TAB_KEY|localStorage/);
  assert.doesNotMatch(stylesheet, /buyer-v2__explore-side|buyer-v2__explore\.is-/);
  assert.doesNotMatch(source, /Skip to content/);
  assert.doesNotMatch(stylesheet, /buyer-v2__skip/);
});

test("the retired purchase model leaves no Buyer route, copy or style behind", () => {
  assert.doesNotMatch(source, /CheckoutPage|SuccessPage|OrdersPage|OrderPage|SubscriptionsPage|checkout|ORDERS_ROOT/i);
  assert.doesNotMatch(stylesheet, /checkout|receipt|buyer-v2__order/);
});
