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
  "creator-dashboard/src/components/DesktopSystem.stories.css"
];

test("Web page CSS consumes the shared Hatch typography scale", () => {
  const styles = webStylesheets.map(read).join("\n");

  assert.doesNotMatch(styles, /font-size:\s*[0-9]+(?:\.[0-9]+)?(?:px|rem)/);
  assert.doesNotMatch(styles, /font-size:\s*clamp\(\s*[0-9]/);
  assert.doesNotMatch(styles, /line-height:\s*[0-9]+(?:\.[0-9]+)?px/);
  assert.match(styles, /var\(--hatch-type-(?:label|control|body|reading|title|display)\)/);
});

test("Web entrypoint consumes HUI instead of a second component stylesheet", () => {
  const entry = read("creator-dashboard/src/main.jsx");

  assert.match(entry, /from "@hatch\/ui"/);
  assert.match(entry, /import "@hatch\/ui\/theme\.css"/);
  assert.doesNotMatch(entry, /components\/ui\//);
});

test("creator navigation uses a standard hamburger menu on narrow screens", () => {
  const source = read("creator-dashboard/src/CreatorPortalV2.jsx");
  const styles = read("creator-dashboard/src/creatorPortalV2.css");

  assert.match(source, /className="cpv2-mobile-nav"/);
  assert.match(source, /<DropdownMenu[\s\S]*label="Creator navigation"/);
  assert.match(styles, /\.cpv2-mobile-nav\s*\{\s*display:\s*none;\s*\}/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-global-nav\s*\{\s*display:\s*none;\s*\}/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-mobile-nav\s*\{[\s\S]*?display:\s*block;/s);
  assert.match(styles, /\.cpv2-mobile-nav \.hui-icon-button\s*\{[\s\S]*?min-height:\s*40px;[\s\S]*?min-width:\s*40px;/s);
  assert.doesNotMatch(source, /Skip to content/);
  assert.doesNotMatch(styles, /cpv2-skip/);
});
