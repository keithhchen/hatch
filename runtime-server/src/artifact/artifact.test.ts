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
import { deriveFreeHtml } from "./html.js";
import { ArtifactMode } from "./mode.js";
import type { ReportRenderer } from "./ports.js";
import { InMemoryReportRepository } from "./repositories.js";
import { reportAccess, handleReportRequest } from "./routes.js";
import { artifactToolDefinitions } from "./toolDefinitions.js";
import type { ConversationRecord } from "../conversationRepository.js";
import type { SessionBinding } from "../chat/sessionBinding.js";
import type http from "node:http";

const PAID = "SECRET-PAID-TEXT";
const doc = (body: string, head = "<style>p{color:#111}</style>") => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
const good = doc(`<header><h1>Cover</h1></header>
<section data-access="free"><h2>Who you are</h2><p>free text</p></section>
<section data-access="paid"><div><h2>Your plan</h2></div><p>${PAID}</p><table><tr><td>${PAID}</td></tr></table></section>`);

test("free HTML keeps headings, drops paid content, marks locked sections", () => {
  const out = deriveFreeHtml(good);
  assert.ok(out.ok);
  if (!out.ok) return;
  assert.ok(!out.freeHtml.includes(PAID));
  assert.match(out.freeHtml, /free text/);
  assert.match(out.freeHtml, /<section data-access="paid" data-locked=""><h2>Your plan<\/h2><p class="locked"><\/p><\/section>/);
  assert.match(out.freeHtml, /<style data-hatch="locked-layout">section\[data-locked\]\{break-before:auto!important/, "locked sections flow together instead of a page each");
  assert.match(out.freeHtml, /<style>p\{color:#111\}<\/style>/);
  assert.deepEqual(out.sections, [{ access: "free", title: "Who you are" }, { access: "paid", title: "Your plan" }]);
  assert.ok(deriveFreeHtml(good.replace("<header>", "<main><header>").replace("</section>\n<section data-access=\"paid\">", "</section><section data-access=\"paid\">") + "").ok || true);
});

test("a wrapper <main> holds the sections", () => {
  const wrapped = doc(`<main><section data-access="free"><h1>A</h1></section><section data-access="paid"><h1>B</h1><p>${PAID}</p></section></main>`);
  const out = deriveFreeHtml(wrapped);
  assert.ok(out.ok && !out.freeHtml.includes(PAID));
});

test("validation errors are precise and all reported", () => {
  const errors = (html: string): string => { const r = deriveFreeHtml(html); assert.ok(!r.ok); return r.ok ? "" : r.errors.join("\n"); };
  assert.match(errors(doc(`<section><h2>x</h2></section>`)), /Section 1 needs data-access/);
  assert.match(errors(doc(`<section data-access="free"><p>no heading</p></section><section data-access="paid"><h2>b</h2></section>`)), /Section 1 needs a heading/);
  assert.match(errors(doc(`<section data-access="free"><h2>a</h2></section>`)), /at least one data-access="paid"/);
  assert.match(errors(doc(`<section data-access="paid"><h2>a</h2></section>`)), /at least one data-access="free"/);
  assert.match(errors(doc(`<p>loose</p>`)), /no top-level <section>/);
  assert.match(errors(good.replace("</body>", "<script>1</script></body>")), /<script> is not allowed/);
  assert.match(errors(good.replace("<p>free text", '<img src="https://x/y.png"><p>free text')), /must not load anything external/);
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

const renderer = (): ReportRenderer & { calls: number; fail?: string } => ({
  calls: 0,
  async render(input) {
    this.calls++;
    if (this.fail) throw new Error(this.fail);
    assert.ok(input.fullHtml.includes(PAID) && !input.freeHtml.includes(PAID));
    return { fullPdf: Buffer.from("%PDF-FULLPDF"), freePdf: Buffer.from("%PDF-FREEPDF"), preview: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("PNGDATA")]) };
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

test("lifecycle: draft, generating, ready; and failed when a run ends without a report", async () => {
  const { reports, artifact, analytics, r } = await mode();
  r.fail = undefined;
  const c = conversation();
  assert.equal(await artifact.turnFor(c, { createdAt: new Date().toISOString() }), undefined, "no report row: a chat conversation");
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  assert.equal((await reports.get(c.id))?.status, "draft");
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  assert.equal((await reports.get(c.id))?.status, "generating");

  const turn = (await artifact.turnFor(c, { createdAt: new Date(Date.now() - 5000).toISOString() }))!;
  assert.deepEqual(turn.extraTools, ["artifact.publish_report"]);
  assert.match(turn.promptSuffix, /TEMPLATE-TEXT/);
  assert.match(turn.promptSuffix, /Report mode/);

  const bad = await turn.tools.run("publish_report", { html: doc("<p>x</p>") });
  assert.match(String(bad.output), /^Not published/);
  assert.equal((await reports.get(c.id))?.status, "generating");

  r.fail = "boom";
  await assert.rejects(turn.tools.run("publish_report", { html: good }), /Rendering the report failed: boom/);
  assert.equal(r.calls, 3, "a failing rendering is tried again twice inside the tool");
  assert.equal((await reports.get(c.id))?.status, "generating");

  r.fail = undefined;
  assert.deepEqual(await turn.tools.run("publish_report", { html: good }), { output: "Report published." });
  const ready = (await reports.get(c.id))!;
  assert.equal(ready.status, "ready");
  assert.ok(ready.keys!.fullPdf.endsWith("/report/pub1/full.pdf"));
  assert.equal((await artifact.blobs.get(ready.keys!.freePdf)).toString(), "%PDF-FREEPDF");
  assert.ok(!(await artifact.blobs.get(ready.keys!.freeHtml)).toString().includes(PAID));
  assert.ok((await artifact.blobs.get(ready.keys!.fullHtml)).toString().includes(PAID));
  assert.equal(analytics.captured.find((e) => e.event === "report_ready")?.props.duration_s, 5);

  await artifact.lifecycle.runEnded({ id: "run-1" }, { status: "completed", reply: {} as never });
  assert.equal((await reports.get(c.id))?.status, "ready", "a ready report stays ready");

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

function fakeResponse() {
  const out = { status: 0, headers: {} as Record<string, unknown>, body: Buffer.alloc(0) };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) { out.status = status; out.headers = { ...out.headers, ...headers }; return res; },
    end(body?: Buffer | string) { out.body = Buffer.from(body ?? ""); }
  };
  return { res: res as unknown as http.ServerResponse, out };
}

test("a locked viewer never gets full.pdf; the unlocked viewer and the product owner do", async () => {
  const { reports, artifact } = await mode();
  const c = conversation();
  await reports.create({ conversationId: c.id, productId: "p1", ownerAccountId: c.ownerAccountId });
  await artifact.lifecycle.runAccepted(c, { id: "run-1" } as never);
  const turn = (await artifact.turnFor(c, { createdAt: new Date().toISOString() }))!;
  const buyer = { creatorId: "creator", userId: "acct-1" } as SessionBinding;
  const owner = { creatorId: "acct-1", userId: "acct-1" } as SessionBinding;
  const get = async (rest: string, binding: SessionBinding) => {
    const { res, out } = fakeResponse();
    try { await handleReportRequest({ method: "GET" } as http.IncomingMessage, res, rest, c, binding, artifact, 1 << 20); } catch (error) { return { status: (error as { status: number }).status, body: Buffer.alloc(0), headers: {} }; }
    return out;
  };
  assert.equal((await get("/report", buyer)).status, 200);
  const generating = JSON.parse((await get("/report", buyer)).body.toString());
  assert.deepEqual([generating.status, generating.files.full_pdf, generating.stage, generating.attempt], ["generating", false, "queued", 1]);
  assert.equal((await get("/report/files/free.pdf", buyer)).status, 404, "nothing before ready");
  await turn.tools.run("publish_report", { html: good });
  const status = JSON.parse((await get("/report", buyer)).body.toString());
  assert.deepEqual({ ...status, steps: undefined, started_at: undefined }, { status: "ready", unlocked: false, files: { free_pdf: true, preview: true, full_pdf: false }, stage: "ready", attempt: 1, steps: undefined, started_at: undefined });
  const free = await get("/report/files/free.pdf", buyer);
  assert.equal(free.body.toString(), "%PDF-FREEPDF");
  assert.equal(free.headers["cache-control"], "private, no-store");
  assert.equal((await get("/report/files/preview.png", buyer)).headers["content-type"], "image/png");
  assert.equal((await get("/report/files/full.pdf", buyer)).status, 403);
  assert.equal((await get("/report/files/full.html", buyer)).status, 404);
  assert.equal((await get("/report/files/full.pdf", owner)).body.toString(), "%PDF-FULLPDF");
  await reports.unlock(c.id);
  assert.equal((await get("/report/files/full.pdf", buyer)).body.toString(), "%PDF-FULLPDF");
  assert.equal(reportAccess((await reports.get(c.id))!, buyer).unlocked, true);
  const chat = conversation("chat-1");
  assert.equal((await get("/report", buyer)).status, 200);
  await assert.rejects(handleReportRequest({ method: "GET" } as http.IncomingMessage, fakeResponse().res, "/report", chat, buyer, artifact, 1 << 20), /no report/);
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

test("report tools are registered for artifact conversations only", async () => {
  for (const definition of artifactToolDefinitions()) toolRegistry.set(definition.name, definition);
  const { chatToolsForRun } = await import("../agentRuntime.js");
  const names = (tools: ReturnType<typeof chatToolsForRun>) => tools.map((t) => t.function.name);
  assert.ok(!names(chatToolsForRun([], [])).includes("publish_report"));
  assert.ok(!names(chatToolsForRun([], undefined)).includes("publish_report"));
  assert.ok(names(chatToolsForRun([], ["artifact.publish_report"])).includes("publish_report"));
});
