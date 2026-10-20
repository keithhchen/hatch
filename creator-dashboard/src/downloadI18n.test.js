import assert from "node:assert/strict";
import test from "node:test";
import { downloadCopy, normalizeDownloadLocale } from "./downloadI18n.js";

test("normalizes the three supported download locales", () => {
  assert.equal(normalizeDownloadLocale("zh-CN"), "zh");
  assert.equal(normalizeDownloadLocale("ja-JP"), "ja");
  assert.equal(normalizeDownloadLocale("en-US"), "en");
});

test("provides concise device-aware copy in Chinese, English, and Japanese", () => {
  assert.equal(downloadCopy("en").recommended("Apple Silicon"), "Recommended for this device: Apple Silicon");
  assert.equal(downloadCopy("zh").windows, "Windows · x64");
  assert.equal(downloadCopy("ja").title, "Hatch をパソコンで使う。");
  for (const locale of ["en", "zh", "ja"]) {
    for (const key of ["pill", "lead", "unavailableBody", "webTitle", "webBody", "webAction", "caption"]) assert.ok(downloadCopy(locale)[key], `${locale} needs ${key}`);
  }
});
