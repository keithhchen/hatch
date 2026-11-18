import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (name) => readFile(new URL(`./${name}`, import.meta.url), "utf8");

test("Agent page mount: Product is fetched once (by the workspace), config once", async () => {
  const factory = await read("FactoryAgents.jsx");
  const portal = await read("CreatorPortalV2.jsx");
  assert.doesNotMatch(factory, /api\(`\/v1\/creator\/products\/\$\{encodeURIComponent\(productId\)\}`\)/);
  assert.match(portal, /product=\{product\} reloadProduct=\{reloadProduct\}/);
  assert.match(factory, /let opened = false; refreshConfig\(\)/);
  assert.match(factory, /onOpen: \(\) => \{ if \(!opened\) \{ opened = true; return; \} refreshConfig\(\); reloadProduct\?\.\(\); \}/);
});

test("Overview tab does not fetch the Product list", async () => {
  const factory = await read("FactoryAgents.jsx");
  assert.match(factory, /useEffect\(\(\) => \{ if \(!selected\) return; api\("\/v1\/creator\/products"\)/);
});

test("Published Agent rows request no Factory config", async () => {
  const portal = await read("CreatorPortalV2.jsx");
  assert.match(portal, /useAgentPath\(request, published \? null : product\)/);
});
