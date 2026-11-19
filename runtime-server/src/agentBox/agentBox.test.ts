import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { harness } from "../assets/kit.test.js";
import { requireModelTool, toolRegistry, type ToolDefinition } from "../tools.js";
import { AgentBoxes } from "./boxes.js";
import { InMemoryProductCapabilities } from "./capabilities.js";
import { BuyerFiles, FileLinks, handleFileRoute } from "./files.js";
import { HtmlLinks, HtmlPages, MemoryHtmlPageRepository, handleHtmlRoute } from "./htmlPages.js";
import { BoxFileMissing, BoxNameTaken, type AgentBox, type BoxProvider, type ExecResult } from "./ports.js";
import { AgentBoxMode } from "./tools.js";

const WORK = "/home/agent/work";
const PAGE = "<!doctype html><html><body><h1>Report</h1></body></html>";

/** A box that is a map of files; `bash` echoes the command. */
class FakeBox implements AgentBox {
  readonly files = new Map<string, Buffer>();
  async exec(command: string): Promise<ExecResult> {
    if (command.startsWith("mkdir")) return { exitCode: 0, stdout: "", stderr: "" };
    if (command.startsWith("ls")) return { exitCode: 0, stdout: [...this.files.keys()].join("\n"), stderr: "" };
    return { exitCode: 0, stdout: `ran: ${command}`, stderr: "" };
  }
  async readFile(path: string) { const bytes = this.files.get(path); if (!bytes) throw new BoxFileMissing(`${path} does not exist.`); return bytes; }
  async writeFile(path: string, content: Buffer) { this.files.set(path, content); }
  async stop() {}
}

class FakeProvider implements BoxProvider {
  readonly boxes = new Map<string, FakeBox>();
  creates = 0;
  async find(name: string) { await Promise.resolve(); return this.boxes.get(name); }
  async create(name: string) {
    this.creates += 1;
    if (this.boxes.has(name)) throw new BoxNameTaken(name);
    const box = new FakeBox();
    this.boxes.set(name, box);
    return box;
  }
}

async function setup(capabilities: Array<[string, string]> = [["prod-1", "agent_box"]]) {
  const { repository, blobs } = await harness();
  const provider = new FakeProvider();
  const files = new BuyerFiles(repository, blobs, new FileLinks("secret", "https://example.test"));
  const links = new HtmlLinks("secret", "https://example.test");
  const pages = new HtmlPages(new MemoryHtmlPageRepository(), files, links);
  const mode = new AgentBoxMode({ capabilities: new InMemoryProductCapabilities(capabilities), boxes: new AgentBoxes(provider), workDir: WORK, pdf: { render: async () => { throw new Error("no pdf"); } } as never, files, pages });
  const runnerFor = async (userId: string, guest = false) => (await mode.turnFor({ productId: "prod-1", userId, guest }))!.tools;
  return { provider, pages, files, mode, runnerFor };
}

test("calls that arrive together open one box; a lost create race finds the winner's box", async () => {
  const provider = new FakeProvider();
  const boxes = new AgentBoxes(provider);
  const owner = { productId: "p", buyer: "u" };
  const [a, b] = await Promise.all([boxes.of(owner), boxes.of(owner)]);
  assert.equal(a, b);
  assert.equal(provider.creates, 1);
  // Another process created it between our find and our create.
  const racing = new FakeProvider();
  const winner = new FakeBox();
  let first = true;
  racing.find = async (name) => { if (first) { first = false; return undefined; } return racing.boxes.get(name); };
  racing.create = async (name) => { racing.boxes.set(name, winner); throw new BoxNameTaken(name); };
  assert.equal(await new AgentBoxes(racing).of(owner), winner);
});

