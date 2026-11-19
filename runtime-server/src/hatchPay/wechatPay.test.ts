import assert from "node:assert/strict";
import { createVerify } from "node:crypto";
import test from "node:test";
import { NotificationRejected, WeChatPayError, WeChatPayV3, decryptResource, requestMessage, rfc3339Beijing } from "./wechatPay.js";
import { fakeWeChat, signedNotification, testKeys } from "./wechatPay.testkit.js";

const order = { outTradeNo: "hp0123456789abcdef01234567", description: "Hatch 访问码", amountFen: 990, expiresAt: new Date("2026-11-19T04:15:00Z") };

test("requests are signed over METHOD, URL, timestamp, nonce and body, each ending in a newline", async () => {
  const keys = testKeys(), logs: Record<string, unknown>[] = [];
  const wechat = await fakeWeChat(() => ({ body: { h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wx1&package=1" } }));
  try {
    const pay = new WeChatPayV3(keys.config, { hosts: [wechat.url], log: entry => logs.push(entry) });
    const { h5Url } = await pay.createH5Order({ ...order, payerIp: "203.0.113.9" });
    assert.match(h5Url, /prepay_id=wx1/);

    const request = wechat.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v3/pay/transactions/h5");
    const header = request.headers.authorization!;
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(header)![1]!;
    assert.match(header, /^WECHATPAY2-SHA256-RSA2048 /);
    assert.equal(field("mchid"), "1639838957");
    assert.equal(field("serial_no"), "MERCHANTSERIAL");
    const message = requestMessage("POST", "/v3/pay/transactions/h5", field("timestamp"), field("nonce_str"), request.body);
    assert.equal(message, `POST\n/v3/pay/transactions/h5\n${field("timestamp")}\n${field("nonce_str")}\n${request.body}\n`);
    assert.ok(createVerify("RSA-SHA256").update(message).verify(keys.merchantPublicPem, field("signature"), "base64"));

    const sent = JSON.parse(request.body);
    assert.deepEqual(sent.scene_info, { payer_client_ip: "203.0.113.9", h5_info: { type: "Wap" } });
    assert.deepEqual(sent.amount, { total: 990, currency: "CNY" });
    assert.equal(sent.time_expire, "2026-11-19T12:15:00+08:00");
    assert.equal(sent.notify_url, keys.config.notifyUrl);
    assert.equal(logs[0]!.requestId, "req-1");
  } finally { await wechat.close(); }
});

test("a GET is signed over its path and query with an empty body line", async () => {
  const keys = testKeys();
  const wechat = await fakeWeChat(() => ({ body: { trade_state: "SUCCESS", out_trade_no: order.outTradeNo, transaction_id: "42000", amount: { total: 990 } } }));
  try {
    const state = await new WeChatPayV3(keys.config, { hosts: [wechat.url], log: () => undefined }).queryOrder(order.outTradeNo);
    assert.deepEqual(state, { tradeState: "SUCCESS", outTradeNo: order.outTradeNo, transactionId: "42000", amountFen: 990 });
    const request = wechat.requests[0]!;
    assert.equal(request.url, `/v3/pay/transactions/out-trade-no/${order.outTradeNo}?mchid=1639838957`);
    const header = request.headers.authorization!;
    const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(header)![1]!;
    const message = `GET\n${request.url}\n${field("timestamp")}\n${field("nonce_str")}\n\n`;
    assert.ok(createVerify("RSA-SHA256").update(message).verify(keys.merchantPublicPem, field("signature"), "base64"));
  } finally { await wechat.close(); }
});

test("JSAPI: openid in payer, and the invoke parameters are signed over appId, timestamp, nonce, package", async () => {
  const keys = testKeys();
  const wechat = await fakeWeChat(() => ({ body: { prepay_id: "wx-prepay" } }));
  try {
    const pay = new WeChatPayV3(keys.config, { hosts: [wechat.url], log: () => undefined });
    const { prepayId } = await pay.createJsapiOrder({ ...order, openid: "oOpenId" });
    assert.equal(prepayId, "wx-prepay");
    assert.equal(wechat.requests[0]!.url, "/v3/pay/transactions/jsapi");
    assert.deepEqual(JSON.parse(wechat.requests[0]!.body).payer, { openid: "oOpenId" });
    const params = pay.jsapiInvokeParams(prepayId);
    assert.equal(params.package, "prepay_id=wx-prepay");
    assert.equal(params.signType, "RSA");
    assert.ok(createVerify("RSA-SHA256").update(`wxtestappid\n${params.timeStamp}\n${params.nonceStr}\nprepay_id=wx-prepay\n`).verify(keys.merchantPublicPem, params.paySign, "base64"));
  } finally { await wechat.close(); }
});

test("a transport error on the primary goes to the backup; an answer from WeChat is final", async () => {
  const keys = testKeys();
  const backup = await fakeWeChat(request => request.url.startsWith("/v3/pay/transactions/jsapi")
    ? { status: 400, body: { code: "PARAM_ERROR", message: "bad openid" } } : { body: {} });
  try {
    const pay = new WeChatPayV3(keys.config, { hosts: ["http://127.0.0.1:1", backup.url], log: () => undefined });
    await assert.rejects(pay.createJsapiOrder({ ...order, openid: "x" }), (error: unknown) => error instanceof WeChatPayError && error.code === "PARAM_ERROR" && error.requestId === "req-1");
    assert.equal(backup.requests.length, 1);

    const primary = await fakeWeChat(() => ({ status: 400, body: { code: "PARAM_ERROR", message: "no" } }));
    try {
      await assert.rejects(new WeChatPayV3(keys.config, { hosts: [primary.url, backup.url], log: () => undefined }).createJsapiOrder({ ...order, openid: "x" }), WeChatPayError);
      assert.equal(backup.requests.length, 1, "the backup was not asked after WeChat answered");
    } finally { await primary.close(); }
  } finally { await backup.close(); }
});

test("an order WeChat does not know is NOTFOUND, not an error", async () => {
  const wechat = await fakeWeChat(() => ({ status: 404, body: { code: "ORDER_NOT_EXIST", message: "none" } }));
  try {
    const state = await new WeChatPayV3(testKeys().config, { hosts: [wechat.url], log: () => undefined }).queryOrder(order.outTradeNo);
    assert.equal(state.tradeState, "NOTFOUND");
  } finally { await wechat.close(); }
});

test("a notification verifies with the WeChat Pay public key and decrypts", () => {
  const keys = testKeys(), pay = new WeChatPayV3(keys.config, { log: () => undefined });
  const { body, headers } = signedNotification({ platformPrivatePem: keys.platformPrivatePem, transaction: { trade_state: "SUCCESS", out_trade_no: "hpx", transaction_id: "42000", mchid: "1639838957", amount: { total: 990 }, attach: "https://gethatchapp.com/p/1" } });
  assert.deepEqual(pay.readNotification(headers, body), { tradeState: "SUCCESS", outTradeNo: "hpx", transactionId: "42000", amountFen: 990, mchid: "1639838957", attach: "https://gethatchapp.com/p/1" });
});

test("a notification is rejected for a probe signature, wrong serial, bad signature, tampered body and stale timestamp", () => {
  const keys = testKeys(), pay = new WeChatPayV3(keys.config, { log: () => undefined });
  const good = signedNotification({ platformPrivatePem: keys.platformPrivatePem, transaction: { trade_state: "SUCCESS", out_trade_no: "hpx" } });
  const rejects = (headers: Record<string, string | undefined>, body: string, reason: RegExp) =>
    assert.throws(() => pay.readNotification(headers, body), (error: unknown) => error instanceof NotificationRejected && reason.test(error.message));

  rejects({ ...good.headers, "wechatpay-signature": "WECHATPAY/SIGNTEST/" + good.headers["wechatpay-signature"] }, good.body, /probe/);
  rejects({ ...good.headers, "wechatpay-serial": "PUB_KEY_ID_OTHER" }, good.body, /serial/);
  rejects(good.headers, good.body.replace("evt", "evx"), /bad signature/);
  const otherKey = signedNotification({ platformPrivatePem: testKeys().platformPrivatePem, transaction: {} });
  rejects(otherKey.headers, otherKey.body, /bad signature/);
  const stale = signedNotification({ platformPrivatePem: keys.platformPrivatePem, timestamp: Math.floor(Date.now() / 1000) - 3600, transaction: {} });
  rejects(stale.headers, stale.body, /stale/);
  rejects({}, good.body, /missing/);
});

test("AES-256-GCM resource: round trip, and a wrong key or tampered ciphertext fails", () => {
  const keys = testKeys();
  const { body } = signedNotification({ platformPrivatePem: keys.platformPrivatePem, transaction: { hello: "世界" } });
  const resource = JSON.parse(body).resource;
  assert.equal(decryptResource("0123456789abcdef0123456789abcdef", resource), JSON.stringify({ hello: "世界" }));
  assert.throws(() => decryptResource("ffffffffffffffffffffffffffffffff", resource));
  assert.throws(() => decryptResource("0123456789abcdef0123456789abcdef", { ...resource, associated_data: "other" }));
});

test("time_expire is RFC 3339 in +08:00", () => {
  assert.equal(rfc3339Beijing(new Date("2026-11-19T16:30:05Z")), "2026-11-20T00:30:05+08:00");
});
