import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { PostgresAccessCodes } from "../accessCodes/postgresAccessCodes.js";
import { AccessCodeMailer, type ProductMailInfos, type PromptRows } from "./codeMail.js";
import type { EmailMessage, EmailSender } from "./email.js";
import { HatchPay, handleHatchPayRoute } from "./routes.js";
import { WeChatOAuth } from "./wechatOAuth.js";
import { WeChatPayV3 } from "./wechatPay.js";
import { fakeWeChat, signedNotification, testKeys } from "./wechatPay.testkit.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
const BACK = `https://gethatchapp.com/p/${PRODUCT}`;
const mailer = (sender: EmailSender) => new AccessCodeMailer({
  sender, from: "Hatch <noreply@gethatchapp.com>", priceFen: 990,
  prompts: { get: async name => name.endsWith("-subject") ? "码 {{code}}" : "<p>{{product_name}} {{amount}} <a href=\"{{code_url}}\">{{code}}</a></p>" } satisfies PromptRows,
  products: { describe: async () => ({ productName: "网站诊断" }) } satisfies ProductMailInfos
});
/** A phone: a desktop browser gets a Native QR, not H5. */
const ORIGIN = { origin: "https://anyteach.cn", "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" };
const FROM_C = { origin: "https://gethatchapp.com" };

async function isolated() {
  const schema = `paycodes_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}`, statement_timeout: 10_000, max: 8 });
  const codes = new PostgresAccessCodes(pool, 990);
  await codes.initialize();
  return { pool, codes, close: async () => { await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); } };
}

async function withDb(body: (db: Awaited<ReturnType<typeof isolated>>) => Promise<void>) {
  const db = await isolated();
  try { await body(db); } finally { await db.close(); }
}

/** The whole pay stack against a fake WeChat: a real HTTP server for the routes, a fake server for WeChat and its OAuth. */
async function harness(db: Awaited<ReturnType<typeof isolated>>) {
  const keys = testKeys(), mails: EmailMessage[] = [];
  const trades = new Map<string, Record<string, unknown>>(), refusals = new Map<string, { status: number; code: string; message: string }>();
  const wechat = await fakeWeChat(request => {
    const refused = [...refusals].find(([path]) => request.url.startsWith(path))?.[1];
    if (refused) return { status: refused.status, body: { code: refused.code, message: refused.message } };
    if (request.url.startsWith("/v3/pay/transactions/h5")) return { body: { h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx1&package=1" } };
    if (request.url.startsWith("/v3/pay/transactions/jsapi")) return { body: { prepay_id: "wx-prepay" } };
    if (request.url.startsWith("/sns/oauth2/access_token")) return { body: { openid: "oFake", access_token: "t" } };
    const no = /out-trade-no\/([^?]+)/.exec(request.url)?.[1] ?? "";
    return trades.has(no) ? { body: trades.get(no) } : { body: { trade_state: "NOTPAY", out_trade_no: no } };
  });
  const email: EmailSender = { send: async message => { mails.push(message); return { id: `mail-${mails.length}` }; } };
  const publicBase = "https://anyteach.cn/hatch-pay";
  const pay = new HatchPay({
    capabilities: new InMemoryProductCapabilities([[PRODUCT, "access_code"]]), codes: db.codes, mailer: mailer(email), publicBase, priceFen: 990,
    wechat: new WeChatPayV3(keys.config, { hosts: [wechat.url], log: () => undefined }),
    openids: new WeChatOAuth("wxtestappid", "secret", { apiBase: wechat.url })
  });
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), pay));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { redirect: "manual", headers });
  const create = async (body: Record<string, unknown>, headers: Record<string, string> = FROM_C) =>
    fetch(`${base}/new`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ product: PRODUCT, email: "a@b.co", ...body }) });
  const newOrder = async (body: Record<string, unknown> = {}) => ((await (await create(body)).json()) as { order_no: string }).order_no;
  const payOrder = (no: string, body: Record<string, unknown> = {}, headers: Record<string, string> = ORIGIN) =>
    fetch(`${base}/o/${no}/pay`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const renew = (no: string) => fetch(`${base}/o/${no}/renew`, { method: "POST", headers: { "content-type": "application/json", ...ORIGIN }, body: "{}" });
  const pay_ = (outTradeNo: string, extra: Record<string, unknown> = {}) =>
    trades.set(outTradeNo, { trade_state: "SUCCESS", out_trade_no: outTradeNo, transaction_id: `42${outTradeNo}`, mchid: "1639838957", amount: { total: 990 }, ...extra });
  const notify = (transaction: Record<string, unknown>, tweak?: (n: ReturnType<typeof signedNotification>) => void) => {
    const n = signedNotification({ platformPrivatePem: keys.platformPrivatePem, transaction });
    tweak?.(n);
    return fetch(`${base}/notify`, { method: "POST", headers: { "content-type": "application/json", ...n.headers }, body: n.body });
  };
  return { mails, get, create, newOrder, pay: payOrder, renew, pay_, notify, wechat: Object.assign(wechat, { fail: (path: string, status: number, code: string, message = code) => void refusals.set(path, { status, code, message }) }), base, trades, close: async () => { server.closeAllConnections(); server.close(); await wechat.close(); } };
}

