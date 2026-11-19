import assert from "node:assert/strict";
import test from "node:test";
import { hatchPayConfigFromEnvironment } from "./config.js";
import { TransientEmailError } from "../agentBox/reportEmail.js";
import { ResendSender } from "./email.js";
import { fakeWeChat } from "./wechatPay.testkit.js";

const env = {
  WECHATPAY_MCHID: "1639838957", WECHATPAY_SERIAL: "S", WECHATPAY_PRIVATE_KEY_B64: Buffer.from("PRIVATE").toString("base64"), WECHATPAY_APIV3_KEY: "0123456789abcdef0123456789abcdef",
  WECHATPAY_PUBLIC_KEY_ID: "PUB_KEY_ID_1", WECHATPAY_PUBLIC_KEY_B64: Buffer.from("PUBLIC").toString("base64"), WECHAT_MP_APPID: "wx1", WECHAT_MP_APPSECRET: "secret",
  HATCH_PAY_PUBLIC_BASE: "https://anyteach.cn/hatch-pay/", HATCH_PAY_NOTIFY_URL: "https://gethatchapp.com/hatch-pay/notify", HATCH_PAY_PRICE_FEN: "990",
  RESEND_API_KEY: "re_x"
};

test("every setting present: a config with the keys decoded", () => {
  const result = hatchPayConfigFromEnvironment(env);
  assert.ok("config" in result);
  assert.equal(result.config.wechat.privateKeyPem, "PRIVATE");
  assert.equal(result.config.publicBase, "https://anyteach.cn/hatch-pay");
  assert.equal(result.config.priceFen, 990);
  assert.equal(result.config.emailFrom, "Hatch <noreply@gethatchapp.com>");
});

test("any setting missing or wrong: disabled, naming it, never a default", () => {
  assert.deepEqual(hatchPayConfigFromEnvironment({ ...env, WECHAT_MP_APPSECRET: "", RESEND_API_KEY: undefined }), { disabled: "missing WECHAT_MP_APPSECRET, RESEND_API_KEY" });
  assert.match((hatchPayConfigFromEnvironment({ ...env, HATCH_PAY_PRICE_FEN: "9.9" }) as { disabled: string }).disabled, /PRICE_FEN/);
  assert.match((hatchPayConfigFromEnvironment({ ...env, WECHATPAY_APIV3_KEY: "short" }) as { disabled: string }).disabled, /32 bytes/);
});

test("without a public key and id the config is for platform certificates; one without the other is refused", () => {
  const certificates = hatchPayConfigFromEnvironment({ ...env, WECHATPAY_PUBLIC_KEY_ID: "", WECHATPAY_PUBLIC_KEY_B64: "" });
  assert.ok("config" in certificates);
  assert.equal(certificates.config.wechat.publicKeyId, undefined);
  const publicKey = hatchPayConfigFromEnvironment({ ...env, WECHATPAY_PUBLIC_KEY_ID: "PUB_KEY_ID_1", WECHATPAY_PUBLIC_KEY_B64: Buffer.from("PUBLIC").toString("base64") });
  assert.ok("config" in publicKey);
  assert.equal(publicKey.config.wechat.publicKeyPem, "PUBLIC");
  assert.match((hatchPayConfigFromEnvironment({ ...env, WECHATPAY_PUBLIC_KEY_ID: "PUB_KEY_ID_1", WECHATPAY_PUBLIC_KEY_B64: "" }) as { disabled: string }).disabled, /both set or both empty/);
});

test("Resend: bearer key, idempotency key, and the access code with its link", async () => {
  const server = await fakeWeChat(() => ({ body: { id: "mail-1" } }));
  try {
    const sender = new ResendSender("re_x", { endpoint: `${server.url}/emails` });
    const message = { from: "Hatch <noreply@gethatchapp.com>", to: "a@b.co", subject: "s", html: "<p>ABCD2345</p>", text: "https://gethatchapp.com/c/ABCD2345", idempotencyKey: "access-code-ABCD2345" };
    assert.deepEqual(await sender.send(message), { id: "mail-1" });
    const request = server.requests[0]!;
    assert.equal(request.headers.authorization, "Bearer re_x");
    assert.equal(request.headers["idempotency-key"], "access-code-ABCD2345");
    const sent = JSON.parse(request.body);
    assert.deepEqual(sent.to, ["a@b.co"]);
    assert.match(sent.html, /ABCD2345/);
    assert.match(sent.text, /gethatchapp\.com\/c\/ABCD2345/);
  } finally { await server.close(); }
  const failing = await fakeWeChat(() => ({ status: 422, body: { message: "bad from" } }));
  const mail = { from: "x", to: "a@b.co", subject: "s", html: "h", text: "t", idempotencyKey: "k" };
  try { await assert.rejects(new ResendSender("k", { endpoint: `${failing.url}/emails` }).send(mail), (e: Error) => /422/.test(e.message) && !(e instanceof TransientEmailError)); } finally { await failing.close(); }
  for (const status of [429, 503]) {
    const transient = await fakeWeChat(() => ({ status, body: { message: "later" } }));
    try { await assert.rejects(new ResendSender("k", { endpoint: `${transient.url}/emails` }).send(mail), TransientEmailError); } finally { await transient.close(); }
  }
  await assert.rejects(new ResendSender("k", { fetch: async () => { throw new TypeError("fetch failed"); } }).send(mail), TransientEmailError);
});
