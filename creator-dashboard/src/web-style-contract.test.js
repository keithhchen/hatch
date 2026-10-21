import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(`${repoRoot}/${path}`, "utf8");

const webStylesheets = [
  "creator-dashboard/src/styles.css",
  "creator-dashboard/src/creatorPortalV2.css",
  "creator-dashboard/src/buyerPortalV2.css",
  "creator-dashboard/src/storefrontDetails.css",
  "creator-dashboard/src/creatorFactory.css",
  "creator-dashboard/src/creatorReview.css",
  "creator-dashboard/src/components/DesktopSystem.stories.css",
  "creator-dashboard/src/downloadPage.css"
];

test("Web CSS follows the visual guidelines: no monospace, no uppercase labels", () => {
  const styles = [...webStylesheets, "creator-dashboard/src/webTheme.css", "creator-dashboard/src/web/web.css", "creator-dashboard/src/webChat.css"].map(read).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

  assert.doesNotMatch(styles, /monospace|DM Mono|font-family:\s*var\(--mono\)/);
  assert.doesNotMatch(styles, /text-transform:\s*uppercase/);
});

test("Web headings use DM Sans; the serif is reserved for brand moments", () => {
  const theme = read("creator-dashboard/src/webTheme.css");
  const entry = read("creator-dashboard/src/main.jsx");

  assert.match(entry, /import "\.\/webTheme\.css"/);
  assert.match(theme, /--hatch-font-display:\s*var\(--web-sans\)/);
  assert.match(theme, /html body h1,[^{]*\{[^}]*font-family:\s*var\(--web-sans\);[^}]*font-weight:\s*700/s);
});

test("Web entrypoint consumes HUI instead of a second component stylesheet", () => {
  const entry = read("creator-dashboard/src/main.jsx");

  assert.match(entry, /from "@hatch\/ui"/);
  assert.match(entry, /import "@hatch\/ui\/theme\.css"/);
  assert.doesNotMatch(entry, /components\/ui\//);
});

test("Sign-in uses the Web lockup", () => {
  const source = read("creator-dashboard/src/BuyerPortalV2.jsx");
  const brand = read("creator-dashboard/src/WebBrand.jsx");

  assert.match(source, /const authBrandClassName = "buyer-v2__brand"/);
  assert.match(source, /<WebBrand as=\{RouterLink\} className=\{authBrandClassName\}/);
  assert.doesNotMatch(source, /HatchBrand/);
  assert.match(brand, /hatch-lockup\.svg/);
});

test("Web eyebrow labels stay visible despite the shared global eyebrow rule", () => {
  const styles = read("creator-dashboard/src/web/web.css");

  assert.match(styles, /\.site \.eyebrow\s*\{[\s\S]*?display:\s*block;/);
});

test("Auth language switcher lives in the auth navbar", () => {
  const styles = read("creator-dashboard/src/buyerPortalV2.css");
  const page = read("creator-dashboard/src/BuyerPortalV2.jsx");

  assert.match(page, /buyer-v2__auth-navbar[\s\S]*?BuyerLanguageMenu className="buyer-v2__auth-language"/);
  assert.match(styles, /\.buyer-v2__auth-navbar\s*\{[\s\S]*?grid-area:\s*navbar;[\s\S]*?justify-content:\s*space-between;/);
  assert.match(styles, /grid-template-areas:\s*"navbar navbar"\s*"context form";/);
});

test("Web home speaks to experts with one try CTA", () => {
  const page = read("creator-dashboard/src/web/HatchPage.tsx");

  assert.match(page, /id=\"top\"/);
  assert.match(page, /fetch\("\/api\/apply"/);
  assert.doesNotMatch(page, /href="\/explore"/);
  assert.match(page, /fetch\(\"\/api\/contact\"/);
  assert.match(page, /<FieldPicker/);
  assert.match(read("creator-dashboard/src/web/landingCopy.ts"), /scenarios: \[/);
  assert.match(page, /className="cta-arrow"[^>]*>→<\/span>/);
  assert.doesNotMatch(page, /Agent GMV|Marketplace|Skill 太薄/);
});

test("creator navigation is a sidebar that becomes a drawer on narrow screens", () => {
  const source = read("creator-dashboard/src/CreatorPortalV2.jsx");
  const styles = read("creator-dashboard/src/creatorPortalV2.css");

  assert.match(source, /className=\{`sx-sidebar\$\{drawerOpen \? " is-open" : ""\}`\}/);
  assert.match(source, /className="sx-mobilebar"/);
  assert.match(source, /label=\{t\("openNavigation"\)\}/);
  assert.match(styles, /\.sx-mobilebar\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sx-mobilebar\s*\{[^}]*display:\s*flex;/s);
  assert.match(styles, /@media\s*\(max-width:\s*900px\)[\s\S]*?\.sx-sidebar\s*\{[^}]*transform:\s*translateX\(-105%\)/s);
  assert.doesNotMatch(source, /Skip to content/);
  assert.doesNotMatch(styles, /cpv2-skip/);
});
