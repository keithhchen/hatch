import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import vm from "node:vm";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { HatchPay, handleHatchPayRoute, siteDomain } from "./routes.js";

const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
const BACK = `https://gethatchapp.com/p/${PRODUCT}`;
const corpora = { resolveByProduct: async () => ({ corpus: { creator: { name: "MSC咨询" }, product: { name: "出海官网获客诊断", description: "一份说清官网为什么没有询盘的诊断" } } }) };

async function serve(withCorpora = true) {
  const pay = new HatchPay({
    capabilities: new InMemoryProductCapabilities([[PRODUCT, "access_code"]]), publicBase: "https://anyteach.cn/hatch-pay", priceFen: 1,
    wechat: { ready: () => true }, codes: {}, openids: {}, mailer: {}, ...withCorpora ? { corpora } : {}
  } as unknown as ConstructorParameters<typeof HatchPay>[0]);
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), pay));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay/`;
  return { base, close: () => { server.closeAllConnections(); server.close(); } };
}
const q = (extra: Record<string, string> = {}) => `?${new URLSearchParams({ product: PRODUCT, email: "a@b.co", back: BACK, ...extra })}`;

test("pay page shows logo, product, expert, order lines, price and email; site and name are escaped and validated", async () => {
  const s = await serve();
  try {
    const res = await fetch(s.base + q({ site: "https://www.Example.com/path?x=1", name: "<b>陈</b>" }));
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "origin");
    assert.match(html, /hatch-downloads\.oss-cn-shanghai\.aliyuncs\.com\/brand\/hatch-lockup\.png/);
    assert.match(html, /出海官网获客诊断/);
    assert.match(html, /MSC咨询/);
    assert.match(html, /一份说清官网为什么没有询盘的诊断/);
    assert.match(html, /<dd>example\.com<\/dd>/, "the site is a bare domain");
    assert.match(html, /<dd>&lt;b&gt;陈&lt;\/b&gt;<\/dd>/, "the name is escaped");
    assert.doesNotMatch(html, /<b>陈/);
    assert.match(html, /¥0\.01/);
    assert.match(html, /<dd>a@b\.co<\/dd>/);
    assert.match(html, /class="spin"/);

    const bare = await (await fetch(s.base + q())).text();
    assert.doesNotMatch(bare, /网站|姓名/, "absent site and name omit their lines");
    const bad = await (await fetch(s.base + q({ site: "javascript:alert(1)", name: "x".repeat(41) }))).text();
    assert.doesNotMatch(bad, /网站|姓名|alert/, "an invalid site or an over-long name is dropped");
  } finally { s.close(); }
});

test("without a Product Corpus the card still shows the price and order, with no invented product details", async () => {
  const s = await serve(false);
  try {
    const html = await (await fetch(s.base + q({ site: "example.com" }))).text();
    assert.match(html, /¥0\.01/);
    assert.doesNotMatch(html, /<h1>/);
  } finally { s.close(); }
});

test("siteDomain keeps only a plausible domain", () => {
  assert.equal(siteDomain("example.com"), "example.com");
  assert.equal(siteDomain("http://WWW.Foo.co.uk:8080/a"), "foo.co.uk");
  for (const bad of ["", null, "localhost", "a b", "javascript:alert(1)", "http://1"]) assert.equal(siteDomain(bad), undefined, String(bad));
});

/** Runs the page's own script against a stub DOM; returns how many orders it created and the page's state. */
async function runPageScript(html: string, nav: { type: string }, orderResponse: { ok: boolean; json: unknown } = { ok: true, json: { mode: "h5", url: "https://wx.example/pay" } }) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  const classes = new Set<string>(), el = (extra = {}) => ({ disabled: false, textContent: "", classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) }, ...extra });
  const btn = el(), err = el(), listeners: Record<string, (e: { persisted: boolean }) => void> = {};
  const location = { href: "" }; let orders = 0;
  const context = {
    document: { getElementById: (id: string) => id === "pay" ? btn : err }, location,
    performance: { getEntriesByType: () => [nav] }, addEventListener: (name: string, fn: (e: { persisted: boolean }) => void) => { listeners[name] = fn; },
    fetch: async () => { orders++; return { ok: orderResponse.ok, json: async () => orderResponse.json }; }
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  return { orders: () => orders, btn, err, classes, location, pageshow: (persisted: boolean) => listeners.pageshow!({ persisted }), click: () => (btn as unknown as { onclick: () => Promise<void> }).onclick() };
}

test("auto-start: a fresh load creates one order and redirects; back navigation and bfcache restore do not create another", async () => {
  const s = await serve();
  try {
    const html = await (await fetch(s.base + q())).text();

    const fresh = await runPageScript(html, { type: "navigate" });
    assert.equal(fresh.orders(), 1, "one order on load");
    assert.equal(fresh.location.href, "https://wx.example/pay");
    assert.ok(fresh.classes.has("busy"), "the spinner stays until the redirect");
    fresh.pageshow(false);
    assert.equal(fresh.orders(), 1, "a pageshow that is not a restore starts nothing");
    fresh.pageshow(true);
    assert.equal(fresh.orders(), 1, "a bfcache restore does not start an order");
    assert.equal(fresh.btn.disabled, false, "and shows the button");
    assert.ok(!fresh.classes.has("busy"));
    await fresh.click();
    assert.equal(fresh.orders(), 2, "the button is a manual retry");

    const back = await runPageScript(html, { type: "back_forward" });
    assert.equal(back.orders(), 0, "back navigation shows the button, creates no order");
    assert.equal(back.btn.disabled, false);

    const failed = await runPageScript(html, { type: "navigate" }, { ok: false, json: { error: "下单失败" } });
    assert.equal(failed.orders(), 1);
    assert.equal(failed.err.textContent, "下单失败");
    assert.equal(failed.btn.disabled, false, "a failed auto-start re-enables the button");
    assert.ok(!failed.classes.has("busy"));
  } finally { s.close(); }
});

test("the order stores the buyer's name with the pending code; an invalid name is dropped; the paid order's mail gets it", async () => {
  const created: Array<Record<string, unknown>> = [], mailed: Array<Record<string, unknown>> = [];
  const pay = new HatchPay({
    capabilities: new InMemoryProductCapabilities([[PRODUCT, "access_code"]]), publicBase: "https://anyteach.cn/hatch-pay", priceFen: 1,
    wechat: {
      ready: () => true, createH5Order: async () => ({ h5Url: "https://wx.example/pay?a=1" }),
      queryOrder: async (outTradeNo: string) => ({ outTradeNo, tradeState: "SUCCESS", transactionId: "42", amountFen: 1 })
    },
    codes: {
      createPending: async (input: Record<string, unknown>) => { created.push(input); return { code: "MSC222222", outTradeNo: `hp${"a".repeat(24)}` }; },
      order: async () => ({ productId: PRODUCT, email: "a@b.co" }),
      activatePaid: async () => ({ code: "MSC222222", productId: PRODUCT, email: "a@b.co", name: "王小明", status: "active", source: "paid", activated: true })
    },
    openids: {}, mailer: { send: async (input: Record<string, unknown>) => { mailed.push(input); } }
  } as unknown as ConstructorParameters<typeof HatchPay>[0]);
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), pay));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay`;
  const order = (name: unknown) => fetch(`${base}/order`, { method: "POST", headers: { "content-type": "application/json", origin: "https://anyteach.cn", "x-real-ip": "198.51.100.4" }, body: JSON.stringify({ product: PRODUCT, email: "a@b.co", back: BACK, name }) });
  try {
    assert.equal((await order(" 王小明 ")).status, 200);
    assert.equal(created[0]!.name, "王小明");
    assert.equal((await order("x".repeat(41))).status, 200);
    assert.equal("name" in created[1]!, false, "an over-long name is not stored");
    assert.equal((await order(undefined)).status, 200);
    assert.equal("name" in created[2]!, false);
    await fetch(`${base}/return?${new URLSearchParams({ o: `hp${"a".repeat(24)}`, back: BACK })}`, { redirect: "manual" });
    assert.deepEqual(mailed, [{ code: "MSC222222", productId: PRODUCT, to: "a@b.co", name: "王小明" }]);
  } finally { server.closeAllConnections(); server.close(); }
});
