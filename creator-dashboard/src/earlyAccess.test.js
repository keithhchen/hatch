import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EarlyAccessClient, isEarlyAccess, studioNavItems } from "./earlyAccess.js";
import { createCreatorTranslator } from "./creatorI18n.js";

const read = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const items = [{ section: "assistant" }, { section: "home" }, { section: "settings" }];

test("early access is off unless the profile says true", () => {
  assert.equal(isEarlyAccess(undefined), false);
  assert.equal(isEarlyAccess({ early_access: false }), false);
  assert.equal(isEarlyAccess({ early_access: true }), true);
});

test("the Assistant nav entry shows only with early access", () => {
  assert.deepEqual(studioNavItems(items, false).map((item) => item.section), ["home", "settings"]);
  assert.equal(studioNavItems(items, true).length, 3);
});

test("saving PATCHes the account and returns the stored value; failures surface", async () => {
  const calls = [];
  const client = new EarlyAccessClient(async (path, options) => { calls.push([path, options]); return { early_access: true }; });
  assert.equal(await client.set(true), true);
  assert.deepEqual(calls, [["/v1/auth/me", { method: "PATCH", body: JSON.stringify({ early_access: true }) }]]);
  await assert.rejects(new EarlyAccessClient(async () => { throw new Error("nope"); }).set(true), /nope/);
});

test("the Assistant route redirects to /studio when off; messaging apps are hidden when off", () => {
  const portal = read("CreatorPortalV2.jsx");
  assert.match(portal, /route\.kind === "assistant"\) return isEarlyAccess\(profile\) \? lazy\(<StudioAssistant[^;]*: <Redirect to=\{ROOT\}/);
  assert.match(portal, /navItems = studioNavItems\(NAV_ITEMS, earlyAccess\)/);
  const settings = read("SettingsPage.jsx");
  assert.match(settings, /\{earlyAccess \? <section[\s\S]*?<ChannelBindings[\s\S]*?<\/section> : null\}/);
  assert.match(settings, /onProfileChange\(\{ \.\.\.profile, early_access: !enabled \}\);\s*setError\(friendlyError/);
  assert.match(read("main.jsx"), /onProfileChange=\{setProfile\}/);
});

test("Early access label exists in every locale", () => {
  assert.deepEqual(["en", "zh", "ja"].map((locale) => createCreatorTranslator(locale)("sxEarlyAccess")), ["Early Access", "抢先体验", "先行アクセス"]);
});
