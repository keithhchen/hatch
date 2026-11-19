import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import test from "node:test";
import { auditBrief } from "../accessGate.testkit.js";
import { HtmlLinks, MemoryHtmlPageRepository, handleHtmlRoute, type HtmlPage } from "./htmlPages.js";
import { MemoryLeadRepository, ReportLeads, WindowLimiter, briefContactOf } from "./reportLeads.js";

const SCRIPT = readFileSync(new URL("../../report-assets/v1/report.js", import.meta.url), "utf8");
const TIER = { tier_index: 1, tier_name: "拿到细化的改进建议和参考样例", tier_price: "¥99" };

async function setup(userId: string, now?: () => number) {
  const links = new HtmlLinks("secret", "https://example.test");
  const pages = new MemoryHtmlPageRepository();
  const page = await pages.publish({ productId: "prod-1", userId, fileId: "f1", title: "Audit" });
  const repository = new MemoryLeadRepository();
  const codes = { lookup: async (code: string) => code === "MSC123456" ? { status: "used" as const, source: "paid" as const, productId: "prod-1", conversationId: "conv-1", outcome: null } : null };
  const conversations = { getConversation: async (id: string) => id === "conv-1" ? { briefSnapshot: auditBrief("MSC123456") } as never : undefined };
  const leads = new ReportLeads(pages, links, repository, briefContactOf(codes, conversations), new WindowLimiter(5, 60_000, now));
  const server = http.createServer((req, res) => void handleHtmlRoute(req, res, new URL(req.url!, "http://x"), undefined, leads));
  await new Promise<void>(resolve => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (page: HtmlPage, token: string, body: unknown = TIER) => fetch(`${base}/html/${page.id}/lead?t=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { page, links, repository, base, post, close: () => server.close() };
}

test("POST /html/<id>/lead: a bad signature is 403 and stores nothing", async () => {
  const t = await setup("code:MSC123456");
  try {
    assert.equal((await t.post(t.page, "wrong")).status, 403);
    assert.equal((await t.post(t.page, t.links.token("00000000-0000-4000-8000-000000000000"))).status, 403);
    assert.equal(t.repository.leads.length, 0);
  } finally { t.close(); }
});

test("a code's page records the Brief's name, phone and email; a second click on the tier stays one row", async () => {
  const t = await setup("code:MSC123456");
  try {
    const token = t.links.token(t.page.id);
    assert.deepEqual(await (await t.post(t.page, token)).json(), { ok: true, outcome: "recorded" });
    assert.deepEqual(await (await t.post(t.page, token)).json(), { ok: true, outcome: "duplicate" });
    await t.post(t.page, token, { ...TIER, tier_index: 2, tier_name: "报告", tier_price: "¥399" });
    assert.equal(t.repository.leads.length, 2);
    assert.deepEqual(t.repository.leads[0], {
      pageId: t.page.id, productId: "prod-1", conversationId: "conv-1", accessCode: "MSC123456", name: "A", phone: "1", email: "a@b.co",
      tierIndex: 1, tierName: TIER.tier_name, tierPrice: "¥99"
    });
  } finally { t.close(); }
});

test("a page that is not a code's still records the tier, without a buyer", async () => {
  const t = await setup("buyer-7");
  try {
    assert.equal((await t.post(t.page, t.links.token(t.page.id))).status, 200);
    assert.deepEqual(t.repository.leads[0], { pageId: t.page.id, productId: "prod-1", conversationId: null, accessCode: null, name: null, phone: null, email: null, tierIndex: 1, tierName: TIER.tier_name, tierPrice: "¥99" });
  } finally { t.close(); }
});

test("the preflight of an opaque origin is answered, a bad tier is 400, and a loop is rate limited", async () => {
  const t = await setup("code:MSC123456");
  try {
    const preflight = await fetch(`${t.base}/html/${t.page.id}/lead?t=x`, { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-headers")!, /content-type/);
    const token = t.links.token(t.page.id);
    assert.equal((await t.post(t.page, token, { tier_index: "x" })).status, 400);
    const post = await t.post(t.page, token);
    assert.equal(post.headers.get("access-control-allow-origin"), "*");
    for (let i = 0; i < 3; i++) await t.post(t.page, token);
    assert.equal((await t.post(t.page, token)).status, 200, "the fifth request of the window");
    assert.equal((await t.post(t.page, token)).status, 429);
  } finally { t.close(); }
});

test("report.js in a sandboxed page: first tier highlighted, a button per tier, the modal opens, and two clicks store one row", async () => {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, ...(process.env.HATCH_CHROMIUM_PATH ? { executablePath: process.env.HATCH_CHROMIUM_PATH } : {}) }).catch(() => undefined);
  if (!browser) return; // no browser on this machine: the render check is skipped
  const t = await setup("code:MSC123456");
  // The script is inlined, as the test has no gethatchapp.com.
  const data = { score: 20, dims: [1, 1, 1, 1, 1, 1, 1, 1, 1], six: [0, 0, 0, 0, 0, 0], dots: [60, 25, 14, 1], total: { sum: 9, deduct: 0 }, items: [], sources: ["a"] };
  const html = `<!doctype html><html><body><main><section class="hero"></section><section id="journey"><div class="journey"><p>a</p><p>b</p><p>c</p><p>d</p></div></section><section id="dimensions"></section><section id="sustain"><div class="sus"></div></section><section id="services"></section><section id="appendix"></section></main><footer></footer><script type="application/json" id="report-data">${JSON.stringify(data)}</script><script>${SCRIPT}</script></body></html>`;
  try {
    const p = await browser.newPage();
    // The page is fulfilled under the real CSP at its real path; its POST is forwarded to the real route.
    const at = `http://report.test/html/${t.page.id}`;
    await p.route(`${at}?t=*`, route => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "content-security-policy": "sandbox allow-scripts" }, body: html }));
    await p.route(`${at}/lead?t=*`, async route => {
      const request = route.request(), response = await fetch(request.url().replace("http://report.test", t.base), { method: "POST", headers: { "content-type": "application/json" }, body: request.postData()! });
      await route.fulfill({ status: response.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: await response.text() });
    });
    await p.goto(`${at}?t=${t.links.token(t.page.id)}`);
    assert.equal(await p.locator("#services .card").count(), 3);
    assert.deepEqual(await p.locator("#services .card").evaluateAll(cards => cards.map(c => c.classList.contains("rec"))), [true, false, false]);
    assert.equal(await p.locator("#services .book").count(), 3);
    assert.deepEqual(await p.locator("#services .book").allTextContents(), ["预约咨询", "预约咨询", "预约咨询"]);
    await p.evaluate("reportFinish()");
    const second = p.locator("#services .book").nth(1);
    await second.click();
    assert.equal(await p.locator(".modal").innerText().then(s => s.replace(/\s+/g, " ")), "MSC 的咨询顾问会尽快联系您 关闭");
    await p.locator(".modalclose").click();
    assert.equal(await p.locator(".modal").count(), 0);
    await second.click();
    assert.equal(await p.locator(".modal").count(), 1, "the modal still shows on the second click");
    await p.waitForTimeout(200);
    assert.equal(t.repository.leads.length, 1);
    assert.deepEqual([t.repository.leads[0]!.tierIndex, t.repository.leads[0]!.tierName, t.repository.leads[0]!.tierPrice, t.repository.leads[0]!.email], [1, "拿到细化的改进建议和参考样例", "¥99", "a@b.co"]);
  } finally { await browser.close(); t.close(); }
});
