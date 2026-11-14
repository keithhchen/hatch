import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const localeSource = await readFile(new URL("./locale.jsx", import.meta.url), "utf8");
const coreSource = await readFile(new URL("../localeCore.mjs", import.meta.url), "utf8");
const landingSource = await readFile(new URL("./web/HatchPage.tsx", import.meta.url), "utf8");
const creatorSource = await readFile(new URL("./CreatorPortalV2.jsx", import.meta.url), "utf8");

test("one persisted locale context controls the document language", () => {
  assert.match(localeSource, /hatch\.locale/);
  assert.match(localeSource, /localStorage\.setItem\(LOCALE_STORAGE_KEY, next\)/);
  assert.match(localeSource, /document\.documentElement\.lang = documentLanguage\(locale\)/);
  assert.match(coreSource, /export const LOCALES = \["en", "zh", "ja"\]/);
  assert.match(localeSource, /const saved = normalizeLocale/);
  assert.match(localeSource, /return pickLocale\(candidates\)/);
  assert.match(coreSource, /for \(const candidate of candidates \?\? \[\]\)/);
  assert.match(coreSource, /return "en";/);
});

test("Landing and Creator Studio consume the shared locale", () => {
  assert.match(landingSource, /useLocale\(\)/);
  assert.match(creatorSource, /useLocale\(\)/);
  assert.doesNotMatch(landingSource, /useState<Lang>/);
  assert.doesNotMatch(creatorSource, /detectCreatorLocale/);
  assert.match(creatorSource, /\[\['en', t\("english"\)\], \['zh', t\("chinese"\)\], \['ja', t\("japanese"\)\]\]/);
});
