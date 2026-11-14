import assert from "node:assert/strict";
import test from "node:test";
import { NODE_EXPLAINERS, explainerFor, explainerNodeForRole } from "./nodeExplainers.js";

test("explainer is picked by UI locale and falls back to the no-subtitle version", () => {
  assert.equal(explainerFor("interview", "zh").src, "/assets/web/interview-16x9-zh.mp4");
  assert.equal(explainerFor("interview", "ja").src, "/assets/web/interview-16x9-ja.mp4");
  assert.equal(explainerFor("interview", "en").src, "/assets/web/interview-16x9-none.mp4");
  assert.equal(explainerFor("interview", "fr").src, "/assets/web/interview-16x9-none.mp4");
  assert.equal(explainerFor("interview", "en").poster, "/assets/web/interview-poster.png");
});

test("videos come from the published media base when one is configured; the poster stays local", () => {
  const found = explainerFor("interview", "zh", "https://oss.example/desktop/web/abc/");
  assert.equal(found.src, "https://oss.example/desktop/web/abc/interview-16x9-zh.mp4");
  assert.equal(found.poster, "/assets/web/interview-poster.png");
});

test("nodes without a video have no explainer", () => {
  assert.equal(explainerFor("build", "en"), null);
  assert.equal(explainerNodeForRole("generation"), null);
  assert.equal(explainerNodeForRole("voice"), "interview");
  assert.ok(explainerFor(explainerNodeForRole("voice"), "en"));
});

test("every manifest entry names all three locales and a poster", () => {
  for (const [node, entry] of Object.entries(NODE_EXPLAINERS)) for (const key of ["zh", "en", "ja", "poster"]) assert.ok(entry[key], `${node}.${key}`);
});
