import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Product promise and Brief mutations refresh the current Product revision before CAS writes", () => {
  const source = readFileSync(new URL("./CreatorProductWorkspace.jsx", import.meta.url), "utf8");
  assert.match(source, /async function latestProductForMutation\(token, product\)/);
  assert.match(source, /const currentProduct = await latestProductForMutation\(token, product\);\s*onSaved\(await updateProductPromise/);
  assert.match(source, /const currentProduct = await latestProductForMutation\(token, product\);\s*const saved = await saveProductBriefSpec/);
});

test("Creator Product workspace treats publishing as a durable Complete checkpoint", () => {
  const source = readFileSync(new URL("./CreatorProductWorkspace.jsx", import.meta.url), "utf8");
  assert.match(source, /isProductPublishing\(product\)/);
  assert.match(source, /setInterval\(\(\) => \{ void poll\(\); \}, 3000\)/);
  assert.match(source, /deriveCreatorWorkflow\(\{ run, review, briefSpec, product \}\)/);
  assert.match(source, /product\?\.status === "publishing"/);
  assert.match(source, /GenerationStatus t=\{t\} label=\{t\("versionGenerated"\)\}/);
});
