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
  const states = await run({ upload: async () => "u", submit: async () => job("queued"), get: async () => reads.shift() });
  assert.deepEqual(states.filter(state => state.status !== "uploading"), [{ status: "ingesting" }, { status: "ingesting" }, { status: "completed" }]);
});

test("the server's error is what the Studio shows, from the job or from the request", async () => {
  const failed = await run({ upload: async () => "u", submit: async () => job("failed", { status: "failed", error: "Could not read the PDF" }), get: async () => undefined });
  assert.deepEqual(failed.at(-1), { status: "failed", error: "Could not read the PDF" });
  const rejected = await run({ upload: async () => "u", submit: async () => { throw new Error("Inline files may total at most 30 MB"); }, get: async () => undefined });
  assert.deepEqual(rejected.at(-1), { status: "failed", error: "Inline files may total at most 30 MB" });
});

test("a partly ingested file is not reported as success", () => {
  assert.deepEqual(ingestOutcome(job("done", { status: "partial", error: "No text found" })), { status: "partial", error: "No text found" });
  assert.equal(ingestOutcome(job("done", { status: "ok" })).status, "completed");
});

test("the port asks for an upload slot, puts the raw file with the issued headers, then submits the upload with its facts", async () => {
  const calls = [];
  const bytes = new TextEncoder().encode("ABC");
  const big = { ...file, size: 3, arrayBuffer: async () => bytes.buffer };
  const request = async (route, options) => { calls.push([route, options?.method ?? "GET", options?.body, options?.headers]); return route.endsWith("/uploads") ? { upload_id: "u1", url: "https://oss.test/k", headers: { "content-type": "application/pdf" } } : { job: { id: "j9" } }; };
  const puts = [];
  const port = createIngestPort(request, async (url, f, headers, options) => { puts.push([url, f, headers]); options.onProgress(0.5); });
  const progress = [];
  const item = await port.upload("a b", big, { onProgress: value => progress.push(value) });
  const created = await port.submit("a b", item, "k1");
  await port.get("a b", "j9");
  assert.equal(calls[0][0], "/v1/creator/products/a%20b/ingest/uploads");
  assert.deepEqual(JSON.parse(calls[0][2]), { name: "talk.pdf", bytes: 3, sha256: "b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78", media_type: "application/pdf" });
  assert.deepEqual(puts, [["https://oss.test/k", big, { "content-type": "application/pdf" }]]);
  assert.deepEqual(progress, [0.5]);
  assert.equal(calls[1][0], "/v1/creator/products/a%20b/ingest");
  assert.equal(calls[1][3]["Idempotency-Key"], "k1");
  assert.deepEqual(JSON.parse(calls[1][2]), { items: [{ upload_id: "u1", name: "talk.pdf", bytes: 3, sha256: "b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78", media_type: "application/pdf" }] });
  assert.equal(created.id, "j9");
  assert.deepEqual(calls[2].slice(0, 2), ["/v1/creator/products/a%20b/ingest/j9", "GET"]);
});

test("a failed upload makes no job and says why: timed out, failed (retryable), too large, unsupported", async () => {
  const fail = async error => { const states = []; await ingestFile({ upload: async () => { throw error; }, submit: async () => assert.fail("no job for a failed upload") }, "p1", file, state => states.push(state)); return states.at(-1); };
  assert.deepEqual(await fail(Object.assign(new Error("t"), { code: "upload_timeout" })), { status: "failed", error: "t", code: "upload_timeout" });
  assert.deepEqual(await fail(Object.assign(new Error("n"), { code: "upload_failed" })), { status: "failed", error: "n", code: "upload_failed" });
  assert.deepEqual(await fail(Object.assign(new Error("big"), { status: 413, code: "file_too_large" })), { status: "unsupported" });
  assert.deepEqual(await fail(Object.assign(new Error("type"), { status: 415 })), { status: "failed", code: "unsupported_media_type" });
});

test("upload progress is reported as uploading states before the job settles", async () => {
  const states = [];
  const port = { upload: async (_, __, { onProgress }) => { onProgress(0.25); return "u1"; }, submit: async () => job("done", { status: "ok" }), get: async () => undefined };
  await ingestFile(port, "p1", file, state => states.push(state));
  assert.deepEqual(states, [{ status: "uploading", progress: 0 }, { status: "uploading", progress: 0.25 }, { status: "completed" }]);
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