test("an opened box is reused across turns until its handle expires; a failed open is not kept", async () => {
  const provider = new FakeProvider();
  let finds = 0;
  const find = provider.find.bind(provider);
  provider.find = async (name) => { finds += 1; return find(name); };
  let now = 0;
  const boxes = new AgentBoxes(provider, 1000, () => now);
  const owner = { productId: "p", buyer: "u" };
  const first = await boxes.of(owner);
  assert.equal(await boxes.of(owner), first);
  assert.equal(finds, 1);
  assert.notEqual(await boxes.of({ productId: "p", buyer: "other" }), first);
  now = 1001;
  assert.equal(await boxes.of(owner), first);
  assert.equal(finds, 3);
  const down = new AgentBoxes({ find: async () => { throw new Error("down"); }, create: async () => { throw new Error("no"); } });
  await assert.rejects(down.of(owner), /down/);
  await assert.rejects(down.of(owner), /down/);
});

test("a Product without the capability has no box tools; a guest's every call asks to sign in", async () => {
  const { mode, runnerFor } = await setup();
  assert.equal(await mode.turnFor({ productId: "other", userId: "u", guest: false }), undefined);
  const turn = await mode.turnFor({ productId: "prod-1", userId: "guest:g", guest: true });
  assert.ok(turn?.extraTools.includes("box.bash"));
  assert.deepEqual(await turn!.tools.run("bash", { command: "ls" }), { status: "error", error: { code: "login_required", message: "This needs the user to sign in first. Tell them to sign in, then ask again." } });
  assert.equal((await runnerFor("u")).owns(`${WORK}/a.html`), true);
  assert.equal((await runnerFor("u")).owns("/attachments/m1/a.txt"), false);
});

test("write, edit, read and bash work in the buyer's own box; paths stay under the working directory", async () => {
  const { provider, runnerFor } = await setup();
  const box = await runnerFor("u1");
  assert.match(String((await box.run("write", { path: "report.html", content: PAGE })).output), /Wrote \/home\/agent\/work\/report\.html/);
  await box.run("edit", { path: `${WORK}/report.html`, old_string: "Report", new_string: "Audit" });
  assert.match(String((await box.run("read", { path: `${WORK}/report.html` })).output), /Audit/);
  assert.match(String((await box.run("bash", { command: "echo hi" })).output), /exit code: 0\nstdout:\nran: echo hi/);
  assert.equal(((await box.run("write", { path: "../etc/passwd", content: "x" })).error as { code: string }).code, "invalid_call");
  // Another buyer has another box.
  await (await runnerFor("u2")).run("bash", { command: "true" });
  assert.equal(provider.boxes.size, 2);
});

test("save_file keeps one record per content; publish_html gives one link per file, served only with its signature", async () => {
  const { pages, runnerFor } = await setup();
  const box = await runnerFor("u1");
  await box.run("write", { path: "report.html", content: PAGE });
  const saved = await box.run("save_file", { path: "report.html" });
  assert.equal(saved.mime, "text/html; charset=utf-8");
  assert.equal((await box.run("save_file", { path: "report.html" })).file_id, saved.file_id);

  const published = await box.run("publish_html", { file_id: saved.file_id, title: "Audit" });
  assert.deepEqual(await box.run("publish_html", { file_id: saved.file_id, title: "Audit again" }), published);
  const url = new URL(String(published.url));
  assert.equal((await pages.open(String(published.page_id), url.searchParams.get("t")))?.toString(), PAGE);
  assert.equal(await pages.open(String(published.page_id), "forged"), undefined);

  // Another buyer cannot publish this buyer's file.
  const other = await runnerFor("u2");
  assert.equal(((await other.run("publish_html", { file_id: saved.file_id, title: "x" })).error as { code: string }).code, "invalid_call");

  // Not a page: refused with the reason.
  await box.run("write", { path: "notes.txt", content: "hello" });
  const notes = await box.run("save_file", { path: "notes.txt" });
  assert.match(String(((await box.run("publish_html", { file_id: notes.file_id, title: "n" })).error as { message: string }).message), /not an \.html file/);
  await box.run("write", { path: "half.html", content: "<div>no document</div>" });
  const half = await box.run("save_file", { path: "half.html" });
  assert.match(String(((await box.run("publish_html", { file_id: half.file_id, title: "h" })).error as { message: string }).message), /whole HTML document/);
});

