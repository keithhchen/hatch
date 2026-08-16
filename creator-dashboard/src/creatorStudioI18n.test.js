import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCreatorTranslator, CREATOR_LOCALES } from "./creatorI18n.js";

const CREATOR_STUDIO_KEYS = [
  "explore",
  "library",
  "studio",
  "products",
  "orders",
  "account",
  "creatorHome",
  "homeBody",
  "permanentAccess",
  "viewAccessRecords",
  "recentActivity",
  "ordersAndAccess",
  "productsPageTitle",
  "productsPageBody",
  "createFirstProduct",
  "createProduct",
  "openProduct",
  "productFiles",
  "uploadFiles",
  "generateVersion",
  "productStatus_preparing",
  "productStatus_needs_attention"
];

test("Creator Studio entry paths have English, Chinese, and Japanese copy", () => {
  for (const locale of CREATOR_LOCALES) {
    const t = createCreatorTranslator(locale);
    for (const key of CREATOR_STUDIO_KEYS) assert.notEqual(t(key), key, `${locale}.${key}`);
  }
});

test("Products entry does not read a global Factory run list", async () => {
  const source = await readFile(new URL("./CreatorPortalV2.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/v1\/creator\/factory-runs/);
  assert.doesNotMatch(source, /PendingFactoryRuns|Factory in progress/);
});
