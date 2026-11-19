import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { Pool } from "pg";
import { PostgresAccessCodes } from "../accessCodes/postgresAccessCodes.js";
import type { EmailMessage, EmailSender } from "./email.js";
import { HatchPay, handleHatchPayRoute } from "./routes.js";
import { WeChatOAuth } from "./wechatOAuth.js";
import { WeChatPayV3 } from "./wechatPay.js";
import { fakeWeChat, signedNotification, testKeys } from "./wechatPay.testkit.js";

// Opt-in integration tests. Every test owns a random schema, never a database.
const connectionString = process.env.HATCH_TEST_DATABASE_URL;
const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
const BACK = `https://gethatchapp.com/p/${PRODUCT}`;
const ORIGIN = { origin: "https://anyteach.cn" };

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
  const trades = new Map<string, Record<string, unknown>>();
  const wechat = await fakeWeChat(request => {
    if (request.url.startsWith("/v3/pay/transactions/h5")) return { body: { h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx1&package=1" } };
    if (request.url.startsWith("/v3/pay/transactions/jsapi")) return { body: { prepay_id: "wx-prepay" } };
    if (request.url.startsWith("/sns/oauth2/access_token")) return { body: { openid: "oFake", access_token: "t" } };
    const no = /out-trade-no\/([^?]+)/.exec(request.url)?.[1] ?? "";
    return trades.has(no) ? { body: trades.get(no) } : { body: { trade_state: "NOTPAY", out_trade_no: no } };
  });
  const email: EmailSender = { send: async message => { mails.push(message); return { id: `mail-${mails.length}` }; } };
  const publicBase = "https://anyteach.cn/hatch-pay";
  const pay = new HatchPay({
    codes: db.codes, email, emailFrom: "Hatch <noreply@send.gethatchapp.com>", publicBase, priceFen: 990,
    wechat: new WeChatPayV3(keys.config, { hosts: [wechat.url], log: () => undefined }),
    openids: new WeChatOAuth("wxtestappid", "secret", { apiBase: wechat.url })
  });
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), pay));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { redirect: "manual", headers });
  const order = async (body: Record<string, unknown>, headers: Record<string, string> = ORIGIN) =>
    fetch(`${base}/order`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ product: PRODUCT, email: "a@b.co", back: BACK, ...body }) });
  const pay_ = (outTradeNo: string, extra: Record<string, unknown> = {}) =>
    trades.set(outTradeNo, { trade_state: "SUCCESS", out_trade_no: outTradeNo, transaction_id: `42${outTradeNo}`, mchid: "1639838957", amount: { total: 990 }, attach: BACK, ...extra });
  const notify = (transaction: Record<string, unknown>, tweak?: (n: ReturnType<typeof signedNotification>) => void) => {
    const n = signedNotification({ platformPrivatePem: keys.platformPrivatePem, transaction });
    tweak?.(n);
    return fetch(`${base}/notify`, { method: "POST", headers: { "content-type": "application/json", ...n.headers }, body: n.body });
  };
  return { mails, get, order, pay: pay_, notify, wechat, base, trades, close: async () => { server.closeAllConnections(); server.close(); await wechat.close(); } };
}

const run = (name: string, body: Parameters<typeof withDb>[0]) => connectionString ? test(name, () => withDb(body)) : test(name, { skip: "needs HATCH_TEST_DATABASE_URL" }, () => undefined);

const activeCode = async (db: Awaited<ReturnType<typeof isolated>>, code: string, productId = PRODUCT) =>
  void await db.pool.query("INSERT INTO hatch_access_codes (code, product_id, status) VALUES ($1, $2, 'active')", [code, productId]);

