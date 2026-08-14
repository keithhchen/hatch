import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path) => readFileSync(`${repoRoot}/${path}`, "utf8");
const json = (path) => JSON.parse(read(path));
const tokenHex = (css, name) => css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
const luminance = (hex) => {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((value) => parseInt(value, 16) / 255).map((value) => (
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (foreground, background) => {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
};

test("@hatch/ui owns the shared Button, Dialog, Select and CSS entrypoint", () => {
  const packageJson = json("packages/ui/package.json");
  const index = read("packages/ui/src/index.js");
  const button = read("packages/ui/src/Button.jsx");
  const navigation = read("packages/ui/src/Navigation.jsx");
  const overlays = read("packages/ui/src/Overlays.jsx");

  assert.equal(packageJson.name, "@hatch/ui");
  assert.equal(packageJson.exports["."], "./src/index.js");
  assert.equal(packageJson.exports["./theme.css"], "./src/hatch-ui.css");
  assert.match(index, /import "\.\/hatch-ui\.css"/);
  assert.match(index, /export \* from "\.\/Button\.jsx"/);
  assert.match(index, /export \* from "\.\/Overlays\.jsx"/);
  assert.match(button, /export function Button/);
  assert.match(navigation, /export function NavigationItem/);
  assert.match(navigation, /trailing/);
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
  const creatorFactory = read("creator-dashboard/src/CreatorFactoryRuns.jsx");
  const buyerPortal = read("creator-dashboard/src/BuyerPortalV2.jsx");
  const creatorCss = read("creator-dashboard/src/creatorPortalV2.css");
  const storefrontCss = read("creator-dashboard/src/storefrontDetails.css");
  const desktopCss = read("desktop-app/src/renderer/styles.css");
  const desktopStory = read("creator-dashboard/src/components/DesktopSystem.stories.jsx");
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
  assert.match(creatorPortal, /<HatchTabs[\s\S]*ariaLabel="Product sections"/);
  assert.match(creatorPortal, /<Checkbox key=\{lossId\}/);
  assert.doesNotMatch(creatorPortal, /<(?:input|textarea|select)\b/);
  assert.match(creatorFactory, /from\s+["']@hatch\/ui["']/);
  assert.doesNotMatch(creatorFactory, /<(?:input|textarea|select)\b/);
  assert.doesNotMatch(creatorCss, /\.cpv2-factory-draft\s+(?:input|select|textarea)/);
  assert.match(creatorCss, /\.cpv2-panel\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;/s);
  assert.match(storefrontCss, /\.storefront-shared__hero\s*\{[^}]*padding:\s*clamp\([^;]+\)\s+4px\s+clamp\(/s);
  assert.match(storefrontCss, /\.storefront-shared__access\s*\{[^}]*background:\s*color-mix\([^;]+var\(--hatch-ui-surface-raised/s);
  assert.doesNotMatch(storefrontCss, /\.storefront-shared__access\s*\{[^}]*background:\s*linear-gradient/s);
  assert.match(desktopCss, /\.desktop-window-shell\s*\{[^}]*--surface-window:\s*var\(--hatch-ui-surface-window\)/s);
  assert.match(desktopCss, /\.desktop-ui-root\s*\{[^}]*height:\s*100%;/s);
  assert.doesNotMatch(desktopCss, /\.desktop-window-shell::before/);
  assert.match(desktopCss, /\.desktop-sidebar-heading \.desktop-sidebar-brand \.hatch-brand__wordmark\s*\{[^}]*letter-spacing:\s*var\(--hatch-display-tracking\)/s);
  assert.match(desktopStory, /title:\s*["']Hatch\/Desktop visual system["']/);
  assert.match(desktopStory, /atmosphereStrength/);
  assert.doesNotMatch(desktopCss, /\.welcome-brand \.hatch-brand__wordmark\s*\{[^}]*letter-spacing:\s*-\.035em/s);
  assert.doesNotMatch(desktopCss, /\.desktop-sidebar-heading \.desktop-sidebar-brand \.hatch-brand__wordmark\s*\{[^}]*letter-spacing:\s*-\.035em/s);
  assert.match(buyerPortal, /className="buyer-v2__settings-surface"/);
  assert.doesNotMatch(buyerPortal, /<div><dt>Role<\/dt>/);
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
    "displayTracking",
    "displayLeading",
    "atmosphereStrength",
    "motion"
  ]) assert.match(story, new RegExp(`${control}:`));

  assert.match(story, /"--hatch-ui-primary": args\.primaryColor/);
  assert.match(story, /"--hatch-atmosphere-base": args\.canvasColor/);
  assert.match(story, /"--hatch-atmosphere-strength": args\.atmosphereStrength/);
  assert.match(story, /"--hatch-display-tracking": `\$\{args\.displayTracking\}em`/);
  assert.match(story, /"--hatch-display-leading": args\.displayLeading/);
  assert.doesNotMatch(story, /"--hatch-atmosphere-canvas": args\.canvasColor/);

  for (const token of [
    "--hatch-font-display",
    "--hatch-font-ui",
    "--hatch-font-pill",
    "--hatch-display-tracking",
    "--hatch-display-leading",
    "--hatch-radius-control",
    "--hatch-radius-dialog",
    "--hatch-shadow-control",
    "--hatch-shadow-dialog",
    "--hatch-ui-status-progress-bg",
    "--hatch-ui-surface-window",
    "--hatch-ui-surface-sidebar",
    "--hatch-ui-surface-toolbar",
    "--hatch-ui-surface-inspector",
    "--hatch-ui-primary-hover",
    "--hatch-atmosphere-base",
    "--hatch-atmosphere-warm-field",
    "--hatch-atmosphere-cool-field"
  ]) assert.match(tokens, new RegExp(token));

  assert.match(tokens, /--hatch-display-tracking:\s*-.06em/);
  assert.match(tokens, /--hatch-display-leading:\s*\.86/);

  assert.match(tokens, /--hatch-ui-surface-window:\s*var\(--hatch-atmosphere-base\)/);

  assert.match(sharedCss, /background: var\(--hatch-atmosphere-warm-field\)/);
  assert.match(sharedCss, /background: var\(--hatch-atmosphere-cool-field\)/);
  assert.match(sharedCss, /\.hatch-brand__wordmark[^}]*letter-spacing:\s*var\(--hatch-display-tracking\)/s);
  assert.match(sharedCss, /\.hui-page-header h1[^}]*line-height:\s*var\(--hatch-display-leading\)/s);
  assert.match(sharedCss, /\.hui-button\s*\{[^}]*font-family:\s*var\(--hui-font-pill\)/s);
  assert.match(sharedCss, /\.hui-field__label\s*\{[^}]*font-family:\s*var\(--hui-font-pill\)/s);
  assert.doesNotMatch(sharedCss, /\.hui-drawer\.is-(?:right|bottom)[^{]*\{[^}]*border-radius:[^;]*\b0\b/s);
});

test("confirmed text tokens remain legible without relying on the background artwork", () => {
  const tokens = read("packages/brand/tokens.css");
  const canvas = tokenHex(tokens, "--hatch-atmosphere-base");

  for (const token of ["--hatch-ui-ink", "--hatch-ui-ink-soft", "--hatch-ui-ink-faint", "--hatch-ui-accent", "--hatch-ui-accent-hover"]) {
    const foreground = tokenHex(tokens, token);
    assert.ok(foreground, `${token} must remain a fixed hex token`);
    assert.ok(contrast(foreground, canvas) >= 4.5, `${token} must meet WCAG AA against the Atmospheric Paper canvas`);
  }
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
