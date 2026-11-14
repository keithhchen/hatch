import assert from "node:assert/strict";
import test from "node:test";
import { HELP_ORIGIN, helpPage, injectHelpPage, robotsTxt, sitemapXml } from "../helpSeo.mjs";

const SHELL = '<!doctype html><html lang="en"><head><title>Hatch</title></head><body><div id="root"></div></body></html>';
const MEDIA = "https://oss.example/desktop/web/abc";

test("non-help paths are not handled; an unknown slug is a 404", () => {
  assert.equal(helpPage("/explore"), null);
  assert.equal(helpPage("/helpful"), null);
  assert.equal(helpPage("/help/nope").status, 404);
});

test("the video page carries title, description, canonical, hreflang, Open Graph and a VideoObject", () => {
  const html = injectHelpPage(SHELL, helpPage("/help/interview", "?lang=ja", { mediaBase: MEDIA }));
  assert.match(html, /<html lang="ja-JP"/);
  assert.match(html, /<title>インタビューの進め方 · Hatch<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/gethatchapp\.com\/help\/interview\?lang=ja"/);
  for (const [lang, href] of [["en", "/help/interview"], ["zh-CN", "/help/interview?lang=zh"], ["ja", "/help/interview?lang=ja"], ["x-default", "/help/interview"]]) {
    assert.ok(html.includes(`<link rel="alternate" hreflang="${lang}" href="${HELP_ORIGIN}${href}" />`), lang);
  }
  assert.match(html, /property="og:image" content="https:\/\/gethatchapp\.com\/assets\/web\/interview-poster\.jpg"/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld["@type"], "VideoObject");
  assert.equal(ld.contentUrl, `${MEDIA}/interview-16x9-ja.mp4`);
  assert.equal(ld.thumbnailUrl, "https://gethatchapp.com/assets/web/interview-poster.jpg");
  assert.equal(ld.uploadDate, "2026-11-14");
  assert.equal(ld.duration, "PT1M6S");
  assert.equal(ld.inLanguage, "ja-JP");
  assert.match(html, /<div id="root"><main>.*<h1>インタビューの進め方<\/h1>/);
});

test("the index lists the items as plain links and has no VideoObject; no or unknown lang means English", () => {
  const html = injectHelpPage(SHELL, helpPage("/help", "?lang=xx"));
  assert.match(html, /<title>Help · Hatch<\/title>/);
  assert.match(html, /<html lang="en"/);
  assert.match(html, /<h1>Help<\/h1>.*<a href="\/help\/interview">How the Interview works<\/a>/);
  assert.ok(!html.includes("ld+json"));
});

test("the sitemap lists every Help URL in every language with alternates; robots points at it", () => {
  const xml = sitemapXml();
  for (const path of ["/help", "/help?lang=zh", "/help?lang=ja", "/help/interview", "/help/interview?lang=zh", "/help/interview?lang=ja"]) {
    assert.ok(xml.includes(`<loc>${HELP_ORIGIN}${path}</loc>`), path);
  }
  assert.ok(xml.includes('hreflang="x-default"'));
  assert.match(robotsTxt(), /Sitemap: https:\/\/gethatchapp\.com\/sitemap\.xml/);
});
