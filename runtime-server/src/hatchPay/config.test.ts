import assert from "node:assert/strict";
import test from "node:test";
import { hatchPayConfigFromEnvironment } from "./config.js";
import { ResendSender, accessCodeEmail } from "./email.js";
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

test("Resend: bearer key, idempotency key, and the access code with its link", async () => {
  const server = await fakeWeChat(() => ({ body: { id: "mail-1" } }));
  try {
    const sender = new ResendSender("re_x", { endpoint: `${server.url}/emails` });
    const message = accessCodeEmail({ from: "Hatch <noreply@send.gethatchapp.com>", to: "a@b.co", code: "ABCD2345", link: "https://gethatchapp.com/p/1?code=ABCD2345" });
    assert.deepEqual(await sender.send(message), { id: "mail-1" });
    const request = server.requests[0]!;
    assert.equal(request.headers.authorization, "Bearer re_x");
    assert.equal(request.headers["idempotency-key"], "access-code-ABCD2345");
    const sent = JSON.parse(request.body);
    assert.deepEqual(sent.to, ["a@b.co"]);
    assert.match(sent.html, /ABCD2345/);
    assert.match(sent.text, /gethatchapp\.com\/p\/1\?code=ABCD2345/);
  } finally { await server.close(); }
  const failing = await fakeWeChat(() => ({ status: 422, body: { message: "bad from" } }));
  try { await assert.rejects(new ResendSender("k", { endpoint: `${failing.url}/emails` }).send(accessCodeEmail({ from: "x", to: "a@b.co", code: "C" })), /422/); } finally { await failing.close(); }
});
