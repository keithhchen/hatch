import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { MERCHANT, NO, PHONE, PRODUCT, DESKTOP, pageData, serve } from "./orderPage.testkit.js";
import { WeChatPayError } from "./wechatPay.js";

const GATHER = { origin: "https://gethatchapp.com", "content-type": "application/json" };
const NEW = { product: PRODUCT, email: " a@b.co ", name: " 王小明 ", locale: "en" };

test("POST /new makes a pending order for /c: only from Hatch's pages, validated, no WeChat call; returns the order page's URL", async () => {
  const s = await serve();
  try {
    assert.equal((await s.post("/new", NEW, { "content-type": "application/json" })).status, 403);
    assert.equal((await s.post("/new", NEW, MERCHANT)).status, 403, "anyteach.cn's own pages do not make orders");
    assert.equal((await s.post("/new", NEW, { origin: "https://gethatchapp.com.evil.example", "content-type": "application/json" })).status, 403);
    assert.equal((await s.post("/new", { ...NEW, email: "nope" }, GATHER)).status, 400);
    assert.equal((await s.post("/new", { ...NEW, product: "x" }, GATHER)).status, 400);
    assert.equal((await s.post("/new", { ...NEW, product: "11111111-2222-4333-8444-555555555555" }, GATHER)).status, 403, "no access_code capability");
    assert.equal(s.created.length, 0);

    const res = await s.post("/new", NEW, GATHER);
    assert.equal(res.status, 200);
    const body = await res.json() as { order_no: string; url: string };
    assert.match(body.order_no, /^hp[0-9a-f]{24}$/);
    assert.equal(body.url, `https://anyteach.cn/hatch-pay/o/${body.order_no}`);
    assert.deepEqual(s.created, [{ productId: PRODUCT, email: "a@b.co", name: "王小明", locale: "en" }], "trimmed, and no pay channel yet");
    assert.deepEqual([s.made.native.length, s.made.h5.length], [0, 0], "WeChat was never asked");

    await s.post("/new", { product: PRODUCT, email: "a@b.co", name: "x".repeat(41), locale: "xx" }, GATHER);
    assert.deepEqual(s.created[1], { productId: PRODUCT, email: "a@b.co", locale: "zh" }, "an over-long name is dropped, an unknown language is Chinese");
    const refused = await s.post("/new", { ...NEW, email: "nope" }, GATHER);
    assert.deepEqual(await refused.json(), { error: { code: "invalid_order", message: "Invalid link" } });
  } finally { s.close(); }
});

test("a pending order's page: lockup, product, the order number with Unpaid, the email, the price; no website or name rows; auto-start", async () => {
  const s = await serve();
  try {
    s.seed({ name: "<b>陈</b>" });
    const { res, html } = await s.page();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("referrer-policy"), "origin");
    assert.match(html, /hatch-downloads\.oss-cn-shanghai\.aliyuncs\.com\/brand\/msc\/msc-logo-black\.png/);
    assert.match(html, /gethatchapp\.com\/assets\/web\/hatch-lockup\.svg/);
    assert.match(html, /aria-label="MSC × Hatch"/);
    assert.match(html, /<h1>出海官网获客诊断<\/h1>/);
    assert.doesNotMatch(html, /MSC咨询/, "the lockup carries the expert");
    assert.match(html, new RegExp(`<dt>订单号</dt><dd><span class="no" id="no">${NO}</span>`));
    assert.match(html, /<span class="pill" id="pill">待支付<\/span>/);
    assert.match(html, /<dt>邮箱<\/dt><dd>a@b\.co<\/dd>/);
    assert.match(html, /¥9\.90/);
    assert.doesNotMatch(html, /网站|姓名|兑换码发送至|陈|MSC222222/, "no site or name row, and the access code is never shown");
    assert.match(html, /data-s="unpaid"/);
    assert.deepEqual(pageData(html), { s: "unpaid", pay: `https://anyteach.cn/hatch-pay/o/${NO}/pay`, renew: `https://anyteach.cn/hatch-pay/o/${NO}/renew`, status: `https://anyteach.cn/hatch-pay/status?o=${NO}`, order: `https://anyteach.cn/hatch-pay/o/${NO}`, left: 15 * 60_000, url: null, conf: false, auto: true });
    assert.match(html, /@font-face\{font-family:"DM Sans Variable".*https:\/\/anyteach\.cn\/hatch-pay\/font\/dm-sans-latin-wght-normal\.woff2/);
    assert.match(html, /prefers-reduced-motion:reduce/);
    // Reading an order changes nothing: no WeChat order, no new row.
    assert.deepEqual([s.made.native.length, s.made.h5.length, s.orders.size], [0, 0, 1]);
  } finally { s.close(); }
});

