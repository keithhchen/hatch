import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCreatorTranslator, CREATOR_LOCALES, CREATOR_PORTAL_KEYS } from "./creatorI18n.js";

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

test("legacy Product, preview, release, and order surfaces have complete locale copy", () => {
  for (const locale of CREATOR_LOCALES) {
    const t = createCreatorTranslator(locale);
    for (const key of CREATOR_PORTAL_KEYS) {
      const raw = t(key);
      const value = typeof raw === "function" ? raw("value") : raw;
      assert.notEqual(value, key, `${locale}.${key}`);
      assert.notEqual(value, undefined, `${locale}.${key} is undefined`);
    }
  }
});

test("Products entry does not read a global Factory run list", async () => {
  const source = await readFile(new URL("./CreatorPortalV2.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/v1\/creator\/factory-runs/);
  assert.doesNotMatch(source, /PendingFactoryRuns|Factory in progress/);
});

test("legacy Portal surfaces do not reintroduce hardcoded English labels", async () => {
  const source = await readFile(new URL("./CreatorPortalV2.jsx", import.meta.url), "utf8");
  for (const phrase of [
    ">Overview<",
    ">Test & improve<",
    ">Representative examples<",
    ">Candidates and releases<",
    ">Storefront preview<",
    ">Release not found<",
    ">No matching orders<"
  ]) assert.doesNotMatch(source, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), phrase);
});

test("Product navigation does not expose retired Factory or task language", async () => {
  const portal = await readFile(new URL("./CreatorPortalV2.jsx", import.meta.url), "utf8");
  const routes = await readFile(new URL("./creatorRoutes.js", import.meta.url), "utf8");
  const messages = await readFile(new URL("./creatorI18n.js", import.meta.url), "utf8");
  assert.doesNotMatch(portal, /\/products\/\$\{encodeURIComponent\(id\)\}\/factory/);
  assert.doesNotMatch(routes, /return route\.runId \? "Factory run" : "Creator Factory"/);
  assert.doesNotMatch(messages, /Define the task brief|Continue in Factory/);
});
