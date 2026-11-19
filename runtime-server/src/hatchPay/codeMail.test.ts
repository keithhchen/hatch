import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccessCodeMailer, DEFAULT_SUBJECT_PROMPT, DEFAULT_TEMPLATE_PROMPT } from "./codeMail.js";
import type { EmailMessage } from "./email.js";
import { renderTemplate } from "../agentBox/reportEmail.js";

const DEFAULTS: Record<string, string> = {
  [DEFAULT_TEMPLATE_PROMPT]: '<p>默认 {{product_name}}{{#expert_name}} / {{expert_name}}{{/expert_name}} ¥{{amount}}</p><a href="{{code_url}}">{{code}}</a>',
  [DEFAULT_SUBJECT_PROMPT]: "默认   {{product_name}}\n{{code}}"
};

const setup = (info: { productName: string; expertName?: string; corpusRoot?: string }, prompts: Record<string, string> = DEFAULTS) => {
  const sent: EmailMessage[] = [];
  const mailer = new AccessCodeMailer({
    sender: { send: async m => { sent.push(m); return { id: "m" }; } }, from: "Hatch <noreply@gethatchapp.com>", priceFen: 990,
    prompts: { get: async name => { if (!prompts[name]) throw new Error(`no row ${name}`); return prompts[name]!; } },
    products: { describe: async () => info }
  });
  return { sent, mailer };
};

test("without a Product template the hatch_prompts defaults render with every variable", async () => {
  const { sent, mailer } = setup({ productName: "网站诊断<b>", expertName: "陈老师" });
  await mailer.send({ code: "MSC7K2P9X", productId: "p", to: "a@b.co" });
  const mail = sent[0]!;
  assert.equal(mail.from, "Hatch <noreply@gethatchapp.com>");
  assert.equal(mail.to, "a@b.co");
  assert.equal(mail.subject, "默认 网站诊断<b> MSC7K2P9X", "subject is plain text, one line");
  assert.match(mail.html, /网站诊断&lt;b&gt; \/ 陈老师 ¥9\.90/, "html values are escaped");
  assert.match(mail.html, /href="https:\/\/gethatchapp\.com\/c\/MSC7K2P9X"/);
  assert.match(mail.text, /MSC7K2P9X \(https:\/\/gethatchapp\.com\/c\/MSC7K2P9X\)/);
  assert.equal(mail.idempotencyKey, "access-code-MSC7K2P9X");
});

test("the expert block disappears when there is no expert name", async () => {
  const { sent, mailer } = setup({ productName: "P" });
  await mailer.send({ code: "MSC222222", productId: "p", to: "a@b.co" });
  assert.doesNotMatch(sent[0]!.html, / \/ /);
});

test("the Product Corpus runtime/email/code.html and code-subject.txt win, each on its own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "corpus-"));
  await mkdir(path.join(root, "runtime", "email"), { recursive: true });
  await writeFile(path.join(root, "runtime", "email", "code.html"), "<p>自家模板 {{code}}</p>");
  const { sent, mailer } = setup({ productName: "P", corpusRoot: root });
  await mailer.send({ code: "MSC333333", productId: "p", to: "a@b.co" });
  assert.match(sent[0]!.html, /自家模板 MSC333333/);
  assert.equal(sent[0]!.subject, "默认 P MSC333333", "no code-subject.txt: the default subject");
  await writeFile(path.join(root, "runtime", "email", "code-subject.txt"), "自家主题 {{code}}\n");
  await mailer.send({ code: "MSC444444", productId: "p", to: "a@b.co" });
  assert.equal(sent[1]!.subject, "自家主题 MSC444444");
});

test("no template anywhere is an error, never an invented email", async () => {
  const { sent, mailer } = setup({ productName: "P" }, {});
  await assert.rejects(mailer.send({ code: "MSC555555", productId: "p", to: "a@b.co" }), /no row/);
  assert.equal(sent.length, 0);
});

test("the renderer: {{var}} escaped, {{#var}} blocks kept only when the value is not empty", () => {
  assert.equal(renderTemplate("{{a}}|{{#b}}[{{b}}]{{/b}}|{{c}}", { a: "<x>", b: " " }), "&lt;x&gt;||");
});

test("the code email gets the buyer's name as {{name}}; the block vanishes when it is unknown", async () => {
  const prompts = { ...DEFAULTS, [DEFAULT_TEMPLATE_PROMPT]: "<p>{{#name}}{{name}}，{{/name}}你的码 {{code}}</p>" };
  const { sent, mailer } = setup({ productName: "P" }, prompts);
  await mailer.send({ code: "MSC7K2P9X", productId: "p", to: "a@b.co", name: "王<小明>" });
  await mailer.send({ code: "MSC222222", productId: "p", to: "a@b.co" });
  assert.equal(sent[0]!.html, "<p>王&lt;小明&gt;，你的码 MSC7K2P9X</p>");
  assert.equal(sent[1]!.html, "<p>你的码 MSC222222</p>");
});
