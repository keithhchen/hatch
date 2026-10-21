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

test("Web page CSS consumes the shared Hatch typography scale", () => {
  const styles = webStylesheets.map(read).join("\n");

  assert.doesNotMatch(styles, /font-size:\s*[0-9]+(?:\.[0-9]+)?(?:px|rem)/);
  assert.doesNotMatch(styles, /font-size:\s*clamp\(\s*[0-9]/);
  assert.doesNotMatch(styles, /line-height:\s*[0-9]+(?:\.[0-9]+)?px/);
  assert.match(styles, /var\(--hatch-type-(?:label|control|body|reading|title|display)\)/);
});

test("Web reserves the display serif for primary headings", () => {
  const baseStyles = read("creator-dashboard/src/styles.css");
  const creatorStyles = read("creator-dashboard/src/creatorPortalV2.css");
  const buyerStyles = read("creator-dashboard/src/buyerPortalV2.css");
  const storefrontStyles = read("creator-dashboard/src/storefrontDetails.css");

  assert.match(baseStyles, /h1\s*\{[^}]*font-family:\s*var\(--hatch-font-display\)/s);
  assert.match(baseStyles, /h2\s*\{[^}]*font-family:\s*var\(--hatch-font-ui\)/s);
  assert.match(creatorStyles, /\.cpv2 h2\s*\{[^}]*font-family:\s*var\(--hatch-font-ui/);
  assert.match(buyerStyles, /\.buyer-v2 h2\s*\{[^}]*font-family:\s*var\(--hatch-font-ui/);
  assert.match(storefrontStyles, /\.storefront-shared__hero h2\s*\{[^}]*font-family:\s*var\(--hatch-font-ui/);
  assert.match(baseStyles, /\.hatch-app-paper h2\s*\{[^}]*font-family:\s*var\(--hatch-font-ui\)/s);
});

test("Web entrypoint consumes HUI instead of a second component stylesheet", () => {
  const entry = read("creator-dashboard/src/main.jsx");

  assert.match(entry, /from "@hatch\/ui"/);
  assert.match(entry, /import "@hatch\/ui\/theme\.css"/);
  assert.doesNotMatch(entry, /components\/ui\//);
});

test("Web surfaces use the egg lockup instead of the Desktop mark", () => {
  const brand = read("creator-dashboard/src/WebBrand.jsx");
  assert.match(brand, /\/assets\/web\/hatch-lockup\.svg/);
  for (const file of ["BuyerPortalV2.jsx", "CreatorPortalV2.jsx", "DownloadPage.jsx", "WebChatPage.jsx", "main.jsx"]) {
    const source = read(`creator-dashboard/src/${file}`);
    assert.doesNotMatch(source, /<HatchBrand\b/, file);
    assert.match(source, /<WebBrand\b/, file);
  }
  assert.match(read("creator-dashboard/src/BuyerPortalV2.jsx"), /<WebBrand as=\{RouterLink\} className=\{authBrandClassName\}/);
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

test("creator navigation uses a standard hamburger menu on narrow screens", () => {
  const source = read("creator-dashboard/src/CreatorPortalV2.jsx");
  const styles = read("creator-dashboard/src/creatorPortalV2.css");

  assert.match(source, /className="cpv2-mobile-nav"/);
  assert.match(source, /<DropdownMenu[\s\S]*label=\{t\("creatorNavigation"\)\}/);
  assert.match(styles, /\.cpv2-mobile-nav\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-global-nav\s*\{\s*display:\s*none;\s*\}/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-mobile-nav\s*\{[\s\S]*?display:\s*block;/s);
  assert.match(styles, /\.cpv2-mobile-nav \.hui-icon-button\s*\{[\s\S]*?min-height:\s*40px;[\s\S]*?min-width:\s*40px;/s);
  assert.doesNotMatch(source, /Skip to content/);
  assert.doesNotMatch(styles, /cpv2-skip/);
});
