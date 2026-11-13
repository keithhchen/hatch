import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ACCOUNT, ORIGIN, OTHER, formConformance, formsHarness, schema } from "./formKit.js";
import { formBaseCss, renderFormPage } from "./inject.js";
import { FormLinks } from "./links.js";
import { MemoryFormRepository } from "./repository.js";
import { handleFormRoute } from "./routes.js";
import { FormClosed, FormConflict, FormInvalid, FormNotFound, parseFormSchema } from "./schema.js";

const PAGE = "<html><head><title>t</title></head><body><script>window.ran = typeof window.hatch</script></body></html>";

formConformance("Memory forms", async () => ({ repository: new MemoryFormRepository(), close: async () => undefined }));

test("a schema needs unique stable ids, and choices need options", () => {
  assert.throws(() => parseFormSchema(schema("C01", "C01")), /unique/);
  assert.throws(() => parseFormSchema({ questions: [{ id: "C01", type: "choice", title: "t", prompt: "p" }] }), /options/);
  assert.throws(() => parseFormSchema({ questions: [{ id: "C01", type: "multi", title: "t", prompt: "p", options: ["a", "a"] }] }), /options/);
  assert.throws(() => parseFormSchema({ questions: [{ id: "C__01", type: "open", title: "t", prompt: "p" }] }), FormInvalid);
  assert.throws(() => parseFormSchema({ questions: [] }), FormInvalid);
  assert.equal(parseFormSchema({ questions: [{ id: "C01", type: "choice", title: "t", prompt: "p", options: ["a", "b"] }] }).questions.length, 1);
});

test("a link is signed for its page and owner, and never expires", () => {
  const links = new FormLinks("secret-a", "https://hatch.test");
  const token = links.token("form_a", ACCOUNT);
  assert.equal(links.verify("form_a", ACCOUNT, token), true);
  assert.equal(links.verify("form_b", ACCOUNT, token), false, "another page");
  assert.equal(links.verify("form_a", OTHER, token), false, "another owner");
  assert.equal(links.verify("form_a", ACCOUNT, `${token}x`), false);
  assert.equal(links.verify("form_a", ACCOUNT, null), false);
  assert.equal(new FormLinks("secret-b", "https://hatch.test").verify("form_a", ACCOUNT, token), false, "another secret");
  assert.equal(links.url("form_a", ACCOUNT), `https://hatch.test/f/form_a?t=${token}`);
  assert.throws(() => new FormLinks(" ", "https://hatch.test"));
});

test("the page gets Hatch's base styles and the client first in <head>, and the data cannot break out of its script", () => {
  const view = { formId: "form_a", token: "t", schema: parseFormSchema(schema("C01")), answers: { C01: "</script><b>x" }, versions: {}, status: "open" as const };
  const out = renderFormPage(PAGE, view);
  assert.ok(out.indexOf("data-hatch-base") < out.indexOf("<title>"), "the base comes before the agent's own head content");
  assert.ok(out.indexOf("__HATCH_FORM__") < out.indexOf("window.ran"), "the client exists before the agent's scripts run");
  assert.ok(!out.includes("</script><b>"), "answer text is escaped");
  assert.ok(formBaseCss().includes("--web-yolk"));
  assert.match(renderFormPage("<p>hi</p>", view), /^<!doctype html><html><head>.*<\/head><body><p>hi<\/p><\/body><\/html>$/s);
  assert.match(renderFormPage("<html><body>x</body></html>", view), /<html><head>.*<\/head><body>x/s);
});

test("publish, fill in, edit and submit: answers are kept by question id and a submit closes the page", async () => {
  const h = await formsHarness();
  try {
    const { form_id, url } = await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { title: "审阅", html: PAGE, schema: schema("C01", "C02") });
    assert.match(form_id, /^form_[a-f0-9]{20}$/);
    const token = h.tokenOf(url);
    assert.equal((await h.forms.save(form_id, token, "C01", "我的回答", 0)).version, 1);
    await h.forms.save(form_id, token, "C02", "另一个", 0);
    assert.deepEqual(await h.forms.read(ACCOUNT, form_id), { status: "open", answers: { C01: "我的回答", C02: "另一个" } });

    // Editing is the same page and link: C02 is gone from the page but its answer is kept; C03 is new.
    const edited = await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { formId: form_id, title: "审阅 v2", html: PAGE.replace("<title>t", "<title>v2"), schema: schema("C01", "C03") });
    assert.equal(edited.url, url);
    assert.deepEqual((await h.forms.read(ACCOUNT, form_id)).answers, { C01: "我的回答" });
    const opened = await h.forms.open(form_id, token);
    assert.match(opened, /v2/);
    assert.match(opened, /我的回答/);
    assert.ok(!opened.includes("另一个"), "an answer to a removed question is not shown");
    await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { formId: form_id, title: "审阅 v3", html: PAGE, schema: schema("C01", "C02", "C03") });
    assert.equal((await h.forms.read(ACCOUNT, form_id)).answers.C02, "另一个", "the question came back with its answer");

    // Clearing, a stale page, a wrong value.
    await h.forms.save(form_id, token, "C01", null, 1);
    assert.equal((await h.forms.read(ACCOUNT, form_id)).answers.C01, undefined);
    await assert.rejects(() => h.forms.save(form_id, token, "C01", "旧页面", 1), FormConflict);
    await assert.rejects(() => h.forms.save(form_id, token, "C99", "x", 0), FormInvalid);
    await assert.rejects(() => h.forms.save(form_id, token, "C01", 5, 2), FormInvalid);

    // Submit closes, tells the conversation once, and nothing is saved after.
    await h.forms.submit(form_id, token);
    await h.forms.submit(form_id, token);
    assert.equal(h.submitted.length, 1);
    assert.deepEqual(h.submitted[0]!.origin, ORIGIN);
    await assert.rejects(() => h.forms.save(form_id, token, "C03", "晚了", 0), FormClosed);
    await assert.rejects(() => h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { formId: form_id, title: "x", html: PAGE, schema: schema("C01") }), FormClosed);
    const read = await h.forms.read(ACCOUNT, form_id);
    assert.equal(read.status, "submitted");
    assert.ok(read.submitted_at);
  } finally { await h.close(); }
});

