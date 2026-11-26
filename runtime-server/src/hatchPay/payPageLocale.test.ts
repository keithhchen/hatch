import assert from "node:assert/strict";
import test from "node:test";
import { MERCHANT, NO, PRODUCT, serve } from "./orderPage.testkit.js";

const GATHER = { origin: "https://gethatchapp.com", "content-type": "application/json" };

test("an order page is in the language stored with the order; none stored is Chinese; the URL's locale does not matter", async () => {
  const s = await serve();
  try {
    const labels: Record<string, [string, RegExp[], RegExp[]]> = {
      zh: ["zh-CN", [/<dt>订单号<\/dt>/, /<dt>邮箱<\/dt>/, />待支付</, />微信支付 ¥9\.90<\/span><\/button>/, /重新下单/, /网络错误/], [/Order no\./]],
      en: ["en", [/<dt>Order no\.<\/dt>/, /<dt>Email<\/dt>/, />Unpaid</, />WeChat Pay ¥9\.90<\/span><\/button>/, /Order again/, /Network error/], [/订单号|网络错误/]],
      ja: ["ja", [/<dt>注文番号<\/dt>/, /<dt>メール<\/dt>/, />未払い</, /ネットワークエラーです/, /注文し直す/], [/订单号/]]
    };
    for (const [locale, [lang, present, absent]] of Object.entries(labels)) {
      s.seed({ locale: locale as "zh" | "en" | "ja" });
      const { html } = await s.page(`/o/${NO}?locale=${locale === "zh" ? "ja" : "zh"}`);
      assert.match(html, new RegExp(`<html lang="${lang}">`), locale);
      for (const pattern of present) assert.match(html, pattern, `${locale} ${pattern}`);
      for (const pattern of absent) assert.doesNotMatch(html, pattern, `${locale} ${pattern}`);
    }
    s.seed({ locale: null });
    assert.match((await s.page()).html, /<html lang="zh-CN">/);
    // Pill texts and the paid line travel in the page's own script, in the same language.
    s.seed({ locale: "en" });
    const en = (await s.page()).html;
    assert.match(en, /"unpaid":"Unpaid","paid":"Paid","expired":"Expired"/);
    assert.match(en, /Payment received, redirecting…/);
    s.seed({ locale: "ja" });
    assert.match((await s.page()).html, /"unpaid":"未払い","paid":"支払い済み","expired":"期限切れ"/);
    assert.match(await (await fetch(`${s.base}/nowhere?locale=ja`)).text(), /ページが見つかりません/);
  } finally { s.close(); }
});

test("an order keeps the visitor's language from /c; a renewed order and the paid mail keep the stored one", async () => {
  const s = await serve();
  try {
    await s.post("/new", { product: PRODUCT, email: "a@b.co", locale: "en" }, GATHER);
    await s.post("/new", { product: PRODUCT, email: "a@b.co" }, GATHER);
    await s.post("/new", { product: PRODUCT, email: "a@b.co", locale: "xx" }, GATHER);
    assert.deepEqual(s.created.map(input => input.locale), ["en", "zh", "zh"]);
    const refused = await s.post("/new", { product: PRODUCT, email: "nope", locale: "ja" }, GATHER);
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: { code: "invalid_order", message: "無効なリンクです" } });
    const [first] = [...s.orders.keys()];
    assert.match((await s.page(`/o/${first}`)).html, /<html lang="en">/);

    s.seed({ locale: "ja" });
    s.trade.state = "SUCCESS";
    await s.page();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.mailed.length, 1);
    assert.equal(s.mailed[0]!.locale, "ja", "the mail is in the order's language");

    s.seed({ outTradeNo: `hp${"d".repeat(24)}`, locale: "ja" });
    s.clock.now = new Date(s.clock.now.getTime() + 15 * 60_000);
    s.trade.state = "NOTPAY";
    await s.post(`/o/hp${"d".repeat(24)}/renew`, {}, MERCHANT);
    assert.equal(s.created.at(-1)!.locale, "ja");
  } finally { s.close(); }
});
