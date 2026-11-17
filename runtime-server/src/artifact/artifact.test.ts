import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingAnalytics } from "../analytics/recording.js";
import { FlatAttachmentFiles, flatEntries } from "../assets/flatFiles.js";
import { harness, png, scopeA } from "../assets/kit.test.js";
import { PdfParsePageRenderer, type PdfPageRenderer } from "../assets/pdfPages.js";
import { attachmentTools } from "../assets/tools.js";
import { attachmentToolDefinitions } from "../chat/attachmentTools.js";
import { ServerToolExecutor } from "../serverTools.js";
import { toolRegistry } from "../tools.js";
import { InMemoryArtifactConfigRepository, InvalidArtifactConfig } from "./config.js";
import { validateReportHtml } from "./html.js";
import { ArtifactMode } from "./mode.js";
import type { ReportRenderer } from "./ports.js";
import { InMemoryReportRepository } from "./repositories.js";
import { handleReportRequest } from "./routes.js";
import { artifactToolDefinitions } from "./toolDefinitions.js";
import type { ConversationRecord } from "../conversationRepository.js";
import type http from "node:http";

const doc = (body: string, head = "<style>p{color:#111}</style>") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const good = doc(`<h1>Cover</h1><p>report text</p>`);

test("a good document has no errors; every way a document breaks the contract is reported at once", () => {
  assert.deepEqual(validateReportHtml(good), []);
  assert.deepEqual(validateReportHtml(doc(`<p>loose</p>`)), [], "sections are not required any more");
  const errors = (html: string): string => { const r = validateReportHtml(html); assert.ok(r.length); return r.join("\n"); };
  assert.match(errors(good.replace("</body>", "<script>1</script></body>")), /<script> is not allowed/);
  assert.match(errors(good.replace("<p>report text", '<img src="https://x/y.png"><p>report text')), /must not load anything external/);
  assert.match(errors(good.replace("p{color:#111}", "@import url(https://x/f.css);")), /self-contained/);
  assert.match(errors(good.replace("<!doctype html>", "")), /doctype/);
  assert.match(errors(good.replace(/<style>.*<\/style>/, "")), /inline <style>/);
  assert.match(errors(" "), /empty/);
  assert.match(errors(good + "x".repeat(2 * 1024 * 1024)), /larger than 2 MB/);
});

test("a bad artifact config row is an error, not an absence", async () => {
  const configs = new InMemoryArtifactConfigRepository();
  const intake = { fields: [{ id: "grade", label: "Grade?", type: "choice", options: ["a", "b"], required: true }] };
  configs.set("p1", intake, "# template").set("bad1", { fields: [{ id: "Bad Id", label: "x", type: "text" }] }, "t").set("bad2", { fields: [{ id: "c", label: "x", type: "choice" }] }, "t").set("bad3", intake, " ");
  assert.equal((await configs.get("p1"))?.reportTemplate, "# template");
  assert.equal(await configs.get("missing"), undefined);
  for (const id of ["bad1", "bad2", "bad3"]) await assert.rejects(configs.get(id), InvalidArtifactConfig);
});

const conversation = (id = "c1", owner = "acct-1"): ConversationRecord => ({ id, ownerAccountId: owner, productId: "p1", creatorId: "creator" } as ConversationRecord);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("PNGDATA")]);
const renderer = (): ReportRenderer & { calls: number; pages: number; fail?: string } => ({
  calls: 0,
  pages: 1,
  async render(html) {
    this.calls++;
    if (this.fail) throw new Error(this.fail);
    return { pdf: Buffer.from(`%PDF-${html.includes("SUMMARY") ? "SUMMARY" : "FULL"}PDF`), pages: this.pages, firstPagePng: PNG };
  }
});

async function mode() {
  const kit = await harness();
  const reports = new InMemoryReportRepository();
  const analytics = new RecordingAnalytics();
  const configs = new InMemoryArtifactConfigRepository().set("p1", { fields: [{ id: "a", label: "A", type: "text" }] }, "TEMPLATE-TEXT");
  const r = renderer();
  let ids = 0;
  const clock = { now: new Date("2026-01-01T00:00:00Z") };
  const artifact = new ArtifactMode({ configs, reports, renderer: r, blobs: kit.blobs, assets: { uploadedCount: async () => uploads.n }, analytics, maxFiles: 2, clock: () => clock.now,
    publishing: { pausesMs: [0, 0], sleep: async () => undefined, id: () => `pub${++ids}`, clock: () => clock.now } });
  const uploads = { n: 0 };
  return { ...kit, reports, analytics, artifact, r, uploads, clock };
}

