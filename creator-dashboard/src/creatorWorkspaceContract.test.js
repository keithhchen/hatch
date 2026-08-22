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

test("About You does not keep showing a Corpus-loading message after handoff is complete", async () => {
  const source = await readFile(new URL("./CreatorProductWorkspace.jsx", import.meta.url), "utf8");
  assert.match(source, /corpusFinished/);
  assert.match(source, /answersSaved/);
  assert.match(source, /NodeHandoffPanel/);
  assert.doesNotMatch(source, /execution=\{\.\.\.execution, status: "completed"\}/);
});

test("live node loading stays quiet and uses the shared moving gradient", async () => {
  const source = await readFile(new URL("./CreatorProductWorkspace.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("./creatorProductWorkspace.css", import.meta.url), "utf8");
  for (const copy of ["Hatch 线索伙伴", "现在发生什么", "正在寻找反复出现的判断", "Hatch 正在处理……", "正在工作", "把材料里的线索聚在一起，先认识你的方法。"])
    assert.doesNotMatch(`${source}\n${styles}`, new RegExp(copy));
  assert.match(source, /cpv2-node-gradient/);
  assert.match(styles, /animation: hui-skeleton/);
  assert.doesNotMatch(styles, /cpv2-companion-bounce|cpv2-companion-blink/);
});
