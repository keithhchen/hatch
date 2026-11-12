import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createIngestPort, ingestFile, ingestOutcome } from "./ingestPort.js";
import { FILTER_FROM, groupFiles, neighbour, orderedPaths, splitPath } from "./fileListModel.js";

const job = (status, item = {}) => ({ id: "j1", status, items: [{ id: "i1", status: "pending", ...item }] });
const file = { name: "talk.pdf", type: "application/pdf", lastModified: 1 };
const run = async port => {
  const states = [];
  await ingestFile(port, "p1", file, state => states.push(state), { wait: async () => undefined });
  return states;
};

test("a file is ingested through the job API and settles on the server's word", async () => {
  const reads = [job("running"), job("done", { status: "ok", markdown_path: "input/manual/talk.md" })];
  const states = await run({ submit: async () => job("queued"), get: async () => reads.shift() });
  assert.deepEqual(states, [{ status: "ingesting" }, { status: "ingesting" }, { status: "completed" }]);
});

test("the server's error is what the Studio shows, from the job or from the request", async () => {
  const failed = await run({ submit: async () => job("failed", { status: "failed", error: "Could not read the PDF" }), get: async () => undefined });
  assert.deepEqual(failed, [{ status: "failed", error: "Could not read the PDF" }]);
  const rejected = await run({ submit: async () => { throw new Error("Inline files may total at most 30 MB"); }, get: async () => undefined });
  assert.deepEqual(rejected, [{ status: "failed", error: "Inline files may total at most 30 MB" }]);
});

test("a partly ingested file is not reported as success", () => {
  assert.deepEqual(ingestOutcome(job("done", { status: "partial", error: "No text found" })), { status: "partial", error: "No text found" });
  assert.equal(ingestOutcome(job("done", { status: "ok" })).status, "completed");
});

test("the port posts base64 content to the product's ingest route and reads jobs back", async () => {
  const calls = [];
  const port = createIngestPort(async (route, options) => { calls.push([route, options?.method ?? "GET", options?.body]); return { job: { id: "j9" } }; });
  globalThis.FileReader = class { readAsDataURL() { this.result = "data:application/pdf;base64,QUJD"; this.onload(); } };
  await port.submit("a b", file);
  await port.get("a b", "j9");
  delete globalThis.FileReader;
  assert.equal(calls[0][0], "/v1/creator/products/a%20b/ingest");
  assert.equal(calls[0][1], "POST");
  assert.deepEqual(JSON.parse(calls[0][2]), { items: [{ name: "talk.pdf", content_base64: "QUJD", media_type: "application/pdf" }] });
  assert.deepEqual(calls[1].slice(0, 2), ["/v1/creator/products/a%20b/ingest/j9", "GET"]);
});

test("files group by folder, filter by name, and walk in the order shown", () => {
  const records = ["input/manual/b.md", "input/manual/a.md", "input/notes.md", "output/research/z.md"].map(path => ({ path }));
  assert.deepEqual(splitPath("input/manual/a.md"), { folder: "manual", name: "a.md" });
  assert.deepEqual(groupFiles(records).map(group => [group.folder, group.records.map(record => record.name)]), [["", ["notes.md"]], ["manual", ["a.md", "b.md"]], ["research", ["z.md"]]]);
  assert.deepEqual(groupFiles(records, " B.MD").map(group => group.folder), ["manual"]);
  const paths = orderedPaths(records);
  assert.equal(neighbour(paths, "input/manual/a.md", 1), "input/manual/b.md");
  assert.equal(neighbour(paths, "input/notes.md", -1), undefined);
  assert.ok(FILTER_FROM > 1);
});

test("Upload has no file-type whitelist and no old files path for uploads; long names truncate beside their own actions column", async () => {
  const source = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /accepted\s*=|accept="\.txt/);
  assert.match(source, /ingestFile\(ingest, productId, file/);
  const css = await readFile(new URL("./fileList.css", import.meta.url), "utf8");
  assert.match(css, /\.fl__row \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(css, /\.fl__label \{[^}]*text-overflow: ellipsis/);
});

test("Clicking an uploaded file previews it in place instead of navigating into an Agent", async () => {
  const source = await readFile(new URL("./FactoryAgents.jsx", import.meta.url), "utf8");
  assert.match(source, /onOpen=\{onOpenFile\}/);
  assert.doesNotMatch(source, /onOpen=\{\(\) => onOpenAgent\("research"\)\}/);
  assert.match(source, /<FileViewer key=\{preview\.path\}[\s\S]*?siblings=\{manualFiles\}/);
  assert.match(source, /const researchTransport = async \(\) => agentSession\("research"\) \?\? await api/);
});
