import assert from "node:assert/strict";
import test from "node:test";
import { latestFormLink, linkKind } from "../src/domain/form-pages.js";

const ORIGIN = "http://localhost:5173";

test("links classify as form page, Hatch page or other", () => {
  assert.equal(linkKind("https://gethatchapp.com/f/form_ab12?t=tok", ORIGIN), "form");
  assert.equal(linkKind("https://app.gethatchapp.com/f/form_ab12", ORIGIN), "form");
  assert.equal(linkKind("http://localhost:5173/f/form_ab12?t=x", ORIGIN), "form");
  assert.equal(linkKind("https://gethatchapp.com/studio", ORIGIN), "hatch");
  assert.equal(linkKind("/studio", ORIGIN), "hatch");
  assert.equal(linkKind("https://example.com/f/form_ab12", ORIGIN), "other");
  assert.equal(linkKind("https://gethatchapp.com.evil.com/f/form_ab12", ORIGIN), "other");
  assert.equal(linkKind("https://gethatchapp.com/f/other_ab12", ORIGIN), "hatch");
  assert.equal(linkKind("javascript:alert(1)", ORIGIN), "other");
  assert.equal(linkKind("mailto:a@gethatchapp.com", ORIGIN), "other");
});

test("block content from the workbench counts too", () => {
  const url = "https://gethatchapp.com/f/form_ab12";
  assert.equal(latestFormLink([{ role: "assistant", content: [{ type: "toolCall" }, { type: "text", text: `open ${url}` }] }], ORIGIN).url, url);
});

test("only the latest message can open a form page", () => {
  const form = "https://gethatchapp.com/f/form_ab12?t=tok";
  const withForm = { role: "assistant", run_id: "r1", content: `Fill in [this form](${form}).` };
  const plain = { role: "assistant", run_id: "r2", content: "Thanks" };
  assert.equal(latestFormLink([withForm], ORIGIN).url, form);
  assert.equal(latestFormLink([withForm, plain], ORIGIN), null);
  assert.equal(latestFormLink([], ORIGIN), null);
  const streaming = { role: "assistant", transient: true, timeline: [{ kind: "text", content: `see ${form}` }] };
  assert.equal(latestFormLink([plain, streaming], ORIGIN).url, form);
  assert.notEqual(latestFormLink([withForm], ORIGIN).key, latestFormLink([{ ...withForm, run_id: "r3" }], ORIGIN).key);
});
