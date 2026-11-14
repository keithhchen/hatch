import assert from "node:assert/strict";
import test from "node:test";
import { explainerFor, explainerNodeForRole } from "./nodeExplainers.js";
import { HELP_ITEMS, helpItemForNode, localizeHelpItem } from "../helpCatalog.mjs";

test("explainer is picked by UI locale and falls back to the no-subtitle version", () => {
  assert.equal(explainerFor("interview", "zh").src, "/assets/web/interview-16x9-zh.mp4");
  assert.equal(explainerFor("interview", "ja").src, "/assets/web/interview-16x9-ja.mp4");
  assert.equal(explainerFor("interview", "en").src, "/assets/web/interview-16x9-none.mp4");
  assert.equal(explainerFor("interview", "fr").src, "/assets/web/interview-16x9-none.mp4");
  assert.equal(explainerFor("interview", "en").poster, "/assets/web/interview-poster.jpg");
});

test("videos come from the published media base when one is configured; the poster stays local", () => {
  const found = explainerFor("interview", "zh", "https://oss.example/desktop/web/abc/");
  assert.equal(found.src, "https://oss.example/desktop/web/abc/interview-16x9-zh.mp4");
  assert.equal(found.poster, "/assets/web/interview-poster.jpg");
});

test("nodes without a video have no explainer", () => {
  assert.equal(explainerFor("build", "en"), null);
  assert.equal(explainerNodeForRole("generation"), null);
  assert.equal(explainerNodeForRole("voice"), "interview");
  assert.ok(explainerFor(explainerNodeForRole("voice"), "en"));
});

test("the explainer is the Help catalog's video, not a second copy", () => {
  const item = helpItemForNode("interview");
  assert.deepEqual(explainerFor("interview", "ja"), (({ src, poster, tipLabel }) => ({ src, poster, label: tipLabel }))(localizeHelpItem(item, "ja")));
  assert.ok(HELP_ITEMS.includes(item));
});

test("the entry label is the node's own tips title per locale, English as fallback", () => {
  assert.equal(explainerFor("interview", "zh").label, "访谈小贴士");
  assert.equal(explainerFor("interview", "en").label, "Interview tips");
  assert.equal(explainerFor("interview", "ja").label, "インタビューのコツ");
  assert.equal(explainerFor("interview", "fr").label, "Interview tips");
});
