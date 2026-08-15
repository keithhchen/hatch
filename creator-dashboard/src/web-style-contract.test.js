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

test("creator navigation preserves complete labels on narrow screens", () => {
  const styles = read("creator-dashboard/src/creatorPortalV2.css");

  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-sidebar > nav:not\(\.cpv2-global-nav\)\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-global-nav\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/s);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.cpv2-global-nav a\s*\{[\s\S]*?flex:\s*0 0 auto;[\s\S]*?white-space:\s*nowrap;/s);
});
