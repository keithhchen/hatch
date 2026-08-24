import assert from "node:assert/strict";
import test from "node:test";
import { dashboardRequest, formatMoney } from "./data.js";
import {
  WEB_LOCALES,
  detectWebLocale,
  formatUsd,
  localizeWebApiError,
  localeTag,
  setWebLocale,
  translateWeb
} from "./webI18n.js";

test("Web locale detection uses one supported locale contract and preserves priority", () => {
  assert.deepEqual(WEB_LOCALES, ["en", "zh", "ja"]);
  assert.equal(detectWebLocale(["en-US", "zh-CN"]), "en");
  assert.equal(detectWebLocale(["fr-FR", "ja-JP"]), "ja");
  assert.equal(localeTag("zh"), "zh-CN");
  assert.equal(localeTag("ja"), "ja-JP");
});

test("Web amounts always use the USD display format", () => {
  assert.equal(formatUsd(3510), "$35.10");
  assert.equal(formatMoney(390, "JPY"), "$3.90");
});

test("API errors use the same locale catalog as Web display", () => {
  const localized = localizeWebApiError({ error: { code: "product_not_found", message: "Product was not found." } }, "zh");
  assert.equal(localized.error.message, translateWeb("zh", "errors.productNotFound"));
  assert.equal(localized.error.code, "product_not_found");
});

test("dashboard requests send the selected Web locale to the API", async () => {
  const previousFetch = globalThis.fetch;
  setWebLocale("ja");
  let captured;
  globalThis.fetch = async (_path, options) => {
    captured = options;
    return { status: 200, ok: true, json: async () => ({ ok: true }) };
  };
  try {
    await dashboardRequest("/v1/health");
  } finally {
    globalThis.fetch = previousFetch;
    setWebLocale("en");
  }
  assert.equal(captured.headers["x-hatch-locale"], "ja");
  assert.equal(captured.headers["accept-language"], "ja-JP");
});
