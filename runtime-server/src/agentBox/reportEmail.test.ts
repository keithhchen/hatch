import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { harness } from "../assets/kit.test.js";
import { FilePrompts } from "../prompts.js";
import { AgentBoxes } from "./boxes.js";
import { InMemoryProductCapabilities } from "./capabilities.js";
import { BuyerFiles, FileLinks } from "./files.js";
import { HtmlLinks, HtmlPages, MemoryHtmlPageRepository, PostgresHtmlPageRepository, type HtmlPageRepository } from "./htmlPages.js";
import { BoxFileMissing, BoxNameTaken, type AgentBox, type BoxProvider } from "./ports.js";
import { escapeHtml, htmlToText, readCorpusEmailTemplate, renderTemplate, ReportEmails, TransientEmailError, type EmailMessage, type EmailSender } from "./reportEmail.js";
import { AgentBoxMode, type ReportEmailContext } from "./tools.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const WORK = "/home/agent/work";
const PAGE = "<!doctype html><html><body><h1>Report</h1></body></html>";
const databaseUrl = process.env.HATCH_TEST_DATABASE_URL;

class FakeBox implements AgentBox {
  readonly files = new Map<string, Buffer>();
  async exec() { return { exitCode: 0, stdout: "", stderr: "" }; }
  async readFile(p: string) { const bytes = this.files.get(p); if (!bytes) throw new BoxFileMissing(p); return bytes; }
  async writeFile(p: string, content: Buffer) { this.files.set(p, content); }
  async stop() {}
}
class FakeProvider implements BoxProvider {
  readonly boxes = new Map<string, FakeBox>();
  async find(name: string) { return this.boxes.get(name); }
  async create(name: string) { if (this.boxes.has(name)) throw new BoxNameTaken(name); const box = new FakeBox(); this.boxes.set(name, box); return box; }
}

/** A sender that records what it was asked to send; `failures` transient errors come first. */
class FakeSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  attempts = 0;
  constructor(public failures = 0, private readonly permanent = false) {}
  async send(message: EmailMessage) {
    this.attempts += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    if (this.permanent) throw new Error("invalid_to_address");
    if (this.failures > 0) { this.failures -= 1; throw new TransientEmailError("503"); }
    this.sent.push(message);
    return { id: `msg-${this.sent.length}` };
  }
}

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };

async function setup(options: { repository?: HtmlPageRepository; sender?: FakeSender | null } = {}) {
  const { repository: assets, blobs } = await harness();
  const files = new BuyerFiles(assets, blobs, new FileLinks("secret", "https://example.test"));
  const pageRepository = options.repository ?? new MemoryHtmlPageRepository();
  const pages = new HtmlPages(pageRepository, files, new HtmlLinks("secret", "https://example.test"));
  const sender = options.sender === null ? undefined : options.sender ?? new FakeSender();
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const reportEmail = new ReportEmails({ pages: pageRepository, prompts: new FilePrompts(), ...sender ? { sender } : {}, from: "MSC <reports@example.test>", replyTo: "msc@example.test", retryDelaysMs: [1, 1], log: (event, fields) => events.push({ event, fields }) });
  const mode = new AgentBoxMode({ capabilities: new InMemoryProductCapabilities([["prod-1", "agent_box"]]), boxes: new AgentBoxes(new FakeProvider()), workDir: WORK, pdf: {} as never, files, pages, reportEmail });
  const context: ReportEmailContext = { recipient: "buyer@example.com", chatUrl: "https://example.test/chat/product/prod-1/conversation/conv_1", productName: "出海 <体检>", website: "https://shop.example" };
  const runnerFor = async (userId: string, email: ReportEmailContext | null = context) => (await mode.turnFor({ productId: "prod-1", userId, guest: false, ...email ? { email } : {} }))!.tools;
  const saveFile = async (box: Awaited<ReturnType<typeof runnerFor>>, name: string, content: string) => {
    await box.run("write", { path: name, content });
    return String((await box.run("save_file", { path: name })).file_id);
  };
  return { runnerFor, saveFile, sender, events, pageRepository };
}