const run = (name: string, body: Parameters<typeof withDb>[0]) => connectionString ? test(name, () => withDb(body)) : test(name, { skip: "needs HATCH_TEST_DATABASE_URL" }, () => undefined);

const activeCode = async (db: Awaited<ReturnType<typeof isolated>>, code: string, productId = PRODUCT) =>
  void await db.pool.query("INSERT INTO hatch_access_codes (code, product_id, status) VALUES ($1, $2, 'active')", [code, productId]);

run("redeem from two conversations at once: exactly one wins", async db => {
  await activeCode(db, "MSC048213");
  const results = await Promise.all(["c1", "c2", "c3", "c4"].map(conversationId => db.codes.redeem({ code: "MSC048213", productId: PRODUCT, conversationId })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(results.filter(r => !r.ok), [{ ok: false, reason: "used" }, { ok: false, reason: "used" }, { ok: false, reason: "used" }]);
  const winner = (await db.codes.peek(" msc048213 "))!;
  assert.equal(winner.status, "used");
  assert.deepEqual(await db.codes.lookup(" msc048213 "), { status: "used", source: "free", productId: PRODUCT, conversationId: winner.usedByConversationId, outcome: null });
  assert.equal(await db.codes.lookup("MSC000000"), null);
  // The same conversation redeeming again is the same redeem.
  assert.deepEqual(await db.codes.redeem({ code: "MSC048213", productId: PRODUCT, conversationId: winner.usedByConversationId! }), { ok: true });
});

run("redeem says why not: not_found, not_paid, wrong_product, void", async db => {
  assert.deepEqual(await db.codes.redeem({ code: "MSC333333", productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "not_found" });
  const { code } = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  assert.deepEqual(await db.codes.redeem({ code, productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "not_paid" });
  await activeCode(db, "MSC111111", "other-product");
  assert.deepEqual(await db.codes.redeem({ code: "MSC111111", productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "wrong_product" });
  await db.pool.query("INSERT INTO hatch_access_codes (code, product_id, status) VALUES ('MSC222222', $1, 'void')", [PRODUCT]);
  assert.deepEqual(await db.codes.redeem({ code: "MSC222222", productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "not_found" });
});

run("createPending draws a typable 8-character code and a unique trade number", async db => {
  const a = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co", payChannel: "h5" }), b = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  assert.match(a.code, /^MSC[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
  assert.equal((await db.codes.peek(a.code))!.source, "paid");
  assert.notEqual(a.outTradeNo, b.outTradeNo);
  assert.equal((await db.codes.peek(a.code))!.status, "pending");
});

run("the visitor's language and name are kept with the pending code and come back on activation, once", async db => {
  const { outTradeNo } = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co", name: "Ann", locale: "ja" });
  const { outTradeNo: plain } = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  assert.equal((await db.codes.order(outTradeNo))!.locale, "ja");
  assert.equal((await db.codes.order(plain))!.locale, null, "no language is stored as none: the mail is Chinese");
  const first = await db.codes.activatePaid({ outTradeNo, transactionId: "42001", amountFen: 990 });
  assert.deepEqual([first!.activated, first!.locale, first!.name], [true, "ja", "Ann"]);
  assert.equal((await db.codes.activatePaid({ outTradeNo, transactionId: "42001", amountFen: 990 }))!.locale, "ja");
  await assert.rejects(db.pool.query("UPDATE hatch_access_codes SET locale = 'fr' WHERE out_trade_no = $1", [outTradeNo]), /check/);
});

run("activatePaid twice at once activates once; a repeat and a wrong amount activate nothing", async db => {
  const { outTradeNo } = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  const paid = { outTradeNo, transactionId: "42000", amountFen: 990 };
  const results = await Promise.all([db.codes.activatePaid(paid), db.codes.activatePaid(paid)]);
  assert.equal(results.filter(r => r!.activated).length, 1);
  assert.ok(results.every(r => r!.status === "active"));
  assert.equal((await db.codes.activatePaid(paid))!.activated, false);

  const short = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  const refused = await db.codes.activatePaid({ outTradeNo: short.outTradeNo, transactionId: "1", amountFen: 1 });
  assert.deepEqual([refused!.activated, refused!.status], [false, "pending"]);
  assert.equal(await db.codes.activatePaid({ outTradeNo: "hpunknown", transactionId: "1", amountFen: 990 }), undefined);
});

run("order creation: /new only from Hatch's pages; the pending order keeps email, name and language and asks WeChat nothing", async db => {
  const h = await harness(db);
  try {
    assert.equal((await h.create({}, {})).status, 403);
    assert.equal((await h.create({}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await h.create({}, { origin: "https://anyteach.cn" })).status, 403);
    assert.equal((await h.create({ email: "nope" })).status, 400);
    assert.equal((await db.pool.query("SELECT 1 FROM hatch_access_codes")).rows.length, 0);

    const no = await h.newOrder({ name: " 王小明 ", locale: "en" });
    assert.match(no, /^hp[0-9a-f]{24}$/);
    const order = (await db.codes.order(no))!;
    assert.deepEqual([order.status, order.email, order.name, order.locale, order.amountFen], ["pending", "a@b.co", "王小明", "en", 990]);
    assert.ok(Math.abs(order.createdAt.getTime() - Date.now()) < 10_000);
    assert.equal(h.wechat.requests.length, 0, "creating an order never calls WeChat");
    assert.equal((await db.pool.query("SELECT pay_channel FROM hatch_access_codes")).rows[0].pay_channel, null);
  } finally { await h.close(); }
});

run("paying an order: H5 sends the first forwarded hop and returns to the same order; a repeat is the same WeChat order with the same expiry", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    assert.equal((await h.pay(no, {}, {})).status, 403, "only from the merchant's page");
    assert.equal((await h.pay(no, {}, { referer: "https://anyteach.cn.evil.example/x" })).status, 403);
    assert.equal((await h.pay(no, {}, { ...ORIGIN })).status, 400, "no forwarded address, no H5 order");

    const response = await h.pay(no, {}, { ...ORIGIN, "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    assert.equal(response.status, 200);
    const body = await response.json() as { mode: string; url: string };
    assert.equal(body.mode, "h5");
    const sent = () => h.wechat.requests.filter(r => r.url === "/v3/pay/transactions/h5").map(r => JSON.parse(r.body));
    assert.equal(sent()[0].scene_info.payer_client_ip, "203.0.113.9");
    assert.equal(sent()[0].out_trade_no, no);
    assert.equal(sent()[0].amount.total, 990);
    assert.equal(new URL(body.url).searchParams.get("redirect_url"), `https://anyteach.cn/hatch-pay/o/${no}?r=1`);
    const createdAt = (await db.codes.order(no))!.createdAt.getTime();
    assert.equal(Date.parse(sent()[0].time_expire), Math.floor((createdAt + 15 * 60_000) / 1000) * 1000, "created_at + 15 minutes, to the second");

    assert.equal((await h.pay(no, {}, { ...ORIGIN, "x-forwarded-for": "203.0.113.9" })).status, 200);
    assert.equal(sent()[1].time_expire, sent()[0].time_expire);
    assert.equal(sent()[1].out_trade_no, no);
    assert.equal((await db.pool.query("SELECT 1 FROM hatch_access_codes")).rows.length, 1, "paying twice made no second order");

    assert.equal((await h.pay(no, {}, { ...ORIGIN, "x-real-ip": "2001:db8::7", "x-forwarded-for": "203.0.113.9" })).status, 200);
    assert.equal(sent()[2].scene_info.payer_client_ip, "2001:db8::7", "X-Real-IP wins over X-Forwarded-For");
    assert.equal((await h.pay(no, {}, { ...ORIGIN, "x-real-ip": "bogus" })).status, 400, "an invalid address is no address");
  } finally { await h.close(); }
});

run("order page: a browser gets the price and the order number; an unknown order is 404; the OAuth return (kept for a later JSAPI flow) carries the openid into a JSAPI payment of the same order", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    const browser = await h.get(`/o/${no}`, { "user-agent": "Mozilla/5.0 Safari" });
    assert.equal(browser.status, 200);
    const html = await browser.text();
    assert.match(html, /¥9\.90/);
    assert.match(html, new RegExp(no));
    assert.doesNotMatch(html, /"openid":/);
    assert.equal((await h.get(`/o/hp${"0".repeat(24)}`)).status, 404);
    assert.equal((await h.get("/?product=x&email=bad&back=https://evil.example")).status, 404, "the old query-parameter pay page is gone");

    const oauth = await h.get(`/oauth?o=${no}&code=CODE&state=hatchpay`);
    assert.equal(oauth.status, 200);
    assert.match(await oauth.text(), /"openid":"oFake"/);
    assert.equal((await h.get(`/oauth?o=${no}`)).status, 400, "no code: not authorized");

    const body = await (await h.pay(no, { openid: "oFake" })).json() as { mode: string; params: { package: string; paySign: string } };
    assert.equal(body.mode, "jsapi");
    assert.equal(body.params.package, "prepay_id=wx-prepay");
    assert.ok(body.params.paySign);
    const sent = JSON.parse(h.wechat.requests.find(r => r.url === "/v3/pay/transactions/jsapi")!.body);
    assert.deepEqual([sent.payer.openid, sent.out_trade_no], ["oFake", no]);
  } finally { await h.close(); }
});

run("WeChat's browser gets only the guide out of it, in the order's language: no payment, no WeChat call; a phone browser still gets the H5 flow", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder({ locale: "en" });
    const wechatUa = { "user-agent": "Mozilla/5.0 (iPhone) MicroMessenger/8.0" };
    for (const path of [`/o/${no}`, `/oauth?o=${no}&code=CODE`, `/return?o=${no}`]) {
      const res = await h.get(path, wechatUa);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("location"), null);
      const html = await res.text();
      assert.match(html, path.startsWith("/o/") ? /Open in browser/ : /在浏览器打开/, "the order's own language where the link names the order");
      assert.doesNotMatch(html, /openid|<button/);
    }
    assert.equal((await h.pay(no, { openid: "oFake" }, { ...ORIGIN, ...wechatUa, "x-real-ip": "203.0.113.9" })).status, 403);
    assert.equal(h.wechat.requests.length, 0, "WeChat was never asked");

    const safari = await h.get(`/o/${no}`, { "user-agent": "Mozilla/5.0 (iPhone) Version/17 Mobile Safari/604.1" });
    assert.match(await safari.text(), /¥9\.90/);
    const paid = await h.pay(no, {}, { ...ORIGIN, "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile", "x-real-ip": "203.0.113.9" });
    assert.equal(((await paid.json()) as { mode: string }).mode, "h5");
  } finally { await h.close(); }
});

run("a Product without the access_code capability cannot be bought: /new refuses and no pending code is made", async db => {
  const h = await harness(db);
  try {
    assert.equal((await h.create({ product: "11111111-2222-4333-8444-555555555555" })).status, 403);
    assert.equal(h.wechat.requests.length, 0);
    assert.equal((await db.pool.query("SELECT 1 FROM hatch_access_codes")).rows.length, 0, "no pending code was made");
  } finally { await h.close(); }
});

run("order page: unpaid shows Unpaid and the code is not redeemable; paid settles once, mails once, goes to /c with the code, and the code is then redeemable", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    const waiting = await (await h.get(`/o/${no}?r=1`)).text();
    assert.match(waiting, /待支付/);
    assert.match(waiting, /"conf":true,"auto":false/);
    const { code } = await db.pool.query("SELECT code FROM hatch_access_codes").then(r => r.rows[0] as { code: string });
    assert.doesNotMatch(waiting, new RegExp(code), "the pending code is not on the page");
    assert.deepEqual(await db.codes.redeem({ code, productId: PRODUCT, conversationId: "c1" }), { ok: false, reason: "not_paid" }, "a pending code is not usable");
    assert.equal(h.mails.length, 0);

    h.pay_(no);
    const paid = await (await h.get(`/o/${no}`)).text();
    assert.match(paid, /已支付/);
    assert.ok(paid.includes(`"url":"https://gethatchapp.com/c/?code=${code}"`));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.mails.length, 1);
    assert.equal(h.mails[0]!.to, "a@b.co");
    assert.match(h.mails[0]!.text, new RegExp(`https://gethatchapp.com/c/${code}`));
    assert.equal(h.mails[0]!.subject, `码 ${code}`);
    assert.match(h.mails[0]!.html, /网站诊断 9\.90/);

    // Reopened, reloaded, or in a second browser: the same paid order, the same code, no second mail.
    for (let i = 0; i < 3; i++) assert.ok((await (await h.get(`/o/${no}`, { "user-agent": `Browser ${i}` })).text()).includes(`code=${code}`));
    assert.equal(h.mails.length, 1);
    assert.deepEqual(await db.codes.redeem({ code, productId: PRODUCT, conversationId: "c1" }), { ok: true });
  } finally { await h.close(); }
});