test("a page opens only with its own link, and only its owner publishes over it or reads it", async () => {
  const h = await formsHarness();
  try {
    const { form_id, url } = await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { title: "t", html: PAGE, schema: schema("C01") });
    await assert.rejects(() => h.forms.open(form_id, null), FormNotFound);
    await assert.rejects(() => h.forms.open(form_id, "bad"), FormNotFound);
    await assert.rejects(() => h.forms.open(form_id, h.links.token(form_id, OTHER)), FormNotFound);
    await assert.rejects(() => h.forms.open("form_nope", h.tokenOf(url)), FormNotFound);
    await assert.rejects(() => h.forms.read(OTHER, form_id), FormNotFound);
    await assert.rejects(() => h.forms.publish({ accountId: OTHER, ...ORIGIN }, { formId: form_id, title: "t", html: PAGE, schema: schema("C01") }), FormNotFound);
  } finally { await h.close(); }
});

test("a submit whose notice failed is not lost: the next submit sends it, once", async () => {
  const h = await formsHarness();
  try {
    const { form_id, url } = await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { title: "t", html: PAGE, schema: schema("C01") });
    h.failNotice(true);
    await assert.rejects(() => h.forms.submit(form_id, h.tokenOf(url)), /down/);
    assert.equal((await h.forms.read(ACCOUNT, form_id)).status, "submitted", "the page is closed even though the notice failed");
    h.failNotice(false);
    await h.forms.submit(form_id, h.tokenOf(url));
    await h.forms.submit(form_id, h.tokenOf(url));
    assert.equal(h.submitted.length, 1);
  } finally { await h.close(); }
});

test("the HTTP route: open the page, save, conflict, clear, submit, closed", async () => {
  const h = await formsHarness();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url!, "http://x");
    handleFormRoute(request, response, url, h.forms).then(handled => { if (!handled) { response.writeHead(404); response.end(); } }, error => { response.writeHead(500); response.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { form_id, url } = await h.forms.publish({ accountId: ACCOUNT, ...ORIGIN }, { title: "t", html: PAGE, schema: schema("C01") });
    const t = h.tokenOf(url);
    const page = await fetch(`${base}/f/${form_id}?t=${t}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html; charset=utf-8/);
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(await page.text(), /window\.hatch/);
    assert.equal((await fetch(`${base}/f/${form_id}?t=wrong`)).status, 404);
    assert.equal((await fetch(`${base}/f/${form_id}`)).status, 404);
    const post = (id: string, body: unknown) => fetch(`${base}/f/${form_id}/answers/${id}?t=${t}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    assert.deepEqual(await (await post("C01", { value: "a", base: 0 })).json(), { version: 1 });
    const stale = await post("C01", { value: "b", base: 0 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json() as any).error.code, "conflict");
    assert.equal((await post("C01", { value: 3, base: 1 })).status, 400);
    assert.equal((await post("C01", { base: 1 })).status, 400);
    assert.deepEqual(await (await fetch(`${base}/f/${form_id}/answers/C01?t=${t}&base=1`, { method: "DELETE" })).json(), { version: 2 });
    assert.equal((await fetch(`${base}/f/${form_id}/submit?t=${t}`, { method: "POST" })).status, 200);
    const late = await post("C01", { value: "c", base: 2 });
    assert.equal(late.status, 409);
    assert.match((await late.json() as any).error.message, /已提交/);
    assert.equal(h.submitted.length, 1);
    assert.equal((await fetch(`${base}/v1/other`)).status, 404, "other paths are not the form route");
  } finally { server.close(); await h.close(); }
});

test("without a configured service the route says so", async () => {
  const server = http.createServer((request, response) => { handleFormRoute(request, response, new URL(request.url!, "http://x"), undefined).catch(() => undefined); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/f/form_${"a".repeat(20)}?t=x`);
    assert.equal(response.status, 503);
  } finally { server.close(); }
});

test("the base styles keep the web theme's tokens, except the three the form pages override", () => {
  const tokens = (css: string) => Object.fromEntries([...css.matchAll(/^\s*(--web-[\w-]+):\s*([^;]+);/gm)].map(match => [match[1]!, match[2]!.trim()]));
  const theme = tokens(readFileSync(fileURLToPath(new URL("../../../creator-dashboard/src/webTheme.css", import.meta.url)), "utf8"));
  const base = tokens(formBaseCss());
  const overrides = new Set(["--web-muted", "--web-rule", "--web-shadow"]);
  assert.ok(Object.keys(base).length >= 10);
  for (const [name, value] of Object.entries(base)) {
    if (overrides.has(name)) assert.notEqual(value, theme[name], `${name} is meant to differ`);
    else assert.equal(value, theme[name], `${name} drifted from webTheme.css`);
  }
});