test("template: values are escaped, blocks vanish when empty, the subject is plain text", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  const source = "Hi {{name}}{{#note}} Note: {{note}}{{/note}}{{#website}} for {{website}}{{/website}}.";
  assert.equal(renderTemplate(source, { name: "<b>A</b>", website: "x.com" }), "Hi &lt;b&gt;A&lt;/b&gt; for x.com.");
  assert.equal(renderTemplate(source, { name: "A", note: " " }), "Hi A.");
  assert.equal(renderTemplate("{{name}} & co", { name: "<A>" }, true), "<A> & co");
  assert.equal(renderTemplate("{{unknown}}|", {}), "|");
});

test("the platform default template carries the report and chat links, and has a readable text alternative", async () => {
  const defaults = new FilePrompts();
  const html = await defaults.get("report-email-default");
  const values = { report_url: "https://x.test/html/1?t=a&b", chat_url: "https://x.test/chat", product_name: "A<B", expert_name: "", website: "" };
  const without = renderTemplate(html, values);
  assert.ok(!without.includes("{{") && without.includes("A&lt;B") && without.includes("https://x.test/html/1?t=a&amp;b"));
  const text = htmlToText(without);
  assert.match(text, /在线查看报告 \(https:\/\/x\.test\/html\/1\?t=a&b\)/);
  assert.ok(!/[<>]/.test(text.replace(/A<B/g, "")));
  assert.equal(await defaults.get("report-email-default-subject"), "你的「{{product_name}}」报告已生成");
});