/** The agent's way: write the phase's file, then publish it by path. */
async function publishFile(turn: { tools: { run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> } }, html: string, path = "/report/report.html") {
  await turn.tools.run("write", { path, content: html });
  return turn.tools.run("publish_report", { path });
}
const summaryHtml = doc("<h1>SUMMARY</h1>");
const fullHtml = doc("<h1>Report</h1><p>FULLTEXT</p>");

test("draft files work like a coding agent's: write, edit exactly once, read, list; bad paths and edits are told back", async () => {
  const { reports, artifact } = await mode();
  const c = conversation();
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  const turn = (await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!;
  assert.ok(turn.extraTools.includes("artifact.write") && turn.extraTools.includes("artifact.edit"));
  const run = (name: string, args: Record<string, unknown>) => turn.tools.run(name, args).then((r) => String(r.output));
  assert.match(await run("write", { path: "/report/report.html", content: "<h1>A</h1><!-- ch2 --><!-- ch3 -->" }), /Wrote \/report\/report.html/);
  assert.match(await run("edit", { path: "/report/report.html", old_string: "<!-- ch2 -->", new_string: "<p>two</p>" }), /Edited/);
  assert.equal(await run("read", { path: "/report/report.html" }), "<h1>A</h1><p>two</p><!-- ch3 -->");
  assert.match(await run("ls", { path: "/report/" }), /\/report\/report.html  \d+ bytes/);
  await assert.rejects(run("edit", { path: "/report/report.html", old_string: "<!-- ch2 -->", new_string: "x" }), /not found/);
  await assert.rejects(run("write", { path: "/etc/passwd", content: "x" }), /files under \/report\//);
  await assert.rejects(run("write", { path: "/report/../x", content: "x" }), /files under/);
  await assert.rejects(run("read", { path: "/report/none.html" }), /does not exist/);
  const again = (await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!;
  assert.equal(String((await again.tools.run("read", { path: "/report/report.html" })).output), "<h1>A</h1><p>two</p><!-- ch3 -->", "a retry finds the draft");
});

test("lifecycle: draft, generating, summary ready; failed renders and bad documents leave it generating", async () => {
  const { reports, artifact, analytics, r } = await mode();
  const c = conversation();
  assert.equal(await artifact.turnFor(c, { createdAt: new Date().toISOString() }), undefined, "no report row: a chat conversation");
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  assert.deepEqual([(await reports.get(c.id))?.status, (await reports.get(c.id))?.phase], ["draft", "summary"]);
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  assert.equal((await reports.get(c.id))?.status, "generating");

  const turn = (await artifact.turnFor(c, { createdAt: new Date(Date.now() - 5000).toISOString() }))!;
  assert.deepEqual(turn.extraTools, ["artifact.publish_report", "artifact.write", "artifact.edit"]);
  assert.match(turn.promptSuffix, /TEMPLATE-TEXT/);
  assert.match(turn.promptSuffix, /the executive summary page only/, "the summary phase's instructions");
  assert.doesNotMatch(turn.promptSuffix, /# This Run: the full report/);

  const bad = await publishFile(turn, "<p>x</p>", "/report/summary.html");
  assert.match(String(bad.output), /^Not published/);
  r.fail = "boom";
  await assert.rejects(publishFile(turn, summaryHtml, "/report/summary.html"), /Rendering the report failed: boom/);
  assert.equal(r.calls, 3, "a failing rendering is tried again twice inside the tool");
  assert.equal((await reports.get(c.id))?.status, "generating");

  r.fail = undefined;
  assert.deepEqual(await publishFile(turn, summaryHtml, "/report/summary.html"), { output: "Report published." });
  const ready = (await reports.get(c.id))!;
  assert.deepEqual([ready.status, ready.phase], ["ready", "summary"]);
  assert.deepEqual(Object.keys(ready.keys!).sort(), ["summaryHtml", "summaryPdf", "summaryPng"]);
  assert.ok(ready.keys!.summaryPdf!.endsWith("/report/pub1/summary.pdf"));
  assert.equal((await artifact.blobs.get(ready.keys!.summaryPdf!)).toString(), "%PDF-SUMMARYPDF");
  assert.deepEqual(await artifact.blobs.get(ready.keys!.summaryPng!), PNG);
  assert.equal(analytics.captured.find((e) => e.event === "report_ready")?.props.duration_s, 5);

  await artifact.lifecycle.runEnded({ id: "run-1" }, { status: "completed", reply: {} as never });
  assert.equal((await reports.get(c.id))?.status, "ready", "a ready report stays ready");
});

test("the summary must print on exactly one page: more is refused with text and publishes nothing", async () => {
  const { reports, artifact, r } = await mode();
  const c = conversation();
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  const turn = (await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!;
  r.pages = 2;
  assert.deepEqual(await publishFile(turn, summaryHtml, "/report/summary.html"), { output: "Not published: the summary runs over one page (2 pages); shorten it and publish again." });
  assert.equal((await reports.get(c.id))?.status, "generating");
  assert.equal((await reports.get(c.id))?.keys, undefined);
  r.pages = 1;
  assert.deepEqual(await publishFile(turn, summaryHtml, "/report/summary.html"), { output: "Report published." });
});

test("unlock is one conditional write from (summary, ready) to (full, generating, attempt 1) and starts one Run; again changes nothing", async () => {
  const { reports, artifact, clock } = await mode();
  const c = conversation();
  const started: Array<[string, string]> = [];
  artifact.startFullRun = async (record, runId) => { started.push([record.conversationId, runId]); };
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  await assert.rejects(artifact.unlock(c.id), /not ready/, "draft");
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  await assert.rejects(artifact.unlock(c.id), /not ready/, "the summary still generating");
  const summary = (await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!;
  await publishFile(summary, summaryHtml, "/report/summary.html");
  const summaryKeys = (await reports.get(c.id))!.keys;

  const [a, b] = await Promise.all([artifact.unlock(c.id), artifact.unlock(c.id)]);
  assert.equal(started.length, 1, "two callers start one Run");
  assert.deepEqual([a.phase, b.phase], ["full", "full"]);
  const record = (await reports.get(c.id))!;
  assert.deepEqual([record.phase, record.status, record.stage, record.attempt, record.runId, record.unlockedAt, record.keys], ["full", "generating", "queued", 1, started[0]![1], clock.now.toISOString(), summaryKeys]);
  assert.equal((await artifact.unlock(c.id)).runId, record.runId, "unlocking again starts nothing");
  assert.equal(started.length, 1);

  await artifact.lifecycle.assertAcceptsMessage(c, started[0]![1]);
  await artifact.lifecycle.runAccepted(c, { id: started[0]![1] } as never);
  const full = (await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!;
  assert.match(full.promptSuffix, /# This Run: the full report/);
  assert.deepEqual(await publishFile(full, fullHtml), { output: "Report published." });
  const done = (await reports.get(c.id))!;
  assert.deepEqual([done.status, done.phase], ["ready", "full"]);
  assert.deepEqual(Object.keys(done.keys!).sort(), ["fullHtml", "fullPdf", "summaryHtml", "summaryPdf", "summaryPng"], "the summary files stay");
  assert.equal((await artifact.blobs.get(done.keys!.fullPdf!)).toString(), "%PDF-FULLPDF");
  assert.equal(await reports.ready(c.id, 1, "summary", { summaryPdf: "late" }, clock.now), undefined, "a late summary publish cannot touch the full phase");
});

test("a failed start of the full Run is retried like any Run that did not start", async () => {
  const { reports, artifact } = await mode();
  const c = conversation();
  artifact.startFullRun = async () => { throw new Error("no capacity"); };
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  await publishFile((await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!, summaryHtml, "/report/summary.html");
  const record = await artifact.unlock(c.id);
  assert.deepEqual([record.phase, record.status, Boolean(record.retryAt)], ["full", "generating", true]);
});

test("web_search is offered only when search is configured, and asks it with query and objective", async () => {
  const { artifact, reports } = await mode();
  const c = conversation();
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  const run = { createdAt: new Date().toISOString() };
  assert.deepEqual((await artifact.turnFor(c, run))!.extraTools, ["artifact.publish_report", "artifact.write", "artifact.edit"]);
  const asked: unknown[] = [];
  const search = { name: "fake", search: async (input: { query: string; objective: string }) => { asked.push(input); return { provider: "fake", query: input.query, retrievedAt: "t", results: [] }; } };
  const withSearch = new ArtifactMode({ ...artifact.deps, search });
  const turn = (await withSearch.turnFor(c, run))!;
  assert.deepEqual(turn.extraTools, ["artifact.publish_report", "artifact.write", "artifact.edit", "artifact.web_search"]);
  assert.match(String((await turn.tools.run("web_search", { query: "MIT deadline", objective: "official date" })).output), /"provider":"fake"/);
  assert.deepEqual(asked, [{ query: "MIT deadline", objective: "official date" }]);
  await assert.rejects(turn.tools.run("web_search", { query: "x" }), /query and objective/);
});

test("the upload cap applies to report conversations only", async () => {
  const { artifact, reports, uploads } = await mode();
  const c = conversation();
  uploads.n = 5;
  assert.equal(await artifact.assertCanUpload(c), false, "chat conversation: no cap here");
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  uploads.n = 1;
  assert.equal(await artifact.assertCanUpload(c), true);
  uploads.n = 2;
  await assert.rejects(artifact.assertCanUpload(c), /at most 2 files/);
});

test("a report conversation takes only its form and stays out of the chat list; chat conversations are untouched", async () => {
  const { artifact, reports } = await mode();
  const chat = { ...conversation(), id: "chat-1" };
  const report = { ...conversation(), id: "report-1" };
  await artifact.lifecycle.assertAcceptsMessage(chat, "run-x");
  await reports.create({ conversationId: report.id, productId: "p1", ownerAccountId: report.ownerAccountId });
  await artifact.lifecycle.assertAcceptsMessage(report, "run-1");
  await artifact.lifecycle.runAccepted(report, { id: "run-1" } as never);
  await artifact.lifecycle.assertAcceptsMessage(report, "run-1"); // the claimed Run itself
  await assert.rejects(artifact.lifecycle.assertAcceptsMessage(report, "run-2"), /takes no further messages/);
  assert.deepEqual((await artifact.withoutReports([chat, report])).map(c => c.id), ["chat-1"]);
  assert.deepEqual(await artifact.withoutReports([]), []);
});

function fakeResponse() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) { out.status = status; out.headers = { ...out.headers, ...headers }; return res; },
    end(body?: Buffer | string) { out.body = Buffer.from(body ?? ""); }
  };
  return { res: res as unknown as http.ServerResponse, out };
}

test("files are served per phase: summary files once the summary is ready, full files once the full phase is ready; unlock needs POST and an allowed origin", async () => {
  const { reports, artifact } = await mode();
  const c = conversation();
  artifact.startFullRun = async () => undefined;
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  const origins = ["https://hatch.example"];
  const call = async (method: string, rest: string, headers: Record<string, string> = { origin: origins[0]!, cookie: "hatch_session=t" }) => {
    const { res, out } = fakeResponse();
    try { await handleReportRequest({ method, headers } as unknown as http.IncomingMessage, res, rest, c, artifact, 1 << 20, origins); } catch (error) { return { status: (error as { status: number }).status, body: Buffer.alloc(0), headers: {} }; }
    return out;
  };
  const json = async (method: string, rest: string) => JSON.parse((await call(method, rest)).body.toString());
  const generating = await json("GET", "/report");
  assert.deepEqual([generating.status, generating.phase, generating.files, generating.stage, generating.attempt], ["generating", "summary", { summary_png: false, summary_pdf: false, full_pdf: false }, "queued", 1]);
  assert.equal((await call("GET", "/report/files/summary.png")).status, 404, "nothing before ready");
  assert.equal((await call("POST", "/report/unlock")).status, 409, "the summary is not ready");

  await publishFile((await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!, summaryHtml, "/report/summary.html");
  const ready = await json("GET", "/report");
  assert.deepEqual({ ...ready, steps: undefined, started_at: undefined }, { status: "ready", phase: "summary", unlocked: false, files: { summary_png: true, summary_pdf: true, full_pdf: false }, stage: "ready", attempt: 1, steps: undefined, started_at: undefined });
  const png = await call("GET", "/report/files/summary.png");
  assert.deepEqual([png.headers["content-type"], png.headers["cache-control"]], ["image/png", "private, no-store"]);
  assert.equal((await call("GET", "/report/files/summary.pdf")).body.toString(), "%PDF-SUMMARYPDF");
  assert.equal((await call("GET", "/report/files/full.pdf")).status, 404, "the full report does not exist yet");
  assert.equal((await call("GET", "/report/files/free.pdf")).status, 404);
  assert.equal((await call("GET", "/report/unlock")).status, 405);
  assert.equal((await call("POST", "/report/unlock", { origin: "https://evil.example", cookie: "hatch_session=t" })).status, 403);
  assert.equal((await json("GET", "/report")).phase, "summary", "a refused unlock changed nothing");

  const unlocked = await json("POST", "/report/unlock");
  assert.deepEqual([unlocked.status, unlocked.phase, unlocked.stage, unlocked.unlocked, unlocked.files], ["generating", "full", "queued", true, { summary_png: true, summary_pdf: true, full_pdf: false }]);
  assert.equal((await call("GET", "/report/files/summary.png")).status, 200, "the summary stays while the full report is written");
  assert.equal((await call("GET", "/report/files/full.pdf")).status, 404);
  assert.equal((await json("POST", "/report/unlock")).phase, "full", "again is the same report");

  await artifact.lifecycle.runAccepted(c, { id: (await reports.get(c.id))!.runId! } as never);
  await publishFile((await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!, fullHtml);
  assert.equal((await json("GET", "/report")).files.full_pdf, true);
  assert.equal((await call("GET", "/report/files/full.pdf")).body.toString(), "%PDF-FULLPDF");
  const html = await call("GET", "/report/files/full.html");
  assert.match(String(html.headers["content-security-policy"]), /default-src 'none'.*sandbox/);
  assert.match(html.body.toString(), /FULLTEXT/);
  const chat = conversation("chat-1");
  await assert.rejects(handleReportRequest({ method: "GET" } as http.IncomingMessage, fakeResponse().res, "/report", chat, artifact, 1 << 20, origins), /no report/);
});

// A one-page PDF: enough for pdf.js to render.
function tinyPdf(): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"];
  const stream = "BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

async function flat(pdf: PdfPageRenderer = new PdfParsePageRenderer()) {
  const kit = await harness();
  const files = new FlatAttachmentFiles(kit.repository, kit.blobs, pdf);
  const tools = new Map(attachmentTools(files).map((t) => [t.name, t]));
  return { ...kit, files, tools };
}

test("flat view: every upload by name, text forms as .md, collisions by upload order, no message needed", async () => {
  const { pipeline, files } = await flat();
  const a = await pipeline.accept(scopeA, { name: "notes.txt", bytes: Buffer.from("first notes") });
  await new Promise((r) => setTimeout(r, 5));
  const b = await pipeline.accept(scopeA, { name: "notes.txt", bytes: Buffer.from("second notes") });
  await new Promise((r) => setTimeout(r, 5));
  await pipeline.accept(scopeA, { name: "photo.png", bytes: await png() });
  await pipeline.accept(scopeA, { name: "noext", bytes: Buffer.from("plain") });
  assert.notEqual(a.id, b.id);
  const listing = await files.ls(scopeA);
  const paths = listing.split("\n").map((l) => l.split("  ")[0]);
  assert.deepEqual(paths, ["/attachments/notes.txt", "/attachments/notes.txt.md", "/attachments/notes (2).txt", "/attachments/notes (2).txt.md", "/attachments/photo.png", "/attachments/noext", "/attachments/noext.md"]);
  assert.match(listing, /photo\.png {2}image\/png/);
  assert.match(await files.ls(scopeA, "/attachments/notes (2).txt.md"), /notes \(2\)\.txt\.md[\s\S]*chars/);
  assert.equal(JSON.parse(await files.readTool(scopeA, { path: "/attachments/notes (2).txt.md" }) as string).content, "second notes");
  assert.match(await files.grep(scopeA, { pattern: "first", fixed: true }), /^\/attachments\/notes\.txt\.md:1: first notes$/);
  assert.deepEqual(flatEntries([]), []);
  assert.equal(await files.ls({ ...scopeA, conversationId: "other" }), "(empty)");
});

test("read shows an original image and a PDF page as image blocks; other originals point to the .md", async () => {
  const { pipeline, files, tools } = await flat();
  await pipeline.accept(scopeA, { name: "photo.png", bytes: await png() });
  await pipeline.accept(scopeA, { name: "doc.pdf", bytes: tinyPdf() });
  const image = await files.readTool(scopeA, { path: "/attachments/photo.png" });
  assert.ok(typeof image === "object" && image.image?.mimeType.startsWith("image/") && Buffer.from(image.image.data, "base64").length > 50);
  const page = await files.readTool(scopeA, { path: "/attachments/doc.pdf", page: 2 });
  assert.ok(typeof page === "object" && page.image?.mimeType === "image/png");
  assert.match((page as { text: string }).text, /page 2 of 2/);
  assert.deepEqual([...Buffer.from((page as { image: { data: string } }).image.data, "base64").subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.match(String(await tools.get("read")!.run(scopeA, { path: "/attachments/doc.pdf", page: 3 })), /^Error: This PDF has 2 pages/);
  assert.match(String(await tools.get("read")!.run(scopeA, { path: "/attachments/doc.pdf.md" })), /converted/);
  assert.match(String(await tools.get("read")!.run(scopeA, { path: "/attachments/nope.pdf" })), /^Error: No such file/);
});

test("an original with only a text form says to read the .md", async () => {
  const { pipeline, files } = await flat();
  await pipeline.accept(scopeA, { name: "a.txt", bytes: Buffer.from("hello") });
  await assert.rejects(files.readTool(scopeA, { path: "/attachments/a.txt" }), /Read \/attachments\/a\.txt\.md/);
});

test("the server tool path carries an image beside the text, in the shape the model layer turns into an image block", async () => {
  const { files } = await flat();
  for (const definition of attachmentToolDefinitions(attachmentTools(files))) toolRegistry.set(definition.name, definition);
  const executor = new ServerToolExecutor();
  executor.setAttachments({ run: async () => ({ text: "p, page 1 of 1", image: { mimeType: "image/png", data: "QUJD" } }) });
  const result = await executor.execute("attachments.read", { path: "/attachments/x.pdf" });
  assert.deepEqual(result, { output: "p, page 1 of 1", content_type: "image", mime_type: "image/png", data_base64: "QUJD" });
  executor.setAttachments({ run: async () => "plain" });
  assert.deepEqual(await executor.execute("attachments.ls", {}), { output: "plain" });
});

test("/report/ is mounted beside /attachments/: the same read and ls reach the report files", async () => {
  const { files } = await flat();
  for (const definition of attachmentToolDefinitions(attachmentTools(files))) toolRegistry.set(definition.name, definition);
  const executor = new ServerToolExecutor();
  const asked: string[] = [];
  executor.setAttachments({ run: async (name: string) => { asked.push(`attachments:${name}`); return "attachment"; } });
  executor.setArtifact({ run: async (name, args) => { asked.push(`report:${name}:${String(args.path)}`); return { output: "draft" }; } });
  assert.deepEqual(await executor.execute("attachments.read", { path: "/report/report.html" }), { output: "draft" });
  assert.deepEqual(await executor.execute("attachments.ls", { path: "/report/" }), { output: "draft" });
  assert.deepEqual(await executor.execute("attachments.read", { path: "/attachments/a.pdf" }), { output: "attachment" });
  assert.deepEqual(asked, ["report:read:/report/report.html", "report:ls:/report/", "attachments:read"]);
});

test("report tools are registered for artifact conversations only", async () => {
  for (const definition of artifactToolDefinitions()) toolRegistry.set(definition.name, definition);
  const { chatToolsForRun } = await import("../agentRuntime.js");
  const names = (tools: ReturnType<typeof chatToolsForRun>) => tools.map((t) => t.function.name);
  assert.ok(!names(chatToolsForRun([], [])).includes("publish_report"));
  assert.ok(!names(chatToolsForRun([], undefined)).includes("publish_report"));
  assert.ok(names(chatToolsForRun([], ["artifact.publish_report"])).includes("publish_report"));
});
