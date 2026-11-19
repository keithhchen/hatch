import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { HatchPay } from "./routes.js";
import { NotificationRejected, PlatformCertificates, WeChatPayV3, decryptResource } from "./wechatPay.js";
import { PLATFORM_CERT_PEM, PLATFORM_CERT_SERIAL, certificatesBody, encryptResource, fakeWeChat, freshKeyPair, signedNotification, testKeys } from "./wechatPay.testkit.js";

const quiet = { log: () => undefined };
const transaction = { trade_state: "SUCCESS", out_trade_no: "hpx", transaction_id: "42000", amount: { total: 990 } };

/** A WeChat that serves /v3/certificates (signed by nobody the client knows, as at bootstrap) and signs the rest with the certificate's key. */
const certificateWeChat = (extra: Array<{ serial: string; pem: string }> = []) => {
  let certificateCalls = 0;
  return fakeWeChat(request => {
    if (request.url === "/v3/certificates") { certificateCalls++; return { body: certificatesBody([{ serial: PLATFORM_CERT_SERIAL, pem: PLATFORM_CERT_PEM }, ...extra]) }; }
    return { body: { trade_state: "SUCCESS", out_trade_no: "hpx", transaction_id: "42000", amount: { total: 990 } } };
  }, { serial: PLATFORM_CERT_SERIAL }).then(server => Object.assign(server, { certificateCalls: () => certificateCalls }));
};

test("each encrypt_certificate decrypts with the APIv3 key, its nonce and its associated_data as AAD", () => {
  const body = certificatesBody([{ serial: PLATFORM_CERT_SERIAL, pem: PLATFORM_CERT_PEM }]);
  const entry = body.data[0]!;
  assert.equal(entry.serial_no, PLATFORM_CERT_SERIAL);
  assert.equal(decryptResource("0123456789abcdef0123456789abcdef", entry.encrypt_certificate), PLATFORM_CERT_PEM);
  assert.throws(() => decryptResource("0123456789abcdef0123456789abcdef", { ...entry.encrypt_certificate, associated_data: "other" }));
  assert.throws(() => decryptResource("ffffffffffffffffffffffffffffffff", entry.encrypt_certificate));
  assert.notEqual(encryptResource("x").nonce, encryptResource("x").nonce);
});

test("certificate mode: not ready until the certificates are fetched; /v3/certificates is signed by us, sends Accept-Language, and is not verified", async () => {
  const keys = testKeys(), wechat = await certificateWeChat();
  try {
    const pay = new WeChatPayV3(keys.certificateConfig, { hosts: [wechat.url], ...quiet });
    assert.equal(pay.ready(), false);
    const certificates = await pay.fetchCertificates();
    assert.deepEqual(certificates.map(c => c.serial), [PLATFORM_CERT_SERIAL]);
    const request = wechat.requests[0]!;
    assert.equal(request.url, "/v3/certificates");
    assert.equal(request.headers["accept-language"], "zh-CN");
    assert.match(request.headers.authorization!, /^WECHATPAY2-SHA256-RSA2048 /);
  } finally { await wechat.close(); }
});

