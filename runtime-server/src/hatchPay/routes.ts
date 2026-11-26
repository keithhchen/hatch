import { readFileSync } from "node:fs";
import type http from "node:http";
import qrcode from "qrcode-generator";
import type { AccessCodeOrder, AccessCodes, Activation } from "../accessCodes/accessCodes.js";
import { payerIp as payerIpOf } from "./payerIp.js";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import type { ProductCapabilities } from "../agentBox/capabilities.js";
import { log } from "../observability/log.js";
import { readBoundedBytes } from "../http/httpSupport.js";
import type { CodeMailer } from "./codeMail.js";
import { escapeHtml } from "./email.js";
import { DEFAULT_LOCALE, localeOf, type Locale } from "../locale.js";
import type { OpenIdResolver } from "./wechatOAuth.js";
import { NotificationRejected, WeChatPayError, type OrderState, type WeChatPay } from "./wechatPay.js";

/** A Product sells access codes only by a row in hatch_product_capabilities. */
export const ACCESS_CODE_CAPABILITY = "access_code";

export type HatchPayDeps = {
  capabilities: ProductCapabilities;
  codes: AccessCodes;
  wechat: WeChatPay;
  openids: OpenIdResolver;
  mailer: CodeMailer;
  /** Where the checkout card reads the Product's name and description from. */
  corpora?: AgentCorpusResolverLike;
  /** `https://anyteach.cn/hatch-pay`: where the merchant's pages are reached, whatever host Runtime sits behind. */
  publicBase: string;
  priceFen: number;
  now?: () => Date;
};

/** Pages and routes under /hatch-pay/. Pay pages are opened from the merchant's own domain; the order POST only from there. */
const ORDER_ORIGINS = ["https://anyteach.cn"];
const PRODUCT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const TRADE_NO = /^hp[0-9a-f]{24}$/;
const ORDER_MINUTES = 15;
/** The same rule as the web's `isDesktop`: no phone or tablet token in the User-Agent. */
const isDesktop = (req: http.IncomingMessage) => !/Android|iPhone|iPad|iPod|Mobile|Tablet|Silk|Kindle/i.test(req.headers["user-agent"] ?? "");
const qrSvg = (text: string) => { const qr = qrcode(0, "M"); qr.addData(text); qr.make(); return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }); };

const isChatUrl = (value: string | null): value is string => {
  if (!value) return false;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "gethatchapp.com" || url.hostname.endsWith(".gethatchapp.com")); } catch { return false; }
};
const withCode = (back: string, code: string) => { const url = new URL(back); url.searchParams.set("code", code); return url.toString(); };

/** Where a paid buyer goes: the funnel's landing, which opens the code's own page. */
const CODE_LANDING = "https://gethatchapp.com/c/";
const FONT = "dm-sans-latin-wght-normal.woff2";
let fontBytes: Buffer | undefined;
const orderCode = (code: string) => withCode(CODE_LANDING, code);

