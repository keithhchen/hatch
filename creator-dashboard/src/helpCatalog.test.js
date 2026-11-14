import assert from "node:assert/strict";
import test from "node:test";
import { HELP_ITEMS, HELP_KINDS, HELP_LOCALES, HELP_PAGE_COPY, helpGroups, helpItem, helpItemForNode, helpPath, localizeHelpItem } from "../helpCatalog.mjs";
import { parseHelpRoute } from "./helpRoute.js";

test("every item has text in every locale and a video in every locale plus a poster", () => {
  for (const item of HELP_ITEMS) {
    assert.ok(HELP_KINDS.includes(item.kind), item.id);
    for (const locale of HELP_LOCALES) {
      assert.ok(item.copy[locale]?.title && item.copy[locale]?.description, `${item.id}.${locale}`);
      if (item.kind === "video") assert.ok(item.video[locale], `${item.id}.video.${locale}`);
    }
    if (item.kind === "video") assert.ok(item.poster && item.duration && item.published, item.id);
  }
  for (const locale of HELP_LOCALES) assert.ok(HELP_PAGE_COPY[locale].index);
});

test("a locale picks its own text and video; an unknown locale falls back to English text and the no-subtitle video", () => {
  const item = helpItem("interview");
  assert.equal(localizeHelpItem(item, "zh").title, "访谈是怎么进行的");
  assert.equal(localizeHelpItem(item, "zh").src, "/assets/web/interview-16x9-zh.mp4");
  assert.equal(localizeHelpItem(item, "ja").src, "/assets/web/interview-16x9-ja.mp4");
  const fallback = localizeHelpItem(item, "fr");
  assert.equal(fallback.title, "How the Interview works");
  assert.equal(fallback.src, "/assets/web/interview-16x9-none.mp4");
});

test("videos use the media base when given; the poster is always local", () => {
  const v = localizeHelpItem(helpItem("interview"), "en", "https://oss.example/web/abc/");
  assert.equal(v.src, "https://oss.example/web/abc/interview-16x9-none.mp4");
  assert.equal(v.poster, "/assets/web/interview-poster.jpg");
});

test("lookup by id and by node; unknown ids are null", () => {
  assert.equal(helpItem("interview").id, "interview");
  assert.equal(helpItem("nope"), null);
  assert.equal(helpItemForNode("interview").id, "interview");
  assert.equal(helpItemForNode("build"), null);
});

test("groups follow kind order and omit empty kinds", () => {
  const groups = helpGroups("en");
  assert.deepEqual(groups.map(group => group.kind), ["video"]);
  assert.equal(groups[0].items[0].id, "interview");
  const withArticle = [...HELP_ITEMS, { id: "a", kind: "article", copy: { en: { title: "A", description: "d" } } }];
  assert.deepEqual(helpGroups("ja", undefined, withArticle).map(group => group.kind), ["video", "article"]);
});

test("paths: English is bare, other languages use ?lang=", () => {
  assert.equal(helpPath(null), "/help");
  assert.equal(helpPath(null, "en"), "/help");
  assert.equal(helpPath(helpItem("interview"), "zh"), "/help/interview?lang=zh");
});

test("route parsing", () => {
  assert.deepEqual(parseHelpRoute("/help"), { slug: null });
  assert.deepEqual(parseHelpRoute("/help/interview"), { slug: "interview" });
  assert.equal(parseHelpRoute("/helpful"), null);
  assert.equal(parseHelpRoute("/help/a/b"), null);
});