run("order page and /status and notify at once on a paid order: one activation, one email", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    h.pay_(no);
    const transaction = { trade_state: "SUCCESS", out_trade_no: no, transaction_id: `42${no}`, mchid: "1639838957", amount: { total: 990 } };
    const answers = await Promise.all([h.get(`/o/${no}`), h.get(`/o/${no}`), h.get(`/status?o=${no}`), h.notify(transaction), h.notify(transaction)]);
    assert.ok(answers.every(a => a.status === 200 || a.status === 204));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.mails.length, 1);
    assert.equal((await db.codes.order(no))!.status, "active");
    assert.deepEqual(await (await h.get(`/status?o=${no}`)).json(), { paid: true, url: `https://gethatchapp.com/c/?code=${(await db.codes.order(no))!.code}` });
  } finally { await h.close(); }
});

run("expired order: past created_at + 15 minutes it shows Expired and cannot be paid; renew makes a new pending order and leaves the old one alone", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder({ name: "Ann", locale: "ja" });
    await db.pool.query("UPDATE hatch_access_codes SET created_at = now() - interval '16 minutes' WHERE out_trade_no = $1", [no]);
    const html = await (await h.get(`/o/${no}`)).text();
    assert.match(html, /期限切れ/);
    assert.match(html, /"s":"expired","pay"/);
    const pay = await h.pay(no, {}, { ...ORIGIN, "x-real-ip": "203.0.113.9" });
    assert.deepEqual([pay.status, await pay.json()], [409, { expired: true }]);
    assert.equal(h.wechat.requests.filter(r => /transactions\/(h5|native|jsapi)/.test(r.url)).length, 0, "WeChat was not asked to take an expired order");

    const renewed = await h.renew(no);
    assert.equal(renewed.status, 200);
    const next = new URL(((await renewed.json()) as { url: string }).url).pathname.split("/").pop()!;
    assert.notEqual(next, no);
    const [old, fresh] = [await db.codes.order(no), await db.codes.order(next)];
    assert.deepEqual([old!.status, fresh!.status], ["pending", "pending"]);
    assert.deepEqual([fresh!.email, fresh!.name, fresh!.locale, fresh!.productId], ["a@b.co", "Ann", "ja", PRODUCT]);
    assert.notEqual(old!.code, fresh!.code);
    assert.match(await (await h.get(`/o/${next}`)).text(), /未払い/);

    // Paid at WeChat in time: the order is paid, whatever the clock says.
    h.pay_(no);
    assert.match(await (await h.get(`/o/${no}`)).text(), /支払い済み/);
    assert.equal((await h.renew(no)).status, 409, "a paid order is not renewed");
  } finally { await h.close(); }
});