test("without a Product Corpus the card still shows the order and price, with no invented product name", async () => {
  const s = await serve({ withCorpora: false });
  try {
    s.seed();
    const { html } = await s.page();
    assert.match(html, /¥9\.90/);
    assert.doesNotMatch(html, /<h1>/);
  } finally { s.close(); }
});

test("an unknown or malformed order is a 404 page and asks WeChat nothing", async () => {
  const s = await serve();
  try {
    assert.equal((await s.page(`/o/hp${"c".repeat(24)}`)).res.status, 404);
    assert.equal((await s.page("/o/nope")).res.status, 404);
    assert.equal((await s.page(`/o/${NO}/other`)).res.status, 404);
    assert.equal((await s.page("/?product=x")).res.status, 404, "the query-parameter pay page is gone");
  } finally { s.close(); }
});

test("?r=1 (back from WeChat's cashier) shows the confirm line and does not auto-start; the same order is shown every time", async () => {
  const s = await serve();
  try {
    s.seed();
    const back = pageData((await s.page(`/o/${NO}?r=1`)).html);
    assert.deepEqual([back.conf, back.auto, back.s], [true, false, "unpaid"]);
    const again = (await s.page()).html, other = (await s.page(`/o/${NO}`, { "user-agent": PHONE })).html;
    assert.equal(again.replace(/\s/g, ""), other.replace(/\s/g, ""), "another browser sees the same order");
  } finally { s.close(); }
});

test("a paid order: WeChat's SUCCESS settles it once; the page says Paid and goes to /c with the code; a reload settles nothing more", async () => {
  const s = await serve();
  try {
    s.seed({ name: "王小明" });
    s.trade.state = "SUCCESS";
    const first = await s.page();
    const data = pageData(first.html);
    assert.deepEqual([data.s, data.url, data.auto], ["paid", "https://gethatchapp.com/c/?code=MSC222222", false]);
    assert.match(first.html, /<span class="pill" id="pill">已支付<\/span>/);
    assert.equal(s.orders.get(NO)!.status, "active");
    await s.page(); await s.page(`/o/${NO}?r=1`);
    assert.deepEqual(s.activations, [NO], "activated once");
    // Later the order is already paid: no WeChat question at all.
    s.trade.state = "NOTPAY";
    assert.equal(pageData((await s.page()).html).s, "paid");
    s.orders.get(NO)!.status = "used";
    assert.equal(pageData((await s.page()).html).s, "paid");
  } finally { s.close(); }
});

