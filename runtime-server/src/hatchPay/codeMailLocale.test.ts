import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { AccessCodeMailer, DEFAULT_SUBJECT_PROMPT, DEFAULT_TEMPLATE_PROMPT } from "./codeMail.js";
import type { EmailMessage } from "./email.js";
import { FilePrompts } from "../prompts.js";

const ROWS: Record<string, string> = {
  [DEFAULT_TEMPLATE_PROMPT]: "<p>默认 {{code}}</p>", [DEFAULT_SUBJECT_PROMPT]: "默认 {{code}}",
  [`${DEFAULT_TEMPLATE_PROMPT}-ja`]: "<p>日本語 {{code}}</p>", [`${DEFAULT_SUBJECT_PROMPT}-ja`]: "コード {{code}}"
};

const setup = (corpusRoot?: string, rows = ROWS) => {
  const sent: EmailMessage[] = [];
  const mailer = new AccessCodeMailer({
    sender: { send: async m => { sent.push(m); return { id: "m" }; } }, from: "Hatch <noreply@gethatchapp.com>", priceFen: 990,
    prompts: { get: async name => { if (!rows[name]) throw new Error(`no row ${name}`); return rows[name]!; } },
    products: { describe: async () => ({ productName: "P", ...corpusRoot ? { corpusRoot } : {} }) }
  });
  return { sent, mailer };
};

test("the code email goes out in the visitor's language; a language without a row is mailed the Chinese default, and logged", async () => {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const { sent, mailer } = setup();
    await mailer.send({ code: "MSC666666", productId: "p", to: "a@b.co", locale: "ja" });
    assert.match(sent[0]!.html, /日本語 MSC666666/);
    assert.equal(sent[0]!.subject, "コード MSC666666");
    await mailer.send({ code: "MSC777777", productId: "p", to: "a@b.co", locale: "en" });
    assert.match(sent[1]!.html, /默认/);
    await mailer.send({ code: "MSC888888", productId: "p", to: "a@b.co" });
    assert.match(sent[2]!.html, /默认/, "no locale is Chinese");
  } finally { warn.mock.restore(); }
});

test("the shipped English and Japanese defaults carry the code and its page", async () => {
  const prompts = new FilePrompts();
  const rows: Record<string, string> = {};
  for (const locale of ["en", "ja"]) for (const name of [DEFAULT_TEMPLATE_PROMPT, DEFAULT_SUBJECT_PROMPT]) rows[`${name}-${locale}`] = await prompts.get(`${name}-${locale}` as never);
  const { sent, mailer } = setup(undefined, rows);
  for (const locale of ["en", "ja"] as const) await mailer.send({ code: "MSC123456", productId: "p", to: "a@b.co", locale });
  for (const mail of sent) { assert.match(mail.html, /MSC123456/); assert.match(mail.html, /https:\/\/gethatchapp\.com\/c\/MSC123456/); assert.match(mail.subject, /MSC123456/); }
  assert.doesNotMatch(sent[0]!.html, /[一-龥]/);
  assert.doesNotMatch(sent[1]!.html, /[一-龥]{3}/);
});

test("an Expert's own code template is per language: another language never gets the Chinese one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "corpus-"));
  await mkdir(path.join(root, "runtime", "email"), { recursive: true });
  await writeFile(path.join(root, "runtime", "email", "code.html"), "<p>自家模板 {{code}}</p>");
  await writeFile(path.join(root, "runtime", "email", "code.en.html"), "<p>Own template {{code}}</p>");
  const { sent, mailer } = setup(root);
  await mailer.send({ code: "MSC111222", productId: "p", to: "a@b.co", locale: "en" });
  assert.match(sent[0]!.html, /Own template MSC111222/);
  await mailer.send({ code: "MSC333444", productId: "p", to: "a@b.co", locale: "ja" });
  assert.match(sent[1]!.html, /日本語 MSC333444/, "no Japanese file of the Expert's: the platform's Japanese default");
  await mailer.send({ code: "MSC555666", productId: "p", to: "a@b.co" });
  assert.match(sent[2]!.html, /自家模板/);
});
