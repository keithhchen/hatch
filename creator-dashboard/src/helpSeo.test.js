import assert from "node:assert/strict";
import test from "node:test";
import { HELP_ORIGIN, helpPage, injectHelpPage, robotsTxt, sitemapXml } from "../helpSeo.mjs";

const SHELL = '<!doctype html><html lang="en"><head><title>Hatch</title></head><body><div id="root"></div></body></html>';
const MEDIA = "https://oss.example/desktop/web/abc";

const langOf = header => helpPage("/help", header).lang;

test("Accept-Language picks zh, ja or en by quality, through the shared locale rules, and defaults to en", () => {
  assert.equal(langOf("zh-CN,zh;q=0.9,en;q=0.8"), "zh");
  assert.equal(langOf("ja-JP"), "ja");
  assert.equal(langOf("fr, en;q=0.5, ja;q=0.9"), "ja");
  assert.equal(langOf("ja;q=0, en"), "en");
  assert.equal(langOf("fr-FR"), "en");
  assert.equal(langOf(undefined), "en");
});

test("non-help paths are not handled; an unknown slug is a 404", () => {
  assert.equal(helpPage("/explore"), null);
  assert.equal(helpPage("/helpful"), null);
  assert.equal(helpPage("/help/nope").status, 404);
});

test("the video page has one canonical URL, no hreflang, and a VideoObject in the requested language", () => {
  const html = injectHelpPage(SHELL, helpPage("/help/interview", "ja-JP", { mediaBase: MEDIA }));
  assert.match(html, /<html lang="ja-JP"/);
  assert.match(html, /<title>インタビューの進め方 · Hatch<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/gethatchapp\.com\/help\/interview" \/>/);
  assert.ok(!html.includes("hreflang"));
  assert.match(html, /property="og:image" content="https:\/\/gethatchapp\.com\/assets\/web\/interview-poster\.jpg"/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld["@type"], "VideoObject");
  assert.equal(ld.contentUrl, `${MEDIA}/interview-16x9-ja.mp4`);
  assert.equal(ld.embedUrl, "https://gethatchapp.com/help/interview");
  assert.equal(ld.uploadDate, "2026-11-14");
  assert.equal(ld.duration, "PT1M6S");
  assert.equal(ld.inLanguage, "en");
  assert.ok(ld.description.endsWith("（日本語字幕付き）"));
  assert.match(html, /<div id="root"><main>.*<h1>インタビューの進め方<\/h1>/);
});

test("the index lists the items as plain links and has no VideoObject; the default language is English", () => {
  const html = injectHelpPage(SHELL, helpPage("/help"));
  assert.match(html, /<title>Help · Hatch<\/title>/);
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<h1>Help<\/h1>.*<a href="\/help\/interview">How the Interview works<\/a>/);
  assert.ok(!html.includes("ld+json"));
});

test("the sitemap has one entry per page and no alternates; robots points at it", () => {
  const xml = sitemapXml();
  for (const path of ["/help", "/help/interview"]) assert.ok(xml.includes(`<loc>${HELP_ORIGIN}${path}</loc>`), path);
  assert.ok(!xml.includes("lang=") && !xml.includes("hreflang"));
  assert.match(robotsTxt(), /Sitemap: https:\/\/gethatchapp\.com\/sitemap\.xml/);
});