run("WeChat refusing an order it already has (another way of paying) answers expired; the order itself is untouched", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    h.wechat.fail("/v3/pay/transactions/h5", 400, "OUT_TRADE_NO_USED");
    const res = await h.pay(no, {}, { ...ORIGIN, "x-real-ip": "203.0.113.9" });
    assert.deepEqual([res.status, await res.json()], [409, { expired: true }]);
    assert.equal((await db.codes.order(no))!.status, "pending");
  } finally { await h.close(); }
});

run("an order first paid by another way (H5 on a phone, then Native on a desktop): WeChat's 请求重入 refusal is `elsewhere`, other WeChat errors are 409 JSON, and renew gives this device a new order", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    const desktop = { ...ORIGIN, "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15" };
    h.wechat.fail("/v3/pay/transactions/native", 400, "INVALID_REQUEST");
    // The fake answers code and message alike, so the message is the code: not the re-entry refusal.
    const plain = await h.pay(no, {}, desktop);
    assert.deepEqual([plain.status, await plain.json()], [409, { error: "下单失败，请稍后重试" }]);
    h.wechat.fail("/v3/pay/transactions/native", 400, "INVALID_REQUEST", "请求重入时，参数与首次请求时不一致");
    const elsewhere = await h.pay(no, {}, desktop);
    assert.deepEqual([elsewhere.status, await elsewhere.json()], [200, { elsewhere: true }]);
    assert.equal((await db.codes.order(no))!.status, "pending");
    assert.equal((await h.renew(no)).status, 200);
    assert.equal((await db.pool.query("SELECT 1 FROM hatch_access_codes")).rows.length, 2);
  } finally { await h.close(); }
});