/** What a visitor reads on these pages, by language. The WeChat Pay order's own description is not here: it stays Chinese, as WeChat's API wants. */
const COPY = {
  zh: { lang: "zh-CN", closed: "支付暂未开放", guide: "请点击右上角 ··· 选择『在浏览器打开』", openBrowser: "请在浏览器打开", invalid: "链接无效", unsellable: "不可购买", notFound: "页面不存在", failed: "出错了，请稍后重试", noAuth: "未获得授权", authFailed: "授权失败", retry: "重试", orderNo: "订单号", email: "邮箱", unpaid: "待支付", paidTag: "已支付", expiredTag: "已过期", renew: "重新下单", copy: "复制", copied: "已复制", wechatPay: "微信支付", orderFailed: "下单失败", orderFailedLater: "下单失败，请稍后重试", notCompleted: "支付未完成", network: "网络错误，请重试", queryFailed: "查询失败，请稍后重试", confirming: "正在确认支付结果…", mismatch: "支付金额与订单不符，请联系我们", noOrder: "订单不存在", badRequest: "请求无效", noIp: "无法获取网络地址", scan: "请用微信扫码支付", paid: "支付成功", redirecting: "支付成功，正在跳转…", notExpired: "订单仍在有效期内" },
  en: { lang: "en", closed: "Payments are not open yet", guide: "Tap ··· at the top right and choose “Open in browser”", openBrowser: "Please open this in a browser", invalid: "Invalid link", unsellable: "Not available for purchase", notFound: "Page not found", failed: "Something went wrong. Please try again later.", noAuth: "Not authorized", authFailed: "Authorization failed", retry: "Try again", orderNo: "Order no.", email: "Email", unpaid: "Unpaid", paidTag: "Paid", expiredTag: "Expired", renew: "Order again", copy: "Copy", copied: "Copied", wechatPay: "WeChat Pay", orderFailed: "Could not create the order", orderFailedLater: "Could not create the order. Please try again later.", notCompleted: "Payment was not completed", network: "Network error. Please try again.", queryFailed: "Could not check the payment. Please try again later.", confirming: "Confirming your payment…", mismatch: "The amount paid does not match the order. Please contact us.", noOrder: "Order not found", badRequest: "Invalid request", noIp: "Could not read your network address", scan: "Scan with WeChat to pay", paid: "Payment received", redirecting: "Payment received, redirecting…", notExpired: "This order is still valid" },
  ja: { lang: "ja", closed: "決済はまだ開始されていません", guide: "右上の ··· をタップして「ブラウザで開く」を選んでください", openBrowser: "ブラウザで開いてください", invalid: "無効なリンクです", unsellable: "購入できません", notFound: "ページが見つかりません", failed: "エラーが発生しました。しばらくしてからもう一度お試しください。", noAuth: "認証されませんでした", authFailed: "認証に失敗しました", retry: "やり直す", orderNo: "注文番号", email: "メール", unpaid: "未払い", paidTag: "支払い済み", expiredTag: "期限切れ", renew: "注文し直す", copy: "コピー", copied: "コピーしました", wechatPay: "WeChat Pay", orderFailed: "注文を作成できませんでした", orderFailedLater: "注文を作成できませんでした。しばらくしてからもう一度お試しください。", notCompleted: "支払いが完了しませんでした", network: "ネットワークエラーです。もう一度お試しください。", queryFailed: "確認に失敗しました。しばらくしてからもう一度お試しください。", confirming: "お支払いを確認しています…", mismatch: "お支払い金額が注文と一致しません。お問い合わせください。", noOrder: "注文が見つかりません", badRequest: "無効なリクエストです", noIp: "ネットワークアドレスを取得できません", scan: "WeChatでスキャンして支払う", paid: "お支払いが完了しました", redirecting: "お支払いを確認しました。移動しています…", notExpired: "この注文はまだ有効です" }
} satisfies Record<Locale, Record<string, string>>;

