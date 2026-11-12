import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MAX_INGEST_BYTES, tooLarge } from "./ingestPort.js";

test("one 50 MB limit decides which files are refused before any ingest request", () => {
  assert.equal(MAX_INGEST_BYTES, 50 * 1024 * 1024);
  assert.equal(tooLarge({ size: MAX_INGEST_BYTES }), false);
  assert.equal(tooLarge({ size: MAX_INGEST_BYTES + 1 }), true);
});

test("an oversize file becomes an unsupported row and never reaches ingest, from both entry points", async () => {
  const source = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(tooLarge\(file\)\) \{.*status: "unsupported".*return; \}/);
  const gate = source.indexOf("tooLarge(file)");
  assert.ok(gate > 0 && gate < source.indexOf("return ingestFile("));
  assert.equal(source.split("uploadProjectFiles(").length > 1 && source.includes("add: uploadProjectFiles"), true);
});

test("the not-supported label exists in every language", async () => {
  const i18n = await readFile(new URL("./factoryAgentsI18n.js", import.meta.url), "utf8");
  assert.equal(i18n.match(/fileTooLarge: '[^']*50 MB[^']*'/g).length, 3);
});