run("/return (orders made before the order page) redirects to the order's page", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    const res = await h.get(`/return?${new URLSearchParams({ o: no, back: BACK })}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `https://anyteach.cn/hatch-pay/o/${no}?r=1`);
    assert.equal((await h.get("/return?o=bogus")).status, 400);
  } finally { await h.close(); }
});

run("a payment of the wrong amount activates nothing", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    h.pay_(no, { amount: { total: 1 } });
    assert.equal((await h.get(`/o/${no}`)).status, 409);
    assert.equal(h.mails.length, 0);
    assert.equal((await db.codes.order(no))!.status, "pending");
  } finally { await h.close(); }
});

run("notify: twice at once and again after the order page, still exactly one activation and one email", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    const transaction = { trade_state: "SUCCESS", out_trade_no: no, transaction_id: "42000", mchid: "1639838957", amount: { total: 990 } };
    const answers = await Promise.all([h.notify(transaction), h.notify(transaction)]);
    assert.deepEqual(answers.map(a => a.status), [204, 204]);
    assert.equal(h.mails.length, 1);
    assert.match(h.mails[0]!.text, /https:\/\/gethatchapp\.com\/c\/MSC[2-9A-Z]{6}/);

    h.pay_(no);
    assert.equal((await h.get(`/o/${no}`)).status, 200);
    assert.equal((await h.notify(transaction)).status, 204);
    assert.equal(h.mails.length, 1);
  } finally { await h.close(); }
});