test("certificate mode: callbacks and responses verify with the certificate whose serial matches", async () => {
  const keys = testKeys(), wechat = await certificateWeChat();
  try {
    const pay = new WeChatPayV3(keys.certificateConfig, { hosts: [wechat.url], ...quiet });
    pay.start({ retryMs: 10, refreshMs: 3_600_000 });
    for (let i = 0; i < 100 && !pay.ready(); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(pay.ready(), true);

    const good = signedNotification({ platformPrivatePem: keys.platformPrivatePem, serial: PLATFORM_CERT_SERIAL, transaction });
    assert.equal((await pay.readNotification(good.headers, good.body)).transactionId, "42000");
    // A response is verified the same way (the fake signs under the certificate's serial).
    assert.equal((await pay.queryOrder("hpx")).tradeState, "SUCCESS");

    const forged = signedNotification({ platformPrivatePem: freshKeyPair().privateKey, serial: PLATFORM_CERT_SERIAL, transaction });
    await assert.rejects(pay.readNotification(forged.headers, forged.body), (e: unknown) => e instanceof NotificationRejected && /bad signature/.test(e.message));
    const probe = { ...good.headers, "wechatpay-signature": `WECHATPAY/SIGNTEST/${good.headers["wechatpay-signature"]}` };
    await assert.rejects(pay.readNotification(probe, good.body), /probe/);
  } finally { await wechat.close(); }
});

test("certificate mode: a response signed by a key the certificates do not hold is refused", async () => {
  const keys = testKeys();
  const wechat = await fakeWeChat(request => request.url === "/v3/certificates"
    ? { body: certificatesBody([{ serial: PLATFORM_CERT_SERIAL, pem: PLATFORM_CERT_PEM }]) }
    : { body: { trade_state: "SUCCESS", out_trade_no: "hpx" } }, { serial: PLATFORM_CERT_SERIAL, platformPrivatePem: freshKeyPair().privateKey });
  try {
    const pay = new WeChatPayV3(keys.certificateConfig, { hosts: [wechat.url], ...quiet });
    await (pay as unknown as { certificates: PlatformCertificates }).certificates.load();
    await assert.rejects(pay.queryOrder("hpx"), /response rejected \(bad signature\)/);
  } finally { await wechat.close(); }
});

test("serial selection: an unknown serial refetches once, then waits out the cooldown; a known one never refetches", async () => {
  let now = 0, fetches = 0;
  const other = createPublicKey(freshKeyPair().publicKey);
  const second = freshKeyPair().publicKey;
  let served = [{ serial: "AAA", pem: PLATFORM_CERT_PEM }];
  const certificates = new PlatformCertificates(async () => { fetches++; return served; }, 30_000, () => now);
  await certificates.load();
  assert.equal(fetches, 1);
  assert.ok(await certificates.keyFor("AAA"));
  assert.equal(fetches, 1, "a cached serial is not fetched for");

  now = 31_000;
  served = [{ serial: "AAA", pem: PLATFORM_CERT_PEM }, { serial: "BBB", pem: second }];
  assert.ok(await certificates.keyFor("BBB"), "a rotated-in certificate is found by one refetch");
  assert.equal(fetches, 2);

  assert.equal(await certificates.keyFor("CCC"), undefined);
  assert.equal(fetches, 2, "unknown but just fetched: cooldown");
  now += 30_001;
  assert.equal(await certificates.keyFor("CCC"), undefined);
  assert.equal(fetches, 3, "unknown after the cooldown: refetched once");
  assert.equal(await certificates.keyFor("CCC"), undefined);
  assert.equal(await certificates.keyFor("DDD"), undefined);
  assert.equal(fetches, 3, "within the cooldown: no hammering");
  now += 30_001;
  await certificates.keyFor("CCC");
  assert.equal(fetches, 4);
  assert.equal(other.type, "public");
});

test("a failed fetch at startup is retried; the pay routes answer 503 until the certificates are loaded", async () => {
  const keys = testKeys();
  let healthy = false;
  const wechat = await fakeWeChat(request => request.url === "/v3/certificates"
    ? healthy ? { body: certificatesBody([{ serial: PLATFORM_CERT_SERIAL, pem: PLATFORM_CERT_PEM }]) } : { status: 500, body: { code: "SYSTEM_ERROR", message: "later" } }
    : { body: {} }, { serial: PLATFORM_CERT_SERIAL });
  try {
    const wechatPay = new WeChatPayV3(keys.certificateConfig, { hosts: [wechat.url], ...quiet });
    const pay = new HatchPay({ wechat: wechatPay, publicBase: "https://anyteach.cn/hatch-pay", priceFen: 990 } as never);
    const server = http.createServer((req, res) => void pay.handle(req, res, new URL(req.url!, "http://x")));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay`;
    try {
      wechatPay.start({ retryMs: 20, refreshMs: 3_600_000 });
      await new Promise(r => setTimeout(r, 80));
      assert.equal(wechatPay.ready(), false);
      assert.equal((await fetch(`${base}/`)).status, 503);
      assert.equal((await fetch(`${base}/notify`, { method: "POST", body: "{}" })).status, 503, "a notification is left for WeChat's retry");

      healthy = true;
      for (let i = 0; i < 100 && !wechatPay.ready(); i++) await new Promise(r => setTimeout(r, 20));
      assert.equal(wechatPay.ready(), true);
      assert.equal((await fetch(`${base}/`)).status, 400, "open: the (invalid) request is now judged on its merits");
    } finally { server.closeAllConnections(); server.close(); }
  } finally { await wechat.close(); }
});

test("public key and key id go together", () => {
  const keys = testKeys();
  assert.throws(() => new WeChatPayV3({ ...keys.config, publicKeyId: undefined }), /go together/);
});