test("an expired order (15 minutes after it was made, not paid at WeChat): the pill says Expired and the pay button is not offered", async () => {
  const s = await serve();
  try {
    s.seed();
    s.clock.now = new Date(s.clock.now.getTime() + 15 * 60_000);
    const { html } = await s.page();
    assert.match(html, /data-s="expired"/);
    assert.match(html, /<span class="pill" id="pill">已过期<\/span>/);
    assert.deepEqual([pageData(html).s, pageData(html).auto, pageData(html).left], ["expired", false, 0]);
    assert.match(html, /\[data-s=expired\] #pay/);
    // Paid at WeChat in time: not expired, whatever the clock says.
    s.trade.state = "SUCCESS";
    assert.equal(pageData((await s.page()).html).s, "paid");
  } finally { s.close(); }
});

test("POST /pay makes the WeChat order for THIS number: same out_trade_no, same amount, same deterministic expiry on every call", async () => {
  const s = await serve();
  try {
    s.seed();
    const desktop = { ...MERCHANT, "user-agent": DESKTOP };
    const a = await (await s.post(`/o/${NO}/pay`, {}, desktop)).json() as Record<string, string>;
    s.clock.now = new Date(s.clock.now.getTime() + 5 * 60_000);
    const b = await (await s.post(`/o/${NO}/pay`, {}, desktop)).json() as Record<string, string>;
    assert.deepEqual([a.mode, b.mode], ["native", "native"]);
    assert.match(a.qrSvg!, /^<svg /);
    assert.equal(s.made.native.length, 2);
    assert.deepEqual(s.made.native[0], { outTradeNo: NO, description: "Hatch 兑换码", amountFen: 990, expiresAt: new Date("2026-11-27T10:15:00Z") });
    assert.deepEqual(s.made.native[1], s.made.native[0], "a repeat is the same request, not 'now + 15 minutes'");
    assert.equal(s.orders.size, 1, "paying makes no new order");

    const phone = await (await s.post(`/o/${NO}/pay`, {}, { ...MERCHANT, "user-agent": PHONE, "x-real-ip": "198.51.100.4" })).json() as { mode: string; url: string };
    assert.equal(phone.mode, "h5");
    assert.equal(new URL(phone.url).searchParams.get("redirect_url"), `https://anyteach.cn/hatch-pay/o/${NO}?r=1`, "WeChat's cashier returns to the same order");
    assert.deepEqual(s.made.h5[0], { ...s.made.native[0], payerIp: "198.51.100.4" });
    assert.equal((await s.post(`/o/${NO}/pay`, {}, { ...MERCHANT, "user-agent": PHONE })).status, 400, "no address, no H5 order");
    assert.equal((await s.post(`/o/${NO}/pay`, {}, { "content-type": "application/json" })).status, 403, "only from the merchant's page");
    assert.equal((await s.post(`/o/hp${"c".repeat(24)}/pay`, {}, MERCHANT)).status, 404);

    const jsapi = await (await s.post(`/o/${NO}/pay`, { openid: "oX" }, MERCHANT)).json() as { mode: string };
    assert.equal(jsapi.mode, "jsapi");
    assert.equal(s.made.jsapi[0]!.openid, "oX");
  } finally { s.close(); }
});

test("POST /pay on an order that cannot be paid: expired, paid, or refused by WeChat as used or closed, all without a new order; other WeChat errors are retryable", async () => {
  const s = await serve();
  try {
    s.seed();
    const desktop = { ...MERCHANT, "user-agent": DESKTOP };
    s.trade.reject = new WeChatPayError(400, "OUT_TRADE_NO_USED", "used", null);
    const used = await s.post(`/o/${NO}/pay`, {}, desktop);
    assert.deepEqual([used.status, await used.json()], [409, { expired: true }]);
    s.trade.reject = new WeChatPayError(400, "ORDER_CLOSED", "closed", null);
    assert.deepEqual(await (await s.post(`/o/${NO}/pay`, {}, desktop)).json(), { expired: true });
    s.trade.reject = new WeChatPayError(500, "SYSTEMERROR", "down", null);
    const down = await s.post(`/o/${NO}/pay`, {}, desktop);
    assert.deepEqual([down.status, await down.json()], [409, { error: "下单失败，请稍后重试" }], "a business answer the proxy lets through, never a 5xx");
    s.trade.reject = new WeChatPayError(400, "INVALID_REQUEST", "其他参数错误", null);
    assert.equal((await s.post(`/o/${NO}/pay`, {}, desktop)).status, 409, "another INVALID_REQUEST is a plain failure");
    s.trade.reject = new WeChatPayError(400, "INVALID_REQUEST", "请求重入时，参数与首次请求时不一致", null);
    const elsewhere = await s.post(`/o/${NO}/pay`, {}, desktop);
    assert.deepEqual([elsewhere.status, await elsewhere.json()], [200, { elsewhere: true }], "first paid another way, now asked by a way with other parameters");
    s.trade.reject = undefined;
    s.clock.now = new Date(s.clock.now.getTime() + 15 * 60_000);
    assert.deepEqual(await (await s.post(`/o/${NO}/pay`, {}, desktop)).json(), { expired: true });
    s.orders.get(NO)!.status = "active";
    assert.deepEqual(await (await s.post(`/o/${NO}/pay`, {}, desktop)).json(), { paid: true });
    assert.equal(s.orders.size, 1);
  } finally { s.close(); }
});

test("POST /renew: only a pending order (expired, or started on another device); it makes a new one with the same Product, email, name and language and leaves the old one alone", async () => {
  const s = await serve();
  try {
    s.seed({ name: "王小明", locale: "ja" });
    assert.equal(s.created.length, 0);
    assert.equal((await s.post(`/o/${NO}/renew`, {}, { "content-type": "application/json" })).status, 403);
    const res = await s.post(`/o/${NO}/renew`, {}, MERCHANT);
    assert.equal(res.status, 200);
    const { url } = await res.json() as { url: string };
    const created = [...s.orders.keys()].find(key => key !== NO)!;
    assert.equal(url, `https://anyteach.cn/hatch-pay/o/${created}`);
    assert.deepEqual(s.created, [{ productId: PRODUCT, email: "a@b.co", name: "王小明", locale: "ja" }]);
    assert.deepEqual([s.orders.get(NO)!.status, s.orders.get(NO)!.code], ["pending", "MSC222222"], "the old order is untouched");
    assert.equal(pageData((await s.page(`/o/${created}`)).html).s, "unpaid", "the new order is a fresh one");
    s.orders.get(NO)!.status = "active";
    assert.equal((await s.post(`/o/${NO}/renew`, {}, MERCHANT)).status, 409, "a paid order is not renewed");
    assert.equal((await s.post(`/o/hp${"c".repeat(24)}/renew`, {}, MERCHANT)).status, 404);
  } finally { s.close(); }
});

test("/return (orders made before the order page) is a 302 to the order's page with ?r=1", async () => {
  const s = await serve();
  try {
    const res = await fetch(`${s.base}/return?${new URLSearchParams({ o: NO, back: "https://gethatchapp.com/c/", locale: "en" })}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://anyteach.cn/hatch-pay/o/${NO}?r=1`);
    assert.equal((await fetch(`${s.base}/return?o=bogus`, { redirect: "manual" })).status, 400);
  } finally { s.close(); }
});

test("/status says whether WeChat has the order paid and, when it does, settles it (idempotently) and says where to go; unknown is 404", async () => {
  const s = await serve();
  try {
    s.seed();
    const status = async (o = NO) => fetch(`${s.base}/status?o=${o}`);
    assert.deepEqual(await (await status()).json(), { paid: false });
    s.trade.state = "SUCCESS";
    assert.deepEqual(await (await status()).json(), { paid: true, url: "https://gethatchapp.com/c/?code=MSC222222" });
    await status();
    assert.deepEqual(s.activations, [NO]);
    assert.equal((await status(`hp${"c".repeat(24)}`)).status, 404);
    assert.equal((await status("x")).status, 404);
  } finally { s.close(); }
});

test("the font is served same-origin: woff2, cached for a year, only that file", async () => {
  const s = await serve();
  try {
    const res = await fetch(`${s.base}/font/dm-sans-latin-wght-normal.woff2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(new TextDecoder().decode((await res.arrayBuffer()).slice(0, 4)), "wOF2");
    assert.equal((await fetch(`${s.base}/font/other.woff2`)).status, 404);
  } finally { s.close(); }
});

test("WeChat's browser gets only the guide out of it, in the order's language: no order page, no WeChat call", async () => {
  const s = await serve();
  try {
    s.seed({ locale: "en" });
    const { html } = await s.page(`/o/${NO}`, { "user-agent": "Mozilla/5.0 (iPhone) MicroMessenger/8.0" });
    assert.match(html, /Open in browser/);
    assert.doesNotMatch(html, /<button|订单号/);
    assert.equal((await s.post(`/o/${NO}/pay`, {}, { ...MERCHANT, "user-agent": "MicroMessenger/8.0" })).status, 403);
    assert.deepEqual([s.made.native.length, s.made.h5.length], [0, 0]);
  } finally { s.close(); }
});

/** Runs the page's own script against a stub DOM. `answers` are the JSON the server gives to /pay, /status and /renew. */
async function runPageScript(html: string, nav: { type: string }, answers: { pay?: { ok: boolean; json: unknown }; status?: unknown; renew?: { ok: boolean; json: unknown } } = {}) {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
  const timers: Array<() => void> = [], calls: string[] = [];
  const classes = new Set<string>();
  const el = (extra: Record<string, unknown> = {}) => ({ disabled: false, textContent: "", innerHTML: "", style: {} as Record<string, string>, dataset: {} as Record<string, string>, classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c), contains: (c: string) => classes.has(c) }, ...extra });
  const els: Record<string, ReturnType<typeof el>> = { card: el({ dataset: { s: /data-s="(\w+)"/.exec(html)![1]! } }), pay: el(), err: el(), qr: el(), pill: el(), renew: el(), cp: el(), no: el({ textContent: NO }) };
  const listeners: Record<string, (e: { persisted: boolean }) => void> = {}, location = { href: "", replace: (u: string) => { location.href = u; } };
  const copied: string[] = [];
  const context = {
    document: { getElementById: (id: string) => els[id] }, location, setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; }, setInterval: () => 0, clearInterval: () => undefined,
    navigator: { clipboard: { writeText: async (text: string) => { copied.push(text); } } },
    performance: { getEntriesByType: () => [nav] }, addEventListener: (name: string, fn: (e: { persisted: boolean }) => void) => { listeners[name] = fn; },
    fetch: async (url: string) => {
      calls.push(url);
      const answer = url.endsWith("/pay") ? answers.pay ?? { ok: true, json: { mode: "h5", url: "https://wx.example/pay" } } : url.endsWith("/renew") ? answers.renew ?? { ok: true, json: { url: "https://anyteach.cn/hatch-pay/o/hpnew" } } : { ok: true, json: answers.status ?? { paid: false } };
      return { ok: answer.ok, json: async () => answer.json };
    }
  };
  vm.runInNewContext(script, context);
  await new Promise(resolve => setImmediate(resolve));
  const { pay, err, card, pill, renew, cp } = els;
  return { els, pay, err, card, pill, renew, cp, location, calls, timers, copied, classes, pageshow: (persisted: boolean) => listeners.pageshow!({ persisted }), click: () => (pay as unknown as { onclick: () => Promise<void> }).onclick(), renewClick: () => (renew as unknown as { onclick: () => Promise<void> }).onclick(), copyClick: () => (cp as unknown as { onclick: () => void }).onclick() };
}

test("the page script: a fresh load starts one payment and goes to WeChat; back navigation, ?r=1 and a bfcache restore start none; the button is a manual retry", async () => {
  const s = await serve();
  try {
    s.seed();
    const html = (await s.page()).html;
    const fresh = await runPageScript(html, { type: "navigate" });
    assert.deepEqual(fresh.calls, [`https://anyteach.cn/hatch-pay/o/${NO}/pay`], "one POST on load, to this order's pay URL");
    assert.equal(fresh.location.href, "https://wx.example/pay");
    assert.ok(fresh.classes.has("busy"), "the spinner stays until the redirect");
    fresh.pageshow(true);
    assert.equal(fresh.calls.length, 1, "a bfcache restore does not start a payment");
    assert.ok(!fresh.classes.has("busy"));
    await fresh.click();
    assert.equal(fresh.calls.length, 2);

    assert.equal((await runPageScript(html, { type: "back_forward" })).calls.length, 0);
    const returned = await runPageScript((await s.page(`/o/${NO}?r=1`)).html, { type: "navigate" });
    assert.ok(!returned.calls.some(url => url.endsWith("/pay")), "?r=1 never auto-starts");
    assert.match(returned.err.innerHTML, /mini.*正在确认支付结果/);
    assert.ok(!returned.classes.has("busy"), "the button stays free");

    const failed = await runPageScript(html, { type: "navigate" }, { pay: { ok: false, json: { error: "下单失败" } } });
    assert.equal(failed.err.textContent, "下单失败");
    assert.ok(!failed.classes.has("busy"));
  } finally { s.close(); }
});

test("the page script: the confirm line polls /status; paid turns the pill to Paid and goes to /c with the code; the order expiring shows Expired and Order again", async () => {
  const s = await serve();
  try {
    s.seed();
    const confirm = await runPageScript((await s.page(`/o/${NO}?r=1`)).html, { type: "navigate" }, { status: { paid: true, url: "https://gethatchapp.com/c/?code=MSC222222" } });
    assert.equal(confirm.calls[0], `https://anyteach.cn/hatch-pay/status?o=${NO}`);
    assert.equal(confirm.card.dataset.s, "paid");
    assert.equal(confirm.pill.textContent, "已支付");
    assert.match(confirm.els.qr!.innerHTML, /支付成功/);
    confirm.timers.at(-1)!();
    assert.equal(confirm.location.href, "https://gethatchapp.com/c/?code=MSC222222");

    const fresh = await runPageScript((await s.page()).html, { type: "back_forward" });
    fresh.timers[0]!();
    assert.deepEqual([fresh.card.dataset.s, fresh.pill.textContent], ["expired", "已过期"], "the clock running out expires the page");

    const gone = await runPageScript((await s.page()).html, { type: "navigate" }, { pay: { ok: false, json: { expired: true } } });
    assert.deepEqual([gone.card.dataset.s, gone.pill.textContent], ["expired", "已过期"], "WeChat refusing the order expires it too");

    await fresh.renewClick();
    assert.deepEqual(fresh.calls.at(-1), `https://anyteach.cn/hatch-pay/o/${NO}/renew`);
    assert.equal(fresh.location.href, "https://anyteach.cn/hatch-pay/o/hpnew");
    s.trade.state = "SUCCESS";
    const already = await runPageScript((await s.page()).html, { type: "navigate" });
    assert.equal(already.card.dataset.s, "paid");
    assert.equal(already.calls.length, 0, "a paid order starts no payment");
    already.timers.at(-1)!();
    assert.equal(already.location.href, "https://gethatchapp.com/c/?code=MSC222222", "re-opening a paid order goes to the code again");
  } finally { s.close(); }
});

test("the page script: 'started on another device' keeps the pill Unpaid, says so in the language, and offers Order again in place of the pay button", async () => {
  const s = await serve();
  try {
    for (const [locale, line] of [["zh", "此订单已在其他设备上发起支付"], ["en", "This order was started on another device"], ["ja", "この注文は別の端末で支払いが開始されています"]] as const) {
      s.seed({ locale });
      const page = await runPageScript((await s.page()).html, { type: "navigate" }, { pay: { ok: true, json: { elsewhere: true } } });
      assert.equal(page.err.textContent, line, locale);
      assert.equal(page.card.dataset.s, "unpaid", "the order is still unpaid");
      assert.equal(page.card.dataset.e, "1", "CSS swaps the pay button for the renew button");
      assert.ok(!page.classes.has("busy"));
    }
    const failed = await runPageScript((await s.page()).html, { type: "navigate" }, { pay: { ok: false, json: { error: "下单失败，请稍后重试" } } });
    assert.equal(failed.err.textContent, "下单失败，请稍后重试", "a business error is shown as the server wrote it");
  } finally { s.close(); }
});

test("the page script: the copy button copies the order number and says so", async () => {
  const s = await serve();
  try {
    s.seed();
    const page = await runPageScript((await s.page()).html, { type: "back_forward" });
    page.copyClick();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(page.copied, [NO]);
    assert.equal(page.cp.textContent, "已复制");
  } finally { s.close(); }
});
