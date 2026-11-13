import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MAX_INGEST_BYTES, tooLarge } from "./ingestPort.js";

test("one 50 MB limit decides which files are refused before any ingest request", () => {
  assert.equal(MAX_INGEST_BYTES, 50 * 1024 * 1024);
  assert.equal(tooLarge({ size: MAX_INGEST_BYTES }), false);
  assert.equal(tooLarge({ size: MAX_INGEST_BYTES + 1 }), true);
});

test("an oversize file becomes an unsupported row and never reaches ingest, on the Upload page", async () => {
  const source = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(tooLarge\(file\)\) \{.*status: "unsupported".*return; \}/);
  const gate = source.indexOf("tooLarge(file)");
  assert.ok(gate > 0 && gate < source.indexOf("return ingestFile("));
  assert.match(source, /uploadProjectFiles=\{uploadProjectFiles\}/);
});

test("the not-supported label exists in every language", async () => {
  const i18n = await readFile(new URL("./factoryAgentsI18n.js", import.meta.url), "utf8");
  assert.equal(i18n.match(/fileTooLarge: '[^']*50 MB[^']*'/g).length, 3);
});

test("ingest request bodies are small: files go straight to object storage, never through JSON", async () => {
  const { CREATOR_INGEST_JSON_BODY_MAX_BYTES } = await import("../server.mjs");
  assert.ok(CREATOR_INGEST_JSON_BODY_MAX_BYTES <= 512 * 1024);
});

test("the browser PUT sends the raw file with exactly the issued headers and maps timeout and failure", async () => {
  const { xhrPut } = await import("./ingestPort.js");
  const instances = [];
  globalThis.XMLHttpRequest = class {
    headers = {}; upload = {};
    constructor() { instances.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { this.body = body; }
  };
  try {
    const file = { name: "a.mp4" };
    const progress = [];
    const ok = xhrPut("https://oss.test/k", file, { "content-type": "video/mp4" }, { onProgress: value => progress.push(value) });
    const [put] = instances;
    put.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
    put.status = 200; put.onload();
    await ok;
    assert.deepEqual([put.method, put.url, put.headers, put.body, progress], ["PUT", "https://oss.test/k", { "content-type": "video/mp4" }, file, [0.25]]);
    const slow = xhrPut("/v1/local-objects/k", file, {});
    instances[1].ontimeout();
    await assert.rejects(slow, { code: "upload_timeout" });
    const broken = xhrPut("/v1/local-objects/k", file, {});
    instances[2].status = 403; instances[2].onload();
    await assert.rejects(broken, { code: "upload_failed", message: /403/ });
    const offline = xhrPut("/v1/local-objects/k", file, {});
    instances[3].onerror();
    await assert.rejects(offline, { code: "upload_failed" });
  } finally { delete globalThis.XMLHttpRequest; }
});