const PAGE_HEAD = (locale: Locale) => `<!doctype html><html lang="${COPY[locale].lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hatch</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:64px 24px;text-align:center}.btn{display:inline-block;font:inherit;font-size:17px;font-weight:700;line-height:1.3;min-height:52px;box-sizing:border-box;padding:12px 40px;border:0;border-radius:14px;background:#111;color:#fff;text-decoration:none}.btn:disabled{opacity:.5}</style></head><body>`;
const guide = (locale: Locale) => `<svg width="72" height="72" viewBox="0 0 72 72" style="position:fixed;top:12px;right:16px" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 58C20 36 38 22 58 14M40 12l18 2-4 18"/></svg><p style="margin-top:120px;font-size:20px">${COPY[locale].guide}</p>`;
const page = (locale: Locale, body: string, script = "") => `${PAGE_HEAD(locale)}${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
/** MSC × Hatch as /c draws it (CoBrandLockup, cap 17): MSC from the public OSS copy, Hatch from the web app. */
const LOCKUP = `<span class="lockup" role="img" aria-label="MSC × Hatch"><img class="msc" src="https://hatch-downloads.oss-cn-shanghai.aliyuncs.com/brand/msc/msc-logo-black.png" alt=""><i></i><img class="hatch" src="https://gethatchapp.com/assets/web/hatch-lockup.svg" alt=""></span>`;
/** The look of /c's pay card (webTheme.css and codePage.css, tokens resolved). */
const checkoutCss = (fontUrl: string) => `<style>
@font-face{font-family:"DM Sans Variable";font-style:normal;font-display:swap;font-weight:100 1000;src:url(${fontUrl}) format("woff2-variations");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
body{min-height:100vh;box-sizing:border-box;margin:0;padding:24px 16px 48px;background:#faf8f2;color:#17150f;text-align:left;font-family:"DM Sans Variable","DM Sans",-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans","Noto Sans SC",sans-serif}
main.co{width:min(440px,100%);margin:4vh auto 0}
.co .card{padding:28px 22px 22px;border:1px solid #e8e2d4;border-radius:24px;background:#fffdf8;box-shadow:0 20px 50px rgba(23,21,15,.1)}
.co .hd{display:flex;flex-direction:column;align-items:flex-start;gap:16px;margin-bottom:22px;padding-bottom:18px;border-bottom:1px solid #e8e2d4}
.co .lockup{display:inline-flex;align-items:center;gap:9.35px;max-width:100%;line-height:0}.co .lockup .msc{display:block;height:16.15px;width:auto;min-width:0}.co .lockup i{display:block;flex:none;width:1px;height:17px;background:#111315;opacity:.3}.co .lockup .hatch{display:block;height:18.53px;width:auto}
.co h1{margin:0;font-size:17px;font-weight:700;line-height:1.3;color:#17150f}
.co dl{margin:0}
.co dl div{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #e8e2d4;font-size:15px}
.co dt{flex:none;color:#6b6455}.co dd{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px 8px;margin:0;min-width:0;color:#17150f;text-align:right;overflow-wrap:anywhere}
.co .no{font-size:13px;letter-spacing:.02em;font-variant-numeric:tabular-nums;word-break:break-all}
.co .cp{padding:2px 8px;border:1px solid #e8e2d4;border-radius:999px;background:none;color:#6b6455;font:inherit;font-size:12px;cursor:pointer}
.co .pill{padding:3px 9px;border-radius:999px;background:#f3efe6;color:#6b6455;font-size:12px;font-weight:650;line-height:1.4;white-space:nowrap}
.co [data-s=paid] .pill{background:#07c160;color:#fff}
.co [data-s=expired] .pill{background:#f7e4df;color:#b4442c}
.co .price{margin:18px 0 24px;color:#17150f;font-size:36px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.co .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:0;padding:12px 20px;cursor:pointer}
.co #pay{border:1px solid #07c160;background:#07c160;box-shadow:0 6px 16px rgba(7,193,96,.3);transition:transform 180ms cubic-bezier(.2,.7,.2,1),box-shadow 180ms cubic-bezier(.2,.7,.2,1)}
.co #pay:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 10px 22px rgba(7,193,96,.4)}
.co #pay:focus-visible{outline:3px solid rgba(7,193,96,.35);outline-offset:2px}
.co #pay:disabled{opacity:.5;box-shadow:none;cursor:not-allowed}
.co #pay.busy{opacity:.9;cursor:progress;pointer-events:none}
.co #pay.busy:hover{transform:none;box-shadow:0 6px 16px rgba(7,193,96,.3)}
.co #renew{border:1px solid #17150f;background:#17150f}
.co #renew.busy{opacity:.9;cursor:progress;pointer-events:none}
.co [data-s=paid] #pay,.co [data-s=paid] #renew,.co [data-s=expired] #pay,.co [data-s=unpaid] #renew{display:none}
.co .btn.busy .wx{display:none}
.co .spin{display:none;width:16px;height:16px;margin:0 4px;box-sizing:border-box;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
.co .btn.busy .spin{display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
.co #err{min-height:20px;margin-top:12px;text-align:center;font-size:14px;color:#b4442c}
.co .done .ok{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 12px;border-radius:50%;background:#07c160;animation:pop .35s cubic-bezier(.2,.7,.2,1)}
@keyframes pop{from{transform:scale(.4);opacity:0}}
.co .mini{display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-2px;box-sizing:border-box;border:2px solid #d9f3e4;border-top-color:#07c160;border-radius:50%;animation:sp .7s linear infinite}
.co .done .spin2{width:32px;height:32px;margin:0 auto 12px;box-sizing:border-box;border:3px solid #d9f3e4;border-top-color:#07c160;border-radius:50%;animation:sp .8s linear infinite}
@media (prefers-reduced-motion:reduce){.co .spin,.co .spin2,.co .mini{animation-duration:2s}.co #pay{transition:none}.co .done .ok{animation:none}}
.co #qr{text-align:center;font-size:14px}.co #qr>svg{display:block;width:220px;height:220px;margin:0 auto 8px}
</style>`;
const buyerName = (value: string | null) => { const name = (value ?? "").replace(/\s+/g, " ").trim(); return name && name.length <= 40 ? name : undefined; };
const WECHAT_MARK = `<svg class="wx" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path fill="currentColor" d="M9.5 3C5.4 3 2 5.8 2 9.3c0 2 1.1 3.7 2.8 4.9l-.7 2.1 2.5-1.3c.9.3 1.8.4 2.9.4h.5a5.5 5.5 0 0 1-.3-1.7c0-3.2 3-5.8 6.7-5.8h.4C16.1 5 13.1 3 9.5 3Zm-3 3.6a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Zm6 0a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z"/><path fill="currentColor" d="M22 14.2c0-2.8-2.7-5-6-5s-6 2.2-6 5 2.7 5 6 5c.8 0 1.6-.1 2.3-.4l2 1.1-.6-1.8c1.5-.9 2.3-2.3 2.3-3.9Zm-7.9-.7a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Zm3.8 0a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6Z"/></svg>`;
const jsLiteral = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
/** WeChat refusing to take the order again: closed, or made earlier by another way of paying. The buyer starts a new order. */
const ORDER_GONE = new Set(["OUT_TRADE_NO_USED", "ORDER_CLOSED"]);

type Order = AccessCodeOrder & { outTradeNo: string; email: string; amountFen: number };
type View = "unpaid" | "paid" | "expired";

export class HatchPay {
  constructor(private readonly deps: HatchPayDeps) {}

  private now() { return this.deps.now?.() ?? new Date(); }
  private orderUrl(outTradeNo: string) { return `${this.deps.publicBase}/o/${outTradeNo}`; }
  private expiresAt(order: Order) { return new Date(order.createdAt.getTime() + ORDER_MINUTES * 60_000); }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // Until WeChat's verification keys are loaded nothing it says can be checked: not open yet, and a notification is left for its retry.
    // A page speaks the language stored with its order; the few routes without one read the web's `locale` query parameter (none or unknown is Chinese).
    let locale = localeOf(url.searchParams.get("locale"));
    const t = COPY[locale];
    if (!this.deps.wechat.ready()) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "10" });
      return void res.end(t.closed);
    }
    const route = url.pathname.replace(/^\/hatch-pay\/?/, "/");
    const order = /^\/o\/(hp[0-9a-f]{24})(\/pay|\/renew)?$/.exec(route);
    // The buyer flow is H5 pay in a normal browser, never WeChat's in-app one: every buyer page there is the guide out of it, and no order is made. The notification is WeChat's own call.
    if (route !== "/notify" && /MicroMessenger/i.test(req.headers["user-agent"] ?? "")) {
      if (req.method === "POST") return this.json(res, 403, { error: t.openBrowser });
      if (order) locale = localeOf((await this.deps.codes.order(order[1]!))?.locale);
      return this.html(res, 200, page(locale, guide(locale)));
    }
    try {
      if (req.method === "GET" && route === `/font/${FONT}`) return this.font(res);
      if (req.method === "POST" && route === "/new") return await this.create(req, res);
      if (req.method === "GET" && order && !order[2]) return await this.orderPage(res, order[1]!, url.searchParams.get("r") === "1");
      if (req.method === "POST" && order?.[2] === "/pay") return await this.pay(req, res, order[1]!);
      if (req.method === "POST" && order?.[2] === "/renew") return await this.renew(req, res, order[1]!);
      if (req.method === "GET" && route === "/oauth") return await this.oauth(res, url);
      if (req.method === "GET" && route === "/status") return await this.status(res, url);
      if (req.method === "GET" && route === "/return") return this.return(res, url);
      if (req.method === "POST" && route === "/notify") return await this.notify(req, res);
      this.html(res, 404, page(locale, `<p>${t.notFound}</p>`));
    } catch (error) {
      log.error("hatch_pay_request_failed", { route, error });
      if (!res.headersSent) this.html(res, 500, page(locale, `<p>${t.failed}</p>`));
    }
  }

  private html(res: http.ServerResponse, status: number, body: string) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "origin", "x-content-type-options": "nosniff" });
    res.end(body);
  }
  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }
  private redirect(res: http.ServerResponse, location: string) {
    res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "origin" });
    res.end();
  }
  private font(res: http.ServerResponse) {
    fontBytes ??= readFileSync(new URL(`../../fonts/${FONT}`, import.meta.url));
    res.writeHead(200, { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
    res.end(fontBytes);
  }

  /** Origin (or Referer, for a client that sends no Origin) must be the merchant's own domain. */
  private fromMerchantPage(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin, referer = req.headers.referer;
    if (origin) return ORDER_ORIGINS.includes(origin);
    return !!referer && ORDER_ORIGINS.some(allowed => referer === allowed || referer.startsWith(`${allowed}/`));
  }

  /** The order of a number, or undefined; every order made here has its email, number and amount. */
  private async load(outTradeNo: string): Promise<Order | undefined> {
    const order = await this.deps.codes.order(outTradeNo);
    return order?.outTradeNo && order.email && order.amountFen ? order as Order : undefined;
  }

  /** What the card says about the Product; whatever the corpus cannot tell is left out, never invented. */
  private async productName(productId: string): Promise<string | undefined> {
    try { return (await this.deps.corpora?.resolveByProduct(productId))?.corpus.product.name; } catch (error) { log.warn("hatch_pay_corpus_unavailable", { productId, error }); return undefined; }
  }

  /** The /c page makes the order (a pending code, no WeChat call) and goes to its page. Only from Hatch's own pages. */
  private async create(req: http.IncomingMessage, res: http.ServerResponse) {
    const fail = (status: number, code: string, message: string) => this.json(res, status, { error: { code, message } });
    if (!isChatUrl(req.headers.origin ?? null)) return fail(403, "origin_not_allowed", "forbidden");
    let body: Record<string, unknown>;
    try { body = JSON.parse((await readBoundedBytes(req, 8 * 1024)).toString("utf8")); } catch { return fail(400, "invalid_order", COPY[DEFAULT_LOCALE].badRequest); }
    const locale = localeOf(body.locale), t = COPY[locale];
    const product = String(body.product ?? ""), email = String(body.email ?? "").trim();
    if (!PRODUCT.test(product) || !EMAIL.test(email)) return fail(400, "invalid_order", t.invalid);
    if (!await this.deps.capabilities.has(product, ACCESS_CODE_CAPABILITY)) return fail(403, "invalid_order", t.unsellable);
    const name = buyerName(typeof body.name === "string" ? body.name : null);
    const { outTradeNo } = await this.deps.codes.createPending({ productId: product, email, ...name ? { name } : {}, locale });
    this.json(res, 200, { order_no: outTradeNo, url: this.orderUrl(outTradeNo) });
  }

  /** An order is only ever read here: a pending one is asked of WeChat first, and paid settles it (once), so a reload, a second browser or a late notification all see the same truth. */
  private async orderPage(res: http.ServerResponse, outTradeNo: string, returned: boolean, openid?: string) {
    const found = await this.load(outTradeNo);
    if (!found) return this.html(res, 404, page(DEFAULT_LOCALE, `<p>${COPY[DEFAULT_LOCALE].noOrder}</p>`));
    const locale = localeOf(found.locale), t = COPY[locale];
    let order = found;
    if (order.status === "pending") {
      try {
        const state = await this.deps.wechat.queryOrder(outTradeNo);
        if (state.tradeState === "SUCCESS") {
          const settled = await this.settle(state);
          if (!settled || settled.status === "pending" || settled.status === "void") return this.html(res, 409, page(locale, `<p>${t.mismatch}</p>`));
          order = { ...order, status: settled.status };
        }
      } catch (error) { log.error("hatch_pay_query_failed", { outTradeNo, error }); }
    }
    const expiresAt = this.expiresAt(order).getTime(), now = this.now().getTime();
    const s: View = order.status !== "pending" ? "paid" : now >= expiresAt ? "expired" : "unpaid";
    const tag = { unpaid: t.unpaid, paid: t.paidTag, expired: t.expiredTag };
    const name = await this.productName(order.productId), e = escapeHtml, yuan = (order.amountFen / 100).toFixed(2);
    const data = {
      s, pay: `${this.orderUrl(outTradeNo)}/pay`, renew: `${this.orderUrl(outTradeNo)}/renew`, status: `${this.deps.publicBase}/status?o=${outTradeNo}`, order: this.orderUrl(outTradeNo),
      left: Math.max(0, expiresAt - now), url: s === "paid" ? orderCode(order.code) : null, conf: returned && s === "unpaid", auto: !returned && s === "unpaid", ...openid ? { openid } : {}
    };
    this.html(res, 200, page(locale, `${checkoutCss(`${this.deps.publicBase}/font/${FONT}`)}<main class="co"><div class="card" id="card" data-s="${s}"><header class="hd">${LOCKUP}${name ? `<h1>${e(name)}</h1>` : ""}</header><dl><div><dt>${t.orderNo}</dt><dd><span class="no" id="no">${outTradeNo}</span><button type="button" class="cp" id="cp">${t.copy}</button><span class="pill" id="pill">${tag[s]}</span></dd></div><div><dt>${t.email}</dt><dd>${e(order.email)}</dd></div></dl><p class="price">¥${yuan}</p><button class="btn" id="pay">${WECHAT_MARK}<span class="spin"></span><span>${t.wechatPay} ¥${yuan}</span></button><button class="btn" id="renew">${t.renew}</button><div id="qr"></div><div id="err"></div></div></main>`, `
const D=${jsLiteral(data)},PILL=${jsLiteral(tag)},$=id=>document.getElementById(id),card=$('card'),btn=$('pay'),err=$('err'),qr=$('qr'),pill=$('pill'),rn=$('renew'),cp=$('cp');
const setS=s=>{card.dataset.s=s;pill.textContent=PILL[s]};
let busy=false,done=false;
const paid=u=>{done=true;setS('paid');err.textContent='';qr.innerHTML='<div class="done"><div class="ok"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>'+${jsLiteral(t.paid)}+'</div>';
 setTimeout(()=>{qr.innerHTML='<div class="done"><div class="spin2"></div>'+${jsLiteral(t.redirecting)}+'</div>';location.href=u},800)};
const expire=()=>{if(card.dataset.s!=='unpaid')return;done=true;busy=false;setS('expired');qr.innerHTML='';err.textContent=''};
const fail=m=>{err.style.color='';err.textContent=m;busy=false;btn.disabled=false;btn.ariaBusy='false';btn.classList.remove('busy')};
const post=u=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(D.openid?{openid:D.openid}:{})});
const go=async()=>{if(busy)return;busy=true;btn.ariaBusy='true';btn.classList.add('busy');err.style.color='';err.textContent='';
 try{const r=await post(D.pay),j=await r.json();
  if(j.expired){expire();return}
  if(j.paid){location.replace(D.order);return}
  if(!r.ok)return fail(j.error||${jsLiteral(t.orderFailed)});
  if(j.mode==='h5'){location.href=j.url;return}
  if(j.mode==='native'){btn.style.display='none';qr.innerHTML=j.qrSvg+${jsLiteral(t.scan)};
   const poll=setInterval(async()=>{if(done)return clearInterval(poll);try{const p=await(await fetch(D.status)).json();if(p.paid){clearInterval(poll);paid(p.url)}}catch(e){}},3000);return}
  WeixinJSBridge.invoke('getBrandWCPayRequest',j.params,x=>{if(x.err_msg==='get_brand_wcpay_request:ok')location.replace(D.order);else fail(${jsLiteral(t.notCompleted)})});
 }catch(e){fail(${jsLiteral(t.network)})}};
btn.onclick=go;
rn.onclick=async()=>{if(rn.classList.contains('busy'))return;rn.classList.add('busy');err.textContent='';
 try{const r=await post(D.renew),j=await r.json();if(r.ok)return void(location.href=j.url);err.textContent=j.error||${jsLiteral(t.orderFailed)}}catch(e){err.textContent=${jsLiteral(t.network)}}rn.classList.remove('busy')};
cp.onclick=()=>{const ok=()=>{cp.textContent=${jsLiteral(t.copied)};setTimeout(()=>{cp.textContent=${jsLiteral(t.copy)}},1500)};
 if(navigator.clipboard)navigator.clipboard.writeText($('no').textContent).then(ok,()=>{})};
if(D.s==='paid')paid(D.url);
else if(D.s==='unpaid'){
 setTimeout(expire,D.left);
 if(D.conf){const t0=Date.now();err.style.color='#6b6455';err.innerHTML='<span class="mini"></span>'+${jsLiteral(t.confirming)};
  const tick=async()=>{if(done)return;try{const p=await(await fetch(D.status)).json();if(p.paid)return paid(p.url)}catch(e){}
   if(Date.now()-t0<10000)setTimeout(tick,1500);else{err.style.color='';err.textContent=''}};
  tick()}
 else if(D.auto&&!D.openid&&((performance.getEntriesByType('navigation')[0]||{}).type!=='back_forward'))go();
}
addEventListener('pageshow',e=>{if(e.persisted){busy=false;fail('')}});`));
  }

  /** The WeChat order for this number, made (again) by the way the visitor can pay. The same number, amount and expiry every time, so WeChat takes a repeat of the same kind. */
  private async pay(req: http.IncomingMessage, res: http.ServerResponse, outTradeNo: string) {
    if (!this.fromMerchantPage(req)) return this.json(res, 403, { error: "forbidden" });
    const order = await this.load(outTradeNo);
    if (!order) return this.json(res, 404, { error: COPY[DEFAULT_LOCALE].noOrder });
    const t = COPY[localeOf(order.locale)];
    if (order.status !== "pending") return this.json(res, 409, { paid: true });
    const expiresAt = this.expiresAt(order);
    if (this.now() >= expiresAt) return this.json(res, 409, { expired: true });
    let body: Record<string, unknown>;
    try { body = JSON.parse((await readBoundedBytes(req, 8 * 1024)).toString("utf8") || "{}"); } catch { return this.json(res, 400, { error: t.badRequest }); }
    const openid = typeof body.openid === "string" && body.openid ? body.openid : undefined;
    const payerIp = payerIpOf(req.headers), native = !openid && isDesktop(req);
    if (!openid && !native && !payerIp) return this.json(res, 400, { error: t.noIp });
    const input = { outTradeNo, description: "Hatch 兑换码", amountFen: order.amountFen, expiresAt };
    try {
      if (openid) return this.json(res, 200, { mode: "jsapi", params: this.deps.wechat.jsapiInvokeParams((await this.deps.wechat.createJsapiOrder({ ...input, openid })).prepayId) });
      if (native) return this.json(res, 200, { mode: "native", qrSvg: qrSvg((await this.deps.wechat.createNativeOrder(input)).codeUrl) });
      const { h5Url } = await this.deps.wechat.createH5Order({ ...input, payerIp: payerIp! });
      return this.json(res, 200, { mode: "h5", url: `${h5Url}&redirect_url=${encodeURIComponent(`${this.orderUrl(outTradeNo)}?r=1`)}` });
    } catch (error) {
      if (error instanceof WeChatPayError && error.code === "ORDERPAID") return this.json(res, 409, { paid: true });
      if (error instanceof WeChatPayError && ORDER_GONE.has(error.code)) return this.json(res, 409, { expired: true });
      log.error("hatch_pay_order_failed", { outTradeNo, error });
      return this.json(res, 502, { error: t.orderFailedLater });
    }
  }

  /** An expired order is left as it is; a new one with the same Product, email, name and language takes its place. */
  private async renew(req: http.IncomingMessage, res: http.ServerResponse, outTradeNo: string) {
    if (!this.fromMerchantPage(req)) return this.json(res, 403, { error: "forbidden" });
    const order = await this.load(outTradeNo);
    if (!order) return this.json(res, 404, { error: COPY[DEFAULT_LOCALE].noOrder });
    const t = COPY[localeOf(order.locale)];
    if (order.status !== "pending" || this.now() < this.expiresAt(order)) return this.json(res, 409, { error: t.notExpired });
    if (!await this.deps.capabilities.has(order.productId, ACCESS_CODE_CAPABILITY)) return this.json(res, 403, { error: t.unsellable });
    const created = await this.deps.codes.createPending({ productId: order.productId, email: order.email, ...order.name ? { name: order.name } : {}, ...order.locale ? { locale: order.locale } : {} });
    this.json(res, 200, { url: this.orderUrl(created.outTradeNo) });
  }

  /** The OAuth return (kept for a later JSAPI flow; WeChat's own browser is sent to the guide before it): the order page, with the payer's openid. */
  private async oauth(res: http.ServerResponse, url: URL) {
    const outTradeNo = url.searchParams.get("o") ?? "", code = url.searchParams.get("code"), order = TRADE_NO.test(outTradeNo) ? await this.load(outTradeNo) : undefined;
    if (!order) return this.html(res, 404, page(DEFAULT_LOCALE, `<p>${COPY[DEFAULT_LOCALE].noOrder}</p>`));
    const locale = localeOf(order.locale), t = COPY[locale];
    const retry = `<a class="btn" href="${escapeHtml(this.orderUrl(outTradeNo))}">${t.retry}</a>`;
    if (!code) return this.html(res, 400, page(locale, `<p>${t.noAuth}</p>${retry}`));
    let openid: string;
    try { openid = await this.deps.openids.openidFor(code); } catch (error) {
      log.error("hatch_pay_oauth_failed", { error });
      return this.html(res, 502, page(locale, `<p>${t.authFailed}</p>${retry}`));
    }
    await this.orderPage(res, outTradeNo, false, openid);
  }

  /** Whether WeChat has the order as paid. A paid one is settled here too (idempotent), so `paid` always means the code is active, and says where to go. */
  private async status(res: http.ServerResponse, url: URL) {
    const outTradeNo = url.searchParams.get("o") ?? "";
    if (!TRADE_NO.test(outTradeNo) || !await this.deps.codes.order(outTradeNo)) return this.json(res, 404, { error: COPY[localeOf(url.searchParams.get("locale"))].noOrder });
    try {
      const state = await this.deps.wechat.queryOrder(outTradeNo);
      if (state.tradeState !== "SUCCESS") return this.json(res, 200, { paid: false });
      const settled = await this.settle(state);
      return this.json(res, 200, settled && (settled.status === "active" || settled.status === "used") ? { paid: true, url: orderCode(settled.code) } : { paid: false });
    } catch (error) {
      log.error("hatch_pay_status_failed", { outTradeNo, error });
      return this.json(res, 502, { error: COPY[localeOf(url.searchParams.get("locale"))].queryFailed });
    }
  }

  /** Orders made before the order page existed returned here from WeChat's cashier; their page is the order's. */
  private return(res: http.ServerResponse, url: URL) {
    const outTradeNo = url.searchParams.get("o") ?? "";
    if (!TRADE_NO.test(outTradeNo)) return this.html(res, 400, page(DEFAULT_LOCALE, `<p>${COPY[DEFAULT_LOCALE].invalid}</p>`));
    this.redirect(res, `${this.orderUrl(outTradeNo)}?r=1`);
  }

  private async notify(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = (await readBoundedBytes(req, 64 * 1024)).toString("utf8");
    const headers: Record<string, string | undefined> = {};
    for (const name of ["wechatpay-signature", "wechatpay-serial", "wechatpay-timestamp", "wechatpay-nonce"]) headers[name] = [req.headers[name]].flat()[0];
    let state: OrderState;
    try { state = await this.deps.wechat.readNotification(headers, body); } catch (error) {
      if (!(error instanceof NotificationRejected)) throw error;
      log.warn("hatch_pay_notification_rejected", { reason: error.message });
      return this.json(res, 401, { code: "FAIL", message: "invalid notification" });
    }
    // A verified notification of anything but a paid transaction needs no work.
    if (state.tradeState !== "SUCCESS") { res.writeHead(204); return void res.end(); }
    try { await this.settle(state); } catch (error) {
      log.error("hatch_pay_notification_failed", { outTradeNo: state.outTradeNo, error });
      return this.json(res, 500, { code: "FAIL", message: "try again" });
    }
    res.writeHead(204);
    res.end();
  }

  /** A paid order: activate (once) and, for the call that did, mail the code. The mail never undoes the activation. */
  private async settle(state: OrderState): Promise<Activation | undefined> {
    if (!state.transactionId || state.amountFen === undefined) throw new Error(`Paid order ${state.outTradeNo} has no transaction or amount.`);
    const activation = await this.deps.codes.activatePaid({ outTradeNo: state.outTradeNo, transactionId: state.transactionId, amountFen: state.amountFen });
    if (!activation) log.error("hatch_pay_unknown_paid_order", { outTradeNo: state.outTradeNo, transactionId: state.transactionId });
    else if (activation.status === "pending") log.error("hatch_pay_amount_mismatch", { outTradeNo: state.outTradeNo, transactionId: state.transactionId, amountFen: state.amountFen });
    else if (activation.activated && activation.email) {
      // In the background: the retries take up to 26s, and neither the WeChat callback nor the return page waits for them.
      this.deps.mailer.send({ code: activation.code, productId: activation.productId, to: activation.email, ...activation.name ? { name: activation.name } : {}, ...activation.locale ? { locale: activation.locale } : {} })
        .catch(error => log.error("hatch_pay_email_failed", { outTradeNo: state.outTradeNo, code: activation.code, error }));
    }
    return activation;
  }
}

/** The /hatch-pay/ routes of the Runtime's HTTP server; 503 while payments are not configured. */
export async function handleHatchPayRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pay: HatchPay | undefined): Promise<void> {
  if (pay) return pay.handle(req, res, url);
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end(COPY[localeOf(url.searchParams.get("locale"))].closed);
}
