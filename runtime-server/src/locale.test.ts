import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REPLY_LANGUAGE_RULE, runtimeReplyReminder } from "./agentRuntime.js";
import { readCorpusEmailTemplate, ReportEmails, type EmailMessage } from "./agentBox/reportEmail.js";
import { FilePrompts } from "./prompts.js";
import { localeOf, normalizeLocale } from "./locale.js";

test("normalizeLocale: zh, en and ja by tag; anything else is none, and localeOf makes it zh", () => {
  assert.equal(normalizeLocale("ja-JP"), "ja");
  assert.equal(normalizeLocale(" EN "), "en");
  assert.equal(normalizeLocale("zh-Hans-CN"), "zh");
  assert.equal(normalizeLocale("fr"), null);
  assert.equal(normalizeLocale("zhx"), null);
  assert.equal(normalizeLocale(undefined), null);
  assert.equal(localeOf("fr"), "zh");
  assert.equal(localeOf(5), "zh");
});

test("the reply reminder carries the language a code-page visitor chose, in place of the chat's follow-the-user rule", () => {
  const now = new Date("2026-10-27T07:40:00Z");
  const japanese = runtimeReplyReminder(now, undefined, "ja");
  assert.match(japanese, /The user chose Japanese on the page: write everything they receive in Japanese, including any report/);
  assert.ok(!japanese.includes(REPLY_LANGUAGE_RULE));
  assert.match(runtimeReplyReminder(now, undefined, "en"), /chose English/);
  assert.ok(runtimeReplyReminder(now).includes(REPLY_LANGUAGE_RULE), "a conversation without a chosen language keeps the chat rule");
});

test("the report email is in the visitor's language: platform default per language, the Expert's own files per language", async () => {
  const sent: EmailMessage[] = [];
  const claimed: string[] = [];
  const emails = new ReportEmails({
    pages: { claimEmail: async (id: string) => { claimed.push(id); return true; }, markEmailed: async () => undefined, releaseEmail: async () => undefined } as never,
    prompts: new FilePrompts(), sender: { send: async (message) => { sent.push(message); return { id: "m" }; } }, from: "Hatch <h@x.co>", log: () => undefined
  });
  const job = { recipient: "a@b.co", reportUrl: "https://r.example/x", chatUrl: "https://c.example/x", productName: "P" };
  await emails.notify({ ...job, pageId: "p1" });
  await emails.notify({ ...job, pageId: "p2", locale: "zh" });
  await emails.notify({ ...job, pageId: "p3", locale: "en" });
  await emails.notify({ ...job, pageId: "p4", locale: "ja" });
  assert.match(sent[0]!.subject, /报告已生成/);
  assert.equal(sent[1]!.subject, sent[0]!.subject);
  assert.equal(sent[2]!.subject, "Your \"P\" report is ready");
  assert.match(sent[2]!.html, /View the report/);
  assert.match(sent[3]!.subject, /レポートができました/);
  assert.match(sent[3]!.html, /lang="ja"/);

  const root = await mkdtemp(path.join(os.tmpdir(), "corpus-"));
  await mkdir(path.join(root, "runtime", "email"), { recursive: true });
  await writeFile(path.join(root, "runtime", "email", "report.html"), "<p>自家</p>");
  await writeFile(path.join(root, "runtime", "email", "report.ja.html"), "<p>自社</p>");
  assert.equal((await readCorpusEmailTemplate(root))?.html, "<p>自家</p>");
  assert.equal((await readCorpusEmailTemplate(root, "ja"))?.html, "<p>自社</p>");
  assert.equal(await readCorpusEmailTemplate(root, "en"), undefined, "no English file: the platform's English email, not the Chinese template");
});
