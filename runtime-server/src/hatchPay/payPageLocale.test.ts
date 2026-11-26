import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { HatchPay, handleHatchPayRoute } from "./routes.js";

const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
const BACK = `https://gethatchapp.com/p/${PRODUCT}`;

async function serve() {
  const created: Array<Record<string, unknown>> = [], mailed: Array<Record<string, unknown>> = [], trade = { state: "NOTPAY" };
  const pay = new HatchPay({
    capabilities: new InMemoryProductCapabilities([[PRODUCT, "access_code"]]), publicBase: "https://anyteach.cn/hatch-pay", priceFen: 1,
    wechat: {
      ready: () => true, createH5Order: async () => ({ h5Url: "https://wx.example/pay?a=1" }),
      queryOrder: async (outTradeNo: string) => ({ outTradeNo, tradeState: trade.state, transactionId: "42", amountFen: 1 })
    },
    codes: {
      createPending: async (input: Record<string, unknown>) => { created.push(input); return { code: "MSC222222", outTradeNo: `hp${"a".repeat(24)}` }; },
      order: async () => ({ productId: PRODUCT, email: "a@b.co", locale: "ja" }),
      activatePaid: async () => ({ code: "MSC222222", productId: PRODUCT, email: "a@b.co", locale: "ja", status: "active", source: "paid", activated: true })
    },
    openids: {}, mailer: { send: async (input: Record<string, unknown>) => { mailed.push(input); } }
  } as unknown as ConstructorParameters<typeof HatchPay>[0]);
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), pay));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay`;
  return { base, created, mailed, trade, close: () => { server.closeAllConnections(); server.close(); } };
}
const q = (extra: Record<string, string> = {}) => `?${new URLSearchParams({ product: PRODUCT, email: "a@b.co", back: BACK, ...extra })}`;

test("the pay page is in the visitor's language by the web's locale parameter; none or unknown is Chinese", async () => {
  const s = await serve();
  try {
    const html = async (extra: Record<string, string>) => (await fetch(`${s.base}/${q(extra)}`)).text();
    const en = await html({ locale: "en", name: "Ann" });
    assert.match(en, /<html lang="en">/);
    assert.match(en, /<dt>Name<\/dt>/);
    assert.match(en, /<dt>Code sent to<\/dt>/);
    assert.match(en, />Pay<\/button>/);
    assert.doesNotMatch(en, /姓名|兑换码发送至|网络错误/);
    const ja = await html({ locale: "ja", name: "A" });
    assert.match(ja, /<html lang="ja">/);
    assert.match(ja, /<dt>お名前<\/dt>/);
    assert.match(ja, /ネットワークエラーです/, "the page script's messages are in the language too");
    assert.match(ja, /"locale":"ja"/, "the order POST carries the language");
    for (const extra of [{}, { locale: "fr" }] as Array<Record<string, string>>) {
      const zh = await html({ ...extra, name: "A" });
      assert.match(zh, /<html lang="zh-CN">/);
      assert.match(zh, /<dt>姓名<\/dt>/);
    }
    assert.match(await (await fetch(`${s.base}/?locale=en`)).text(), /Invalid link/);
    assert.match(await (await fetch(`${s.base}/nowhere?locale=ja`)).text(), /ページが見つかりません/);
  } finally { s.close(); }
});

test("the order keeps the visitor's language with the pending code, its way back carries it, and the paid mail gets the stored one", async () => {
  const s = await serve();
  try {
    const order = (body: Record<string, unknown>) => fetch(`${s.base}/order`, { method: "POST", headers: { "content-type": "application/json", origin: "https://anyteach.cn", "x-real-ip": "198.51.100.4", "user-agent": "iPhone Mobile" }, body: JSON.stringify({ product: PRODUCT, email: "a@b.co", back: BACK, ...body }) });
    const placed = await order({ locale: "en" });
    assert.equal(placed.status, 200);
    assert.equal(s.created[0]!.locale, "en");
    assert.match(decodeURIComponent(((await placed.json()) as { url: string }).url), /locale=en/, "the return URL keeps the language");
    await order({});
    assert.equal(s.created[1]!.locale, "zh");
    await order({ locale: "xx" });
    assert.equal(s.created[2]!.locale, "zh");
    const refused = await order({ locale: "ja", email: "nope" });
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: "無効なリンクです" });

    // The return page speaks the language of its link; the mail, the one stored with the order.
    const waiting = await (await fetch(`${s.base}/return?${new URLSearchParams({ o: `hp${"a".repeat(24)}`, back: BACK, locale: "en" })}`)).text();
    assert.match(waiting, /I have paid, check the result/);
    assert.match(waiting, /locale=en/, "re-pay keeps the language");
    s.trade.state = "SUCCESS";
    await fetch(`${s.base}/return?${new URLSearchParams({ o: `hp${"a".repeat(24)}`, back: BACK, locale: "en" })}`, { redirect: "manual" });
    assert.deepEqual(s.mailed, [{ code: "MSC222222", productId: PRODUCT, to: "a@b.co", locale: "ja" }]);
  } finally { s.close(); }
});
