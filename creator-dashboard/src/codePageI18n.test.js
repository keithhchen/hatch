import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { codePageCopy, codePageErrorText, codePageT } from "./codePageI18n.js";

test("the code pages have the same keys in zh, en and ja", () => {
  const keys = Object.keys(codePageCopy.zh).sort();
  assert.deepEqual(Object.keys(codePageCopy.en).sort(), keys);
  assert.deepEqual(Object.keys(codePageCopy.ja).sort(), keys);
  for (const locale of ["en", "ja"]) for (const key of keys) assert.ok(codePageCopy[locale][key].trim(), `${locale}.${key}`);
});

test("every placeholder of the zh copy is in its en and ja copy", () => {
  const holes = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, text] of Object.entries(codePageCopy.zh)) for (const locale of ["en", "ja"]) assert.deepEqual(holes(codePageCopy[locale][key]), holes(text), `${locale}.${key}`);
});

test("copy is interpolated, and English and Japanese carry no Chinese-only wording", () => {
  assert.equal(codePageT("en", "missingField", { field: "Name" }), "Please fill in: Name");
  assert.equal(codePageT("zh", "codeNotFound", { label: "活动码" }), "活动码不存在");
  assert.equal(codePageT("en", "waitMinutes", { minutes: 7, dest: codePageT("en", "sentTo", { email: "a@b.co" }) }), "You can close this page. Your report will arrive at a@b.co in about 7 min.");
  for (const [key, text] of Object.entries(codePageCopy.en)) assert.doesNotMatch(text, /[一-龥]/, `en.${key}`);
});

test("a failed request reads as its error code in the page's language, never the server's message", () => {
  const notFound = { code: "access_code_not_found", message: "兑换码不存在" };
  assert.equal(codePageErrorText(notFound, "en"), "This access code doesn't exist");
  assert.equal(codePageErrorText(notFound, "ja"), "この引き換えコードは存在しません");
  assert.equal(codePageErrorText({ code: "access_codes_unavailable", message: "x" }, "zh"), "兑换码服务暂不可用");
  assert.equal(codePageErrorText({ code: "brief_unavailable", message: "This Product has no Brief." }, "en"), "We can't start the diagnosis right now. Please try again later.");
  assert.equal(codePageErrorText({ code: "not_paid" }, "en"), "This access code hasn't been paid for yet");
  assert.equal(codePageErrorText({ message: "Request failed with 500" }, "en", "submitFailed"), "Couldn't submit. Please try again.");
  assert.equal(codePageErrorText(new Error("boom"), "ja"), codePageCopy.ja.unreachable);
});

test("the code pages read the shared locale, show the switcher, and send the locale with intake and issue", async () => {
  const page = await readFile(new URL("./CodePage.jsx", import.meta.url), "utf8");
  assert.match(page, /useLocale\(\)/);
  assert.match(page, /<LanguageSwitcher \/>/);
  assert.match(page, /intakeAnswers\(status\.fields, answers\), locale/);
  assert.match(page, /JSON\.stringify\(\{ locale \}\)/);
  assert.doesNotMatch(page, /cause\?\.message|error\?\.message/, "the server's own message is never shown");
  assert.doesNotMatch(page.replace(/\/\*\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /[一-龥]/, "no hard-coded Chinese in the page");
});