test("a Product's own template overrides the default, file by file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "corpus-"));
  assert.equal(await readCorpusEmailTemplate(root), undefined);
  assert.equal(await readCorpusEmailTemplate(undefined), undefined);
  await mkdir(path.join(root, "runtime", "email"), { recursive: true });
  await writeFile(path.join(root, "runtime", "email", "report.html"), "<html>Mine {{product_name}} <a href=\"{{report_url}}\">go</a></html>");
  const template = await readCorpusEmailTemplate(root);
  assert.equal(template?.subject, undefined);
  const { runnerFor, saveFile, sender } = await setup();
  const box = await runnerFor("u1", { recipient: "buyer@example.com", chatUrl: "c", productName: "P&Q", template });
  await box.run("publish_html", { file_id: await saveFile(box, "r.html", PAGE), title: "T" });
  await until(() => sender!.sent.length === 1);
  const [mail] = sender!.sent;
  assert.match(mail!.html, /^<html>Mine P&amp;Q <a href="https:\/\/example\.test\/html\//);
  assert.equal(mail!.subject, "你的「P&Q」报告已生成", "the default subject, unescaped");
  assert.match(mail!.text, /^Mine P&Q go \(https:\/\/example\.test\/html\//);
});

test("publish_html emails the report and chat links once, to the Brief's address", async () => {
  const { runnerFor, saveFile, sender, events } = await setup();
  const box = await runnerFor("u1");
  const published = await box.run("publish_html", { file_id: await saveFile(box, "r.html", PAGE), title: "Audit" });
  await until(() => sender!.sent.length === 1);
  const mail = sender!.sent[0]!;
  assert.equal(mail.to, "buyer@example.com");
  assert.equal(mail.from, "MSC <reports@example.test>");
  assert.equal(mail.replyTo, "msc@example.test");
  assert.equal(mail.idempotencyKey, published.page_id);
  for (const link of [String(published.url), "https://example.test/chat/product/prod-1/conversation/conv_1"]) assert.ok(mail.html.replaceAll("&amp;", "&").includes(link), link);
  assert.ok(mail.html.includes("出海 &lt;体检&gt;") && !mail.html.includes("<体检>"));
  assert.equal(mail.subject, "你的「出海 <体检>」报告已生成");
  assert.ok(mail.text.includes(String(published.url)));
  const sentLog = events.find(e => e.event === "report_email_sent")!;
  assert.ok(!JSON.stringify(sentLog).includes("buyer@example.com"), "no address in the log");
  assert.match(String(sentLog.fields.to), /^[0-9a-f]{12}$/);
  // Publishing the same page again sends nothing more.
  await box.run("publish_html", { file_id: await saveFile(box, "r.html", PAGE), title: "Audit" });
  await until(() => events.some(e => e.event === "report_email_skipped"));
  assert.equal(sender!.sent.length, 1);
});

test("no email without an address in the Brief, and none when sending is off", async () => {
  const none = await setup();
  const box = await none.runnerFor("u1", null);
  await box.run("publish_html", { file_id: await none.saveFile(box, "r.html", PAGE), title: "T" });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(none.sender!.attempts, 0);
  assert.deepEqual(none.events, []);

  const off = await setup({ sender: null });
  const offBox = await off.runnerFor("u1");
  const published = await offBox.run("publish_html", { file_id: await off.saveFile(offBox, "r.html", PAGE), title: "T" });
  assert.ok(published.url, "the publish itself is unaffected");
  await until(() => off.events.length > 0);
  assert.equal(off.events[0]!.event, "report_email_off");
  const page = await off.pageRepository.get(String(published.page_id));
  assert.ok(await off.pageRepository.claimEmail(page!.id, "h", 600), "off leaves the page unclaimed, so turning sending on later can send");
});

test("a transient failure is retried; a permanent one is logged, releases the claim, and the tool is never affected", async () => {
  const flaky = await setup({ sender: new FakeSender(2) });
  const box = await flaky.runnerFor("u1");
  await box.run("publish_html", { file_id: await flaky.saveFile(box, "r.html", PAGE), title: "T" });
  await until(() => flaky.sender!.sent.length === 1);
  assert.equal(flaky.sender!.attempts, 3);
  assert.equal(flaky.events.filter(e => e.event === "report_email_retry").length, 2);

  const broken = await setup({ sender: new FakeSender(0, true) });
  const brokenBox = await broken.runnerFor("u1");
  const file = await broken.saveFile(brokenBox, "r.html", PAGE);
  const published = await brokenBox.run("publish_html", { file_id: file, title: "T" });
  assert.ok(published.url);
  await until(() => broken.events.some(e => e.event === "report_email_failed"));
  assert.equal(broken.sender!.attempts, 1, "a permanent failure is not retried");
  // Released: the same page can be tried again.
  assert.ok(await broken.pageRepository.claimEmail(String(published.page_id), "h", 600));
});

test("postgres: concurrent publishes and retries email one page once", { skip: !databaseUrl, timeout: 30_000 }, async () => {
  const schema = `email_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  let pool: Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 20 });
    const repository = new PostgresHtmlPageRepository(pool);
    await repository.initialize();
    await repository.initialize();
    const { runnerFor, saveFile, sender, events } = await setup({ repository, sender: new FakeSender() });
    const box = await runnerFor("u1");
    const file = await saveFile(box, "r.html", PAGE);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => box.run("publish_html", { file_id: file, title: "T" })));
    assert.equal(new Set(results.map(r => r.page_id)).size, 1);
    await until(() => events.filter(e => e.event === "report_email_skipped").length === 11);
    assert.equal(sender!.sent.length, 1);
    const row = (await pool.query("SELECT emailed_at, email_message_id, emailed_to FROM hatch_html_pages")).rows[0];
    assert.equal(row.email_message_id, "msg-1");
    assert.match(row.emailed_to, /^[0-9a-f]{12}$/);

    // The conditional update itself: one winner among parallel claims; an unfinished claim is taken over only once stale.
    const id = String(results[0]!.page_id);
    await pool.query("UPDATE hatch_html_pages SET emailed_at = NULL, emailed_to = NULL, email_message_id = NULL WHERE id = $1", [id]);
    const claims = await Promise.all(Array.from({ length: 15 }, () => repository.claimEmail(id, "h", 600)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await repository.claimEmail(id, "h", 600), false, "claimed and in flight");
    await pool.query("UPDATE hatch_html_pages SET emailed_at = now() - interval '11 minutes' WHERE id = $1", [id]);
    assert.equal(await repository.claimEmail(id, "h", 600), true, "stale claim, no message id");
    await repository.markEmailed(id, "m");
    await pool.query("UPDATE hatch_html_pages SET emailed_at = now() - interval '1 day' WHERE id = $1", [id]);
    assert.equal(await repository.claimEmail(id, "h", 600), false, "a sent page is never claimed again");
    await repository.releaseEmail(id);
    assert.equal(await repository.claimEmail(id, "h", 600), false, "release does not undo a sent email");
  } finally {
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