run("notify: a probe, a bad signature and a failed payment change nothing", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    const transaction = { trade_state: "SUCCESS", out_trade_no: no, transaction_id: "42000", amount: { total: 990 } };
    const probe = await h.notify(transaction, n => { n.headers["wechatpay-signature"] = `WECHATPAY/SIGNTEST/${n.headers["wechatpay-signature"]}`; });
    assert.equal(probe.status, 401);
    const forged = await h.notify(transaction, n => { n.body = n.body.replace("evt", "evx"); });
    assert.equal(forged.status, 401);
    assert.equal(h.mails.length, 0);
    assert.equal((await db.codes.order(no))!.status, "pending");

    assert.equal((await h.notify({ ...transaction, trade_state: "PAYERROR" })).status, 204);
    assert.equal((await db.codes.order(no))!.status, "pending");
  } finally { await h.close(); }
});

run("an email that fails does not undo the activation", async db => {
  const h = await harness(db);
  try {
    const no = await h.newOrder();
    h.pay_(no);
    // The harness' sender is replaced by a failing one through a second HatchPay on the same codes.
    const failing = new HatchPay({
      capabilities: new InMemoryProductCapabilities([[PRODUCT, "access_code"]]), codes: db.codes, publicBase: "https://anyteach.cn/hatch-pay", priceFen: 990,
      mailer: mailer({ send: async () => { throw new Error("resend down"); } }),
      wechat: new WeChatPayV3(testKeys().config, { hosts: [h.wechat.url], log: () => undefined }),
      openids: new WeChatOAuth("wx", "s", { apiBase: h.wechat.url })
    });
    const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), failing));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay/o/${no}`);
      assert.equal(response.status, 200);
      assert.equal((await db.codes.order(no))!.status, "active");
    } finally { server.closeAllConnections(); server.close(); }
  } finally { await h.close(); }
});

test("without configuration the routes answer 503", async () => {
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), undefined));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    assert.equal((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay/`)).status, 503);
  } finally { server.closeAllConnections(); server.close(); }
});
