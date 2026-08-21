import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Creator Product workspace follows Files → About You → Corpus → Brief → Complete", async () => {
  const source = await readFile(new URL("./CreatorProductWorkspace.jsx", import.meta.url), "utf8");
  assert.match(source, /getLatestNodeExecution/);
  assert.match(source, /startAboutYouNode/);
  assert.match(source, /startCorpusNode/);
  assert.match(source, /publishCorpusToRegistry/);
  assert.doesNotMatch(source, /getFactoryReview|submitFactoryReview/);
});

test("Node failures use the existing inline error bar and Retry action", async () => {
  const source = await readFile(new URL("./CreatorProductWorkspace.jsx", import.meta.url), "utf8");
  assert.match(source, /InlineAlert tone="error"/);
  assert.match(source, /retryFailedNode/);
  assert.match(source, /executionError/);
});
