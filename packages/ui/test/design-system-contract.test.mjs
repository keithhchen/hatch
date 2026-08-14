import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path) => readFileSync(`${repoRoot}/${path}`, "utf8");
const json = (path) => JSON.parse(read(path));

test("@hatch/ui owns the shared Button, Dialog, Select and CSS entrypoint", () => {
  const packageJson = json("packages/ui/package.json");
  const index = read("packages/ui/src/index.js");
  const button = read("packages/ui/src/Button.jsx");
  const overlays = read("packages/ui/src/Overlays.jsx");

  assert.equal(packageJson.name, "@hatch/ui");
  assert.equal(packageJson.exports["."], "./src/index.js");
  assert.equal(packageJson.exports["./theme.css"], "./src/hatch-ui.css");
  assert.match(index, /import "\.\/hatch-ui\.css"/);
  assert.match(index, /export \* from "\.\/Button\.jsx"/);
  assert.match(index, /export \* from "\.\/Overlays\.jsx"/);
  assert.match(button, /export function Button/);
  assert.match(overlays, /export const Dialog = DialogPrimitive\.Root/);
  assert.match(overlays, /export function Select/);

  for (const duplicate of [
    "creator-dashboard/src/components/ui/Button.jsx",
    "creator-dashboard/src/components/ui/Overlays.jsx",
    "creator-dashboard/src/components/ui/hatch-ui.css",
    "creator-dashboard/src/HatchBrand.jsx"
  ]) {
    assert.equal(existsSync(`${repoRoot}/${duplicate}`), false, `${duplicate} must not return as a second source`);
  }
});

test("Web and Storybook consume the shared package and its canonical tokens", () => {
  const webPackage = json("creator-dashboard/package.json");
  const webEntry = read("creator-dashboard/src/main.jsx");
  const creatorPortal = read("creator-dashboard/src/CreatorPortalV2.jsx");
  const creatorCss = read("creator-dashboard/src/creatorPortalV2.css");
  const storybookPreview = read("creator-dashboard/.storybook/preview.jsx");
  const sharedCss = read("packages/ui/src/hatch-ui.css");

  assert.equal(webPackage.dependencies["@hatch/ui"], "file:../packages/ui");
  assert.match(webEntry, /from "@hatch\/ui"/);
  assert.match(storybookPreview, /from "@hatch\/ui"/);
  assert.match(webEntry, /import "@hatch\/ui\/theme\.css"/);
  assert.match(storybookPreview, /import "@hatch\/ui\/theme\.css"/);
  assert.match(sharedCss, /^@import "\.\.\/\.\.\/brand\/tokens\.css";/);

  for (const consumer of [webEntry, storybookPreview]) {
    assert.doesNotMatch(consumer, /packages\/brand\/tokens\.css/);
    assert.doesNotMatch(consumer, /components\/ui\//);
  }

  assert.doesNotMatch(creatorPortal, /className="cpv2-(?:primary|secondary|danger)"/);
  assert.doesNotMatch(creatorCss, /\.cpv2-(?:primary|secondary|danger)(?:\b|,)/);
  assert.match(creatorPortal, /<FormField label="Task name" required><Input/);
  assert.match(creatorPortal, /<FormField label="Authority"><Select/);
  assert.match(creatorPortal, /<Checkbox key=\{lossId\}/);
  assert.doesNotMatch(creatorPortal, /<(?:input|textarea|select)\b/);
  assert.doesNotMatch(creatorCss, /\.cpv2-factory-draft\s+(?:input|select|textarea)/);
});

test("Theme Lab edits the same token knobs used by the shared CSS", () => {
  const story = read("packages/ui/src/DesignSystemGui.stories.jsx");
  const tokens = read("packages/brand/tokens.css");
  const sharedCss = read("packages/ui/src/hatch-ui.css");

  for (const control of [
    "buttonSize",
    "buttonVariant",
    "buttonState",
    "primaryColor",
    "canvasColor",
    "radius",
    "atmosphereStrength",
    "motion"
  ]) assert.match(story, new RegExp(`${control}:`));

  assert.match(story, /"--hatch-ui-primary": args\.primaryColor/);
  assert.match(story, /"--hatch-atmosphere-base": args\.canvasColor/);
  assert.match(story, /"--hatch-atmosphere-strength": args\.atmosphereStrength/);
  assert.doesNotMatch(story, /"--hatch-atmosphere-canvas": args\.canvasColor/);

  for (const token of [
    "--hatch-font-display",
    "--hatch-font-ui",
    "--hatch-font-pill",
    "--hatch-radius-control",
    "--hatch-radius-dialog",
    "--hatch-shadow-control",
    "--hatch-shadow-dialog",
    "--hatch-ui-status-progress-bg",
    "--hatch-atmosphere-base",
    "--hatch-atmosphere-warm-field",
    "--hatch-atmosphere-cool-field"
  ]) assert.match(tokens, new RegExp(token));

  assert.match(sharedCss, /background: var\(--hatch-atmosphere-warm-field\)/);
  assert.match(sharedCss, /background: var\(--hatch-atmosphere-cool-field\)/);
  assert.doesNotMatch(sharedCss, /\.hui-drawer\.is-(?:right|bottom)[^{]*\{[^}]*border-radius:[^;]*\b0\b/s);
});

test("the archived material comparison cannot leak into the confirmed origin theme", () => {
  const sharedCss = read("packages/ui/src/hatch-ui.css");
  const materialStart = sharedCss.indexOf(".hui-theme-material {");
  const originStart = sharedCss.indexOf("/* Origin Return");

  assert.ok(materialStart > 0, "material comparison must have an explicit theme scope");
  assert.ok(originStart > materialStart, "origin theme must remain separate from material comparison");
  assert.match(sharedCss.slice(materialStart, originStart), /\.hui-theme-material\s*\{[\s\S]*\.hui-button/);
  assert.match(sharedCss, /\.hui-theme-origin \.hui-navigation-item\.is-active\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
});