run("redeem from two conversations at once: exactly one wins", async db => {
  await activeCode(db, "ABCD2345");
  const results = await Promise.all(["c1", "c2", "c3", "c4"].map(conversationId => db.codes.redeem({ code: "ABCD2345", productId: PRODUCT, conversationId })));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.deepEqual(results.filter(r => !r.ok), [{ ok: false, reason: "used" }, { ok: false, reason: "used" }, { ok: false, reason: "used" }]);
  const winner = (await db.codes.peek("abcd2345"))!;
  assert.equal(winner.status, "used");
  assert.deepEqual(await db.codes.lookup("abcd2345"), { status: "used", productId: PRODUCT, conversationId: winner.usedByConversationId });
  assert.equal(await db.codes.lookup("ZZZZ2345"), null);
  // The same conversation redeeming again is the same redeem.
  assert.deepEqual(await db.codes.redeem({ code: "ABCD2345", productId: PRODUCT, conversationId: winner.usedByConversationId! }), { ok: true });
});

run("redeem says why not: not_found, not_paid, wrong_product, void", async db => {
  assert.deepEqual(await db.codes.redeem({ code: "NOPE2345", productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "not_found" });
  const { code } = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  assert.deepEqual(await db.codes.redeem({ code, productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "not_paid" });
  await activeCode(db, "WRNG2345", "other-product");
  assert.deepEqual(await db.codes.redeem({ code: "WRNG2345", productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "wrong_product" });
  await db.pool.query("INSERT INTO hatch_access_codes (code, product_id, status) VALUES ('VOID2345', $1, 'void')", [PRODUCT]);
  assert.deepEqual(await db.codes.redeem({ code: "VOID2345", productId: PRODUCT, conversationId: "c" }), { ok: false, reason: "not_found" });
});

run("createPending draws a typable 8-character code and a unique trade number", async db => {
  const a = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co", payChannel: "h5" }), b = await db.codes.createPending({ productId: PRODUCT, email: "a@b.co" });
  assert.match(a.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.notEqual(a.outTradeNo, b.outTradeNo);
  assert.equal((await db.codes.peek(a.code))!.status, "pending");
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

run("order creation: only from the merchant's page; H5 sends the first forwarded hop and returns to /return", async db => {
  const h = await harness(db);
  try {
    assert.equal((await h.order({}, {})).status, 403);
    assert.equal((await h.order({}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await h.order({}, { referer: "https://anyteach.cn.evil.example/x" })).status, 403);
    assert.equal((await h.order({ back: "https://evil.example/p" })).status, 400);

    const response = await h.order({}, { ...ORIGIN, "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    assert.equal(response.status, 200);
    const body = await response.json() as { mode: string; url: string };
    assert.equal(body.mode, "h5");
    const sent = JSON.parse(h.wechat.requests.find(r => r.url === "/v3/pay/transactions/h5")!.body);
    assert.equal(sent.scene_info.payer_client_ip, "203.0.113.9");
    assert.equal(sent.attach, BACK);
    const redirect = new URL(new URL(body.url).searchParams.get("redirect_url")!);
    assert.equal(redirect.origin + redirect.pathname, "https://anyteach.cn/hatch-pay/return");
    assert.match(redirect.searchParams.get("o")!, /^hp[0-9a-f]{24}$/);
    assert.ok(Math.abs(Date.parse(sent.time_expire) - (Date.now() + 15 * 60_000)) < 10_000);

    assert.equal((await h.order({})).status, 400, "no forwarded address, no H5 order");

    const lastIp = () => JSON.parse(h.wechat.requests.filter(r => r.url === "/v3/pay/transactions/h5").at(-1)!.body).scene_info.payer_client_ip;
    assert.equal((await h.order({}, { ...ORIGIN, "x-real-ip": "2001:db8::7", "x-forwarded-for": "203.0.113.9" })).status, 200);
    assert.equal(lastIp(), "2001:db8::7", "X-Real-IP wins over X-Forwarded-For");
    assert.equal((await h.order({}, { ...ORIGIN, "x-real-ip": "not-an-ip", "x-forwarded-for": "198.51.100.4" })).status, 200);
    assert.equal(lastIp(), "198.51.100.4", "an invalid X-Real-IP falls back");
    assert.equal((await h.order({}, { ...ORIGIN, "x-real-ip": "bogus" })).status, 400, "an invalid address is no address");
  } finally { await h.close(); }
});

run("pay page: WeChat gets OAuth, a browser gets the price; the OAuth return carries the openid into a JSAPI order", async db => {
  const h = await harness(db);
  try {
    const query = `?${new URLSearchParams({ product: PRODUCT, email: "a@b.co", back: BACK })}`;
    const inWeChat = await h.get(`/${query}`, { "user-agent": "Mozilla/5.0 MicroMessenger/8.0" });
    assert.equal(inWeChat.status, 302);
    const authorize = new URL(inWeChat.headers.get("location")!);
    assert.equal(authorize.host, "open.weixin.qq.com");
    assert.equal(authorize.searchParams.get("scope"), "snsapi_base");
    assert.equal(new URL(authorize.searchParams.get("redirect_uri")!).pathname, "/hatch-pay/oauth");

    const browser = await h.get(`/${query}`, { "user-agent": "Mozilla/5.0 Safari" });
    assert.equal(browser.status, 200);
    const html = await browser.text();
    assert.match(html, /¥9\.9/);
    assert.doesNotMatch(html, /openid/);
    assert.equal((await h.get("/?product=x&email=bad&back=https://evil.example")).status, 400);

    const oauth = await h.get(`/oauth${query}&code=CODE&state=hatchpay`);
    assert.equal(oauth.status, 200);
    assert.match(await oauth.text(), /"openid":"oFake"/);
    assert.equal((await h.get(`/oauth${query}`)).status, 400, "no code: not authorized");

    const order = await h.order({ openid: "oFake" });
    const body = await order.json() as { mode: string; params: { package: string; paySign: string }; returnUrl: string };
    assert.equal(body.mode, "jsapi");
    assert.equal(body.params.package, "prepay_id=wx-prepay");
    assert.ok(body.params.paySign);
    assert.equal(JSON.parse(h.wechat.requests.find(r => r.url === "/v3/pay/transactions/jsapi")!.body).payer.openid, "oFake");
    assert.match(body.returnUrl, /^https:\/\/anyteach\.cn\/hatch-pay\/return\?o=hp/);
  } finally { await h.close(); }
});

const returnPath = (outTradeNo: string, back = BACK) => `/return?${new URLSearchParams({ o: outTradeNo, back })}`;
const startOrder = async (h: Awaited<ReturnType<typeof harness>>) => {
  const body = await (await h.order({}, { ...ORIGIN, "x-forwarded-for": "203.0.113.9" })).json() as { url: string };
  return new URL(new URL(body.url).searchParams.get("redirect_url")!).searchParams.get("o")!;
};

run("return page: not paid shows the query and re-pay buttons; paid redirects to the chat with the code and mails it once", async db => {
  const h = await harness(db);
  try {
    const outTradeNo = await startOrder(h);
    const waiting = await h.get(returnPath(outTradeNo));
    assert.equal(waiting.status, 200);
    const html = await waiting.text();
    assert.match(html, /我已支付，查询结果/);
    assert.match(html, /重新支付/);
    assert.equal(h.mails.length, 0);

    h.pay(outTradeNo);
    const paid = await h.get(returnPath(outTradeNo));
    assert.equal(paid.status, 302);
    const location = new URL(paid.headers.get("location")!);
    assert.equal(location.origin + location.pathname, BACK);
    const code = location.searchParams.get("code")!;
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.equal(h.mails.length, 1);
    assert.equal(h.mails[0]!.to, "a@b.co");
    assert.match(h.mails[0]!.text, new RegExp(code));
    assert.match(h.mails[0]!.text, new RegExp(`${BACK}\\?code=${code}`));

    // Back on the page again: the same code, no second mail.
    const again = await h.get(returnPath(outTradeNo));
    assert.equal(new URL(again.headers.get("location")!).searchParams.get("code"), code);
    assert.equal(h.mails.length, 1);
    assert.deepEqual(await db.codes.redeem({ code, productId: PRODUCT, conversationId: "c1" }), { ok: true });
  } finally { await h.close(); }
});

run("return page: a wrong back shows the code instead; unknown orders and WeChat outages are reported, not faked", async db => {
  const h = await harness(db);
  try {
    const outTradeNo = await startOrder(h);
    h.pay(outTradeNo);
    const noBack = await h.get(returnPath(outTradeNo, "https://evil.example/"));
    assert.equal(noBack.status, 200);
    assert.match(await noBack.text(), /[A-Z2-9]{8}/);
    assert.equal((await h.get("/return?o=hp000000000000000000000000")).status, 404);
    assert.equal((await h.get("/return?o=bogus")).status, 400);

    h.trades.set("x", {});
    const other = await startOrder(h);
    await h.wechat.close();
    assert.equal((await h.get(returnPath(other))).status, 502);
  } finally { await h.close(); }
});

run("return page: a payment of the wrong amount activates nothing", async db => {
  const h = await harness(db);
  try {
    const outTradeNo = await startOrder(h);
    h.pay(outTradeNo, { amount: { total: 1 } });
    assert.equal((await h.get(returnPath(outTradeNo))).status, 409);
    assert.equal(h.mails.length, 0);
  } finally { await h.close(); }
});

run("notify: twice at once and again after the return page, still exactly one activation and one email", async db => {
  const h = await harness(db);
  try {
    const outTradeNo = await startOrder(h);
    const transaction = { trade_state: "SUCCESS", out_trade_no: outTradeNo, transaction_id: "42000", mchid: "1639838957", amount: { total: 990 }, attach: BACK };
    const answers = await Promise.all([h.notify(transaction), h.notify(transaction)]);
    assert.deepEqual(answers.map(a => a.status), [204, 204]);
    assert.equal(h.mails.length, 1);
    assert.match(h.mails[0]!.text, new RegExp(`${BACK}\\?code=`));

    h.pay(outTradeNo);
    assert.equal((await h.get(returnPath(outTradeNo))).status, 302);
    assert.equal((await h.notify(transaction)).status, 204);
    assert.equal(h.mails.length, 1);
  } finally { await h.close(); }
});

run("notify: a probe, a bad signature and a failed payment change nothing", async db => {
  const h = await harness(db);
  try {
    const outTradeNo = await startOrder(h);
    const transaction = { trade_state: "SUCCESS", out_trade_no: outTradeNo, transaction_id: "42000", amount: { total: 990 } };
    const probe = await h.notify(transaction, n => { n.headers["wechatpay-signature"] = `WECHATPAY/SIGNTEST/${n.headers["wechatpay-signature"]}`; });
    assert.equal(probe.status, 401);
    const forged = await h.notify(transaction, n => { n.body = n.body.replace("evt", "evx"); });
    assert.equal(forged.status, 401);
    assert.equal(h.mails.length, 0);
    assert.equal((await db.codes.order(outTradeNo))!.status, "pending");

    assert.equal((await h.notify({ ...transaction, trade_state: "PAYERROR" })).status, 204);
    assert.equal((await db.codes.order(outTradeNo))!.status, "pending");
  } finally { await h.close(); }
});

run("an email that fails does not undo the activation", async db => {
  const h = await harness(db);
  try {
    const outTradeNo = await startOrder(h);
    h.pay(outTradeNo);
    // The harness' sender is replaced by a failing one through a second HatchPay on the same codes.
    const failing = new HatchPay({
      codes: db.codes, emailFrom: "x", publicBase: "https://anyteach.cn/hatch-pay", priceFen: 990,
      email: { send: async () => { throw new Error("resend down"); } },
      wechat: new WeChatPayV3(testKeys().config, { hosts: [h.wechat.url], log: () => undefined }),
      openids: new WeChatOAuth("wx", "s", { apiBase: h.wechat.url })
    });
    const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), failing));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay${returnPath(outTradeNo)}`, { redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal((await db.codes.order(outTradeNo))!.status, "active");
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