test("/html/<id> serves the page sandboxed, and a wrong link as a plain 404", async () => {
  const { runnerFor, pages } = await setup();
  const box = await runnerFor("u1");
  await box.run("write", { path: "report.html", content: PAGE });
  const published = await box.run("publish_html", { file_id: (await box.run("save_file", { path: "report.html" })).file_id, title: "Audit" });
  const path = new URL(String(published.url));
  const server = http.createServer((req, res) => void handleHtmlRoute(req, res, new URL(req.url!, "http://x"), pages));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const ok = await fetch(`${base}${path.pathname}${path.search}`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), PAGE);
    const csp = ok.headers.get("content-security-policy")!;
    assert.match(csp, /^sandbox allow-scripts/);
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.doesNotMatch(csp, /default-src|style-src|script-src|font-src/);
    assert.equal((await fetch(`${base}${path.pathname}?t=wrong`)).status, 404);
  } finally { server.close(); }
});

test("one model name on two tools dispatches to the one this Run is allowed", () => {
  const first = { name: "x.write", locality: "server" as const, approval: "none" as const, description: "", schema: {} as never, model: { name: "dup_write", locality: "server", properties: {}, required: [] } } satisfies ToolDefinition;
  toolRegistry.set(first.name, first);
  toolRegistry.set("y.write", { ...first, name: "y.write" });
  try {
    assert.equal(requireModelTool("dup_write").runtimeName, "x.write");
    assert.equal(requireModelTool("dup_write", ["y.write"]).runtimeName, "y.write");
  } finally { toolRegistry.delete("x.write"); toolRegistry.delete("y.write"); }
});

test("save_file returns a signed /file link that downloads the bytes as an attachment; forged and foreign links are a plain 404", async () => {
  const { provider, runnerFor, files } = await setup();
  const box = await runnerFor("u1");
  await box.run("write", { path: "JUDU官网获客诊断.pdf", content: "pdf bytes" });
  const saved = await box.run("save_file", { path: "JUDU官网获客诊断.pdf" });
  assert.match(String(saved.url), /^https:\/\/example\.test\/file\/[0-9a-f-]{36}\?t=/);
  await box.run("write", { path: "x.html", content: PAGE });
  const html = await box.run("save_file", { path: "x.html" });
  const server = http.createServer((req, res) => void handleFileRoute(req, res, new URL(req.url!, "http://x"), files));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const local = (url: unknown) => { const u = new URL(String(url)); return `${base}${u.pathname}${u.search}`; };
  try {
    const ok = await fetch(local(saved.url));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "pdf bytes");
    assert.equal(ok.headers.get("content-type"), "application/pdf");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
    assert.match(ok.headers.get("content-disposition")!, /^attachment; filename="[^"]*\.pdf"; filename\*=UTF-8''JUDU%E5%AE%98%E7%BD%91%E8%8E%B7%E5%AE%A2%E8%AF%8A%E6%96%AD\.pdf$/);
    const page = await fetch(local(html.url));
    assert.match(page.headers.get("content-disposition")!, /^attachment/);
    const path = new URL(String(saved.url)).pathname;
    assert.equal((await fetch(`${base}${path}?t=forged`)).status, 404);
    assert.equal((await fetch(`${base}${path}`)).status, 404);
    // Another buyer's file id with a token that is not its own.
    const other = await runnerFor("u2");
    await other.run("write", { path: "mine.txt", content: "secret of u2" });
    const theirs = new URL(String((await other.run("save_file", { path: "mine.txt" })).url));
    assert.equal((await fetch(`${base}${theirs.pathname}?t=${new URL(String(saved.url)).searchParams.get("t")}`)).status, 404);
  } finally { server.close(); }
  void provider;
});
