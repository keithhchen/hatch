import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

test("Product file success feedback stays inline instead of becoming a colored card", () => {
  const workspace = read("CreatorProductWorkspace.jsx");
  const sourceLibrary = read("CreatorSourceLibrary.jsx");
  const styles = read("creatorProductWorkspace.css");

  assert.match(workspace, /<InlineAlert className="cpv2-inline-feedback" tone="success">/);
  assert.match(sourceLibrary, /<InlineAlert className="cpv2-inline-feedback" tone="success"/);
  assert.match(styles, /\.cpv2-inline-feedback\.hui-alert[\s\S]*?\{[\s\S]*?background: transparent;[\s\S]*?border: 0;[\s\S]*?box-shadow: none;/);
  assert.match(styles, /\.cpv2-inline-feedback\.hui-alert::before,[\s\S]*?display: none;/);
});
