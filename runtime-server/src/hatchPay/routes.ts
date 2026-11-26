import type http from "node:http";
import qrcode from "qrcode-generator";
import type { AccessCodes, Activation } from "../accessCodes/accessCodes.js";
import { payerIp as payerIpOf } from "./payerIp.js";
import type { AgentCorpusResolverLike } from "../agentCorpus.js";
import type { ProductCapabilities } from "../agentBox/capabilities.js";
import { log } from "../observability/log.js";
import { readBoundedBytes } from "../http/httpSupport.js";
import type { CodeMailer } from "./codeMail.js";
import { escapeHtml } from "./email.js";
import { DEFAULT_LOCALE, localeOf, type Locale } from "../locale.js";
import type { OpenIdResolver } from "./wechatOAuth.js";
import { NotificationRejected, type OrderState, type WeChatPay } from "./wechatPay.js";

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

/** What a visitor reads on these pages, by language. The WeChat Pay order's own description is not here: it stays Chinese, as WeChat's API wants. */
const COPY = {
  zh: { lang: "zh-CN", closed: "支付暂未开放", guide: "请点击右上角 ··· 选择『在浏览器打开』", openBrowser: "请在浏览器打开", invalid: "链接无效", unsellable: "不可购买", notFound: "页面不存在", failed: "出错了，请稍后重试", noAuth: "未获得授权", authFailed: "授权失败", retry: "重试", site: "网站", name: "姓名", sendTo: "兑换码发送至", pay: "支付", orderFailed: "下单失败", orderFailedLater: "下单失败，请稍后重试", notCompleted: "支付未完成", network: "网络错误，请重试", queryFailed: "查询失败，请稍后重试", checkPaid: "我已支付，查询结果", payAgain: "重新支付", mismatch: "支付金额与订单不符，请联系我们", noOrder: "订单不存在", yourCode: "你的访问码", badRequest: "请求无效", noIp: "无法获取网络地址", scan: "请用微信扫码支付", redirecting: "支付成功，正在跳转…" },
  en: { lang: "en", closed: "Payments are not open yet", guide: "Tap ··· at the top right and choose “Open in browser”", openBrowser: "Please open this in a browser", invalid: "Invalid link", unsellable: "Not available for purchase", notFound: "Page not found", failed: "Something went wrong. Please try again later.", noAuth: "Not authorized", authFailed: "Authorization failed", retry: "Try again", site: "Website", name: "Name", sendTo: "Code sent to", pay: "Pay", orderFailed: "Could not create the order", orderFailedLater: "Could not create the order. Please try again later.", notCompleted: "Payment was not completed", network: "Network error. Please try again.", queryFailed: "Could not check the payment. Please try again later.", checkPaid: "I have paid, check the result", payAgain: "Pay again", mismatch: "The amount paid does not match the order. Please contact us.", noOrder: "Order not found", yourCode: "Your access code", badRequest: "Invalid request", noIp: "Could not read your network address", scan: "Scan with WeChat to pay", redirecting: "Payment received, redirecting…" },
  ja: { lang: "ja", closed: "決済はまだ開始されていません", guide: "右上の ··· をタップして「ブラウザで開く」を選んでください", openBrowser: "ブラウザで開いてください", invalid: "無効なリンクです", unsellable: "購入できません", notFound: "ページが見つかりません", failed: "エラーが発生しました。しばらくしてからもう一度お試しください。", noAuth: "認証されませんでした", authFailed: "認証に失敗しました", retry: "やり直す", site: "ウェブサイト", name: "お名前", sendTo: "コードの送付先", pay: "支払う", orderFailed: "注文を作成できませんでした", orderFailedLater: "注文を作成できませんでした。しばらくしてからもう一度お試しください。", notCompleted: "支払いが完了しませんでした", network: "ネットワークエラーです。もう一度お試しください。", queryFailed: "確認に失敗しました。しばらくしてからもう一度お試しください。", checkPaid: "支払い済み、結果を確認する", payAgain: "もう一度支払う", mismatch: "お支払い金額が注文と一致しません。お問い合わせください。", noOrder: "注文が見つかりません", yourCode: "アクセスコード", badRequest: "無効なリクエストです", noIp: "ネットワークアドレスを取得できません", scan: "WeChatでスキャンして支払う", redirecting: "お支払いを確認しました。移動しています…" }
} satisfies Record<Locale, Record<string, string>>;

const PAGE_HEAD = (locale: Locale) => `<!doctype html><html lang="${COPY[locale].lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hatch</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:64px 24px;text-align:center}.price{font-size:44px;margin:0 0 32px}.btn{display:inline-block;font:inherit;padding:12px 40px;border:0;border-radius:8px;background:#111;color:#fff;text-decoration:none}.btn:disabled{opacity:.5}.alt{display:block;margin-top:20px;color:#555}.code{font:700 32px ui-monospace,monospace;letter-spacing:4px}#err{color:#b00020;margin-top:16px}</style></head><body>`;
const guide = (locale: Locale) => `<svg width="72" height="72" viewBox="0 0 72 72" style="position:fixed;top:12px;right:16px" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 58C20 36 38 22 58 14M40 12l18 2-4 18"/></svg><p style="margin-top:120px;font-size:20px">${COPY[locale].guide}</p>`;
const page = (locale: Locale, body: string, script = "") => `${PAGE_HEAD(locale)}${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
const LOGO = "https://hatch-downloads.oss-cn-shanghai.aliyuncs.com/brand/cobrand/msc-x-hatch-light.png";
const CHECKOUT_CSS = `<style>
:root{--ink:#111315;--bg:#faf8f4;--line:#e8e4dc;--mute:#6b6f73}
body{background:var(--bg);color:var(--ink);padding:28px 16px;text-align:left}
main.co{max-width:420px;margin:0 auto}
.co .logo{display:block;width:260px;max-width:80%;height:auto;margin:0 auto 24px}
.co .card{background:#fff;border:1px solid var(--line);border-radius:16px;padding:20px;box-shadow:0 1px 2px rgba(17,19,21,.04)}
.co h1{font-size:19px;line-height:1.35;margin:0}
.co .desc{margin:10px 0 0;font-size:14px;color:#3a3d40}
.co dl{margin:16px 0 0;border-top:1px solid var(--line)}
.co dl div{display:flex;justify-content:space-between;gap:16px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px}
.co dt{color:var(--mute);flex:none}.co dd{margin:0;text-align:right;overflow-wrap:anywhere}
.co .price{font-size:36px;font-weight:700;letter-spacing:-.5px;margin:18px 0 0;background:linear-gradient(90deg,#469A21,#0D7FBB);-webkit-background-clip:text;background-clip:text;color:transparent}
.co .btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:16px;padding:14px;border-radius:12px;font-size:17px;font-weight:600;cursor:pointer}
.co .btn:disabled{opacity:.6;cursor:default}
.co .spin{display:none;width:16px;height:16px;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;border-radius:50%;animation:sp .7s linear infinite}
.co .btn.busy .spin{display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}
.co #err{min-height:20px;text-align:center;font-size:14px}
.co .done .spin2{width:32px;height:32px;margin:0 auto 12px;box-sizing:border-box;border:3px solid #d9f3e4;border-top-color:#07c160;border-radius:50%;animation:sp .8s linear infinite}
@media (prefers-reduced-motion:reduce){.co .spin,.co .spin2{animation-duration:2s}}
.co #qr{text-align:center;margin-top:16px;font-size:14px}.co #qr svg{display:block;width:220px;height:220px;margin:0 auto 8px}
</style>`;
/** The site as a bare domain, or undefined when it is not a plausible one. */
export const siteDomain = (value: string | null): string | undefined => {
  const raw = (value ?? "").trim();
  if (!raw || raw.length > 300) return undefined;
  try {
    const host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./i, "").toLowerCase();
    return /^(?=.{3,253}$)([a-z0-9¡-￿-]{1,63}\.)+[a-z¡-￿]{2,63}$/.test(host) ? host : undefined;
  } catch { return undefined; }
};
const buyerName = (value: string | null) => { const name = (value ?? "").replace(/\s+/g, " ").trim(); return name && name.length <= 40 ? name : undefined; };
const jsLiteral = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export class HatchPay {
  constructor(private readonly deps: HatchPayDeps) {}

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // Until WeChat's verification keys are loaded nothing it says can be checked: not open yet, and a notification is left for its retry.
    // A visitor's language is the web's `locale` query parameter on every page (the order POST carries it in its body); none or unknown is Chinese.
    const locale = localeOf(url.searchParams.get("locale")), t = COPY[locale];
    if (!this.deps.wechat.ready()) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "10" });
      return void res.end(t.closed);
    }
    const route = url.pathname.replace(/^\/hatch-pay\/?/, "/");
    // The buyer flow is H5 pay in a normal browser, never WeChat's in-app one: every buyer page there is the guide out of it, and no order is made. The notification is WeChat's own call.
    if (route !== "/notify" && /MicroMessenger/i.test(req.headers["user-agent"] ?? "")) {
      return req.method === "POST" ? this.json(res, 403, { error: t.openBrowser }) : this.html(res, 200, page(locale, guide(locale)));
    }
    try {
      if (req.method === "GET" && route === "/")return await this.payPage(req, res, url);
      if (req.method === "GET" && route === "/oauth") return await this.oauth(res, url);
      if (req.method === "POST" && route === "/order") return await this.order(req, res);
      if (req.method === "GET" && route === "/status") return await this.status(res, url);
      if (req.method === "GET" && route === "/return") return await this.return(res, url);
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

  /** product, email and the way back, or an error page. */
  private ask(url: URL) {
    const product = url.searchParams.get("product") ?? "", email = (url.searchParams.get("email") ?? "").trim(), back = url.searchParams.get("back");
    return PRODUCT.test(product) && EMAIL.test(email) && isChatUrl(back) ? { product, email, back, locale: localeOf(url.searchParams.get("locale")) } : undefined;
  }
  private payUrl(ask: { product: string; email: string; back: string; locale: Locale }) {
    return `${this.deps.publicBase}/?${new URLSearchParams(ask)}`;
  }

  private async payPage(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const ask = this.ask(url), locale = localeOf(url.searchParams.get("locale")), t = COPY[locale];
    if (!ask) return this.html(res, 400, page(locale, `<p>${t.invalid}</p>`));
    if (!await this.deps.capabilities.has(ask.product, ACCESS_CODE_CAPABILITY)) return this.html(res, 403, page(locale, `<p>${t.unsellable}</p>`));
    if (/MicroMessenger/i.test(req.headers["user-agent"] ?? "")) {
      // Not reached while handle() sends WeChat's browser to the guide; kept for a later JSAPI flow. Inside WeChat the payer is known by openid, which only an OAuth round trip reveals.
      return this.redirect(res, this.deps.openids.authorizeUrl(`${this.deps.publicBase}/oauth?${new URLSearchParams(ask)}`));
    }
    this.html(res, 200, await this.payHtml(ask, undefined, { site: siteDomain(url.searchParams.get("site")), name: buyerName(url.searchParams.get("name")) }));
  }

  private async oauth(res: http.ServerResponse, url: URL) {
    const ask = this.ask(url), code = url.searchParams.get("code"), locale = localeOf(url.searchParams.get("locale")), t = COPY[locale];
    if (!ask) return this.html(res, 400, page(locale, `<p>${t.invalid}</p>`));
    if (!await this.deps.capabilities.has(ask.product, ACCESS_CODE_CAPABILITY)) return this.html(res, 403, page(locale, `<p>${t.unsellable}</p>`));
    if (!code) return this.html(res, 400, page(locale, `<p>${t.noAuth}</p><a class="btn" href="${escapeHtml(this.payUrl(ask))}">${t.retry}</a>`));
    let openid: string;
    try { openid = await this.deps.openids.openidFor(code); } catch (error) {
      log.error("hatch_pay_oauth_failed", { error });
      return this.html(res, 502, page(locale, `<p>${t.authFailed}</p><a class="btn" href="${escapeHtml(this.payUrl(ask))}">${t.retry}</a>`));
    }
    this.html(res, 200, await this.payHtml(ask, openid));
  }

  /** What the card says about the Product; whatever the corpus cannot tell is left out, never invented. */
  private async productInfo(productId: string): Promise<{ name?: string; description?: string }> {
    try {
      const resolved = await this.deps.corpora?.resolveByProduct(productId);
      if (!resolved) return {};
      return { name: resolved.corpus.product.name, description: resolved.corpus.product.description };
    } catch (error) { log.warn("hatch_pay_corpus_unavailable", { productId, error }); return {}; }
  }

  private async payHtml(ask: { product: string; email: string; back: string; locale: Locale }, openid?: string, order: { site?: string; name?: string } = {}) {
    const yuan = (this.deps.priceFen / 100).toFixed(2);
    const info = await this.productInfo(ask.product), e = escapeHtml, t = COPY[ask.locale];
    const row = (label: string, value?: string) => value ? `<div><dt>${label}</dt><dd>${e(value)}</dd></div>` : "";
    const head = `${info.name ? `<h1>${e(info.name)}</h1>` : ""}${info.description ? `<p class="desc">${e(info.description)}</p>` : ""}`;
    return page(ask.locale, `${CHECKOUT_CSS}<main class="co"><img class="logo" src="${LOGO}" width="260" height="48" alt="MSC × Hatch"><div class="card">${head}<dl>${row(t.site, order.site)}${row(t.name, order.name)}${row(t.sendTo, ask.email)}</dl><p class="price">¥${yuan}</p><button class="btn" id="pay"><span class="spin"></span>${t.pay}</button><div id="qr"></div><div id="err"></div></div></main>`, `
const ask=${jsLiteral({ ...ask, ...order.name ? { name: order.name } : {}, ...openid ? { openid } : {} })},btn=document.getElementById('pay'),err=document.getElementById('err'),qr=document.getElementById('qr');
const paid=u=>{btn.style.display='none';err.textContent='';qr.innerHTML='<div class="done"><div class="spin2"></div>'+${jsLiteral(t.redirecting)}+'</div>';location.href=u};
const fail=m=>{err.textContent=m;btn.disabled=false;btn.classList.remove('busy')};
const go=async()=>{btn.disabled=true;btn.classList.add('busy');err.textContent='';
 try{const r=await fetch(${jsLiteral(`${this.deps.publicBase}/order`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ask)});
  const j=await r.json();if(!r.ok)return fail(j.error||${jsLiteral(t.orderFailed)});
  if(j.mode==='h5'){location.href=j.url;return}
  if(j.mode==='native'){btn.style.display='none';qr.innerHTML=j.qrSvg+${jsLiteral(t.scan)};
   const stop=()=>{clearInterval(poll);clearTimeout(expire)};
   const poll=setInterval(async()=>{try{if((await(await fetch(j.statusUrl)).json()).paid){stop();paid(j.returnUrl)}}catch(e){}},3000);
   const expire=setTimeout(()=>{stop();qr.innerHTML='';btn.style.display='';fail('')},${ORDER_MINUTES * 60_000});return}
  WeixinJSBridge.invoke('getBrandWCPayRequest',j.params,x=>{if(x.err_msg==='get_brand_wcpay_request:ok')paid(j.returnUrl);else fail(${jsLiteral(t.notCompleted)})});
 }catch(e){fail(${jsLiteral(t.network)})}};
btn.onclick=go;
let started=false;
const start=()=>{if(started)return;started=true;go()};
if(!ask.openid&&((performance.getEntriesByType('navigation')[0]||{}).type!=='back_forward'))start();
addEventListener('pageshow',e=>{if(e.persisted){started=true;fail('')}});`);
  }

  /** Origin (or Referer, for a client that sends no Origin) must be the merchant's own domain. */
  private fromMerchantPage(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin, referer = req.headers.referer;
    if (origin) return ORDER_ORIGINS.includes(origin);
    return !!referer && ORDER_ORIGINS.some(allowed => referer === allowed || referer.startsWith(`${allowed}/`));
  }

  private async order(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.fromMerchantPage(req)) return this.json(res, 403, { error: "forbidden" });
    let locale: Locale = DEFAULT_LOCALE;
    let body: Record<string, unknown>;
    try { body = JSON.parse((await readBoundedBytes(req, 8 * 1024)).toString("utf8")); } catch { return this.json(res, 400, { error: COPY[locale].badRequest }); }
    locale = localeOf(body.locale);
    const t = COPY[locale];
    const ask = this.ask(new URL(`http://x/?${new URLSearchParams({ product: String(body.product ?? ""), email: String(body.email ?? ""), back: String(body.back ?? ""), locale: String(body.locale ?? "") })}`));
    if (!ask) return this.json(res, 400, { error: t.invalid });
    if (!await this.deps.capabilities.has(ask.product, ACCESS_CODE_CAPABILITY)) return this.json(res, 403, { error: t.unsellable });
    const name = buyerName(typeof body.name === "string" ? body.name : null);
    const openid = typeof body.openid === "string" && body.openid ? body.openid : undefined;
    const payerIp = payerIpOf(req.headers);
    const native = !openid && isDesktop(req);
    if (!openid && !native && !payerIp) return this.json(res, 400, { error: t.noIp });

    const { code, outTradeNo } = await this.deps.codes.createPending({ productId: ask.product, email: ask.email, ...name ? { name } : {}, payChannel: openid ? "jsapi" : native ? "native" : "h5", locale });
    const returnUrl = `${this.deps.publicBase}/return?${new URLSearchParams({ o: outTradeNo, back: ask.back, locale })}`;
    const order = {
      outTradeNo, description: "Hatch 兑换码", amountFen: this.deps.priceFen,
      expiresAt: new Date((this.deps.now?.() ?? new Date()).getTime() + ORDER_MINUTES * 60_000)
    };
    try {
      if (openid) {
        const { prepayId } = await this.deps.wechat.createJsapiOrder({ ...order, openid });
        return this.json(res, 200, { mode: "jsapi", params: this.deps.wechat.jsapiInvokeParams(prepayId), returnUrl });
      }
      if (native) {
        const { codeUrl } = await this.deps.wechat.createNativeOrder(order);
        return this.json(res, 200, { mode: "native", qrSvg: qrSvg(codeUrl), statusUrl: `${this.deps.publicBase}/status?o=${outTradeNo}`, returnUrl });
      }
      const { h5Url } = await this.deps.wechat.createH5Order({ ...order, payerIp: payerIp! });
      return this.json(res, 200, { mode: "h5", url: `${h5Url}&redirect_url=${encodeURIComponent(returnUrl)}` });
    } catch (error) {
      log.error("hatch_pay_order_failed", { outTradeNo, code, error });
      return this.json(res, 502, { error: t.orderFailedLater });
    }
  }

  /** Whether WeChat has the order as paid; /return settles it. Read-only, so a page may poll it. */
  private async status(res: http.ServerResponse, url: URL) {
    const outTradeNo = url.searchParams.get("o") ?? "";
    if (!TRADE_NO.test(outTradeNo) || !await this.deps.codes.order(outTradeNo)) return this.json(res, 404, { error: COPY[localeOf(url.searchParams.get("locale"))].noOrder });
    try { return this.json(res, 200, { paid: (await this.deps.wechat.queryOrder(outTradeNo)).tradeState === "SUCCESS" }); } catch (error) {
      log.error("hatch_pay_status_failed", { outTradeNo, error });
      return this.json(res, 502, { error: COPY[localeOf(url.searchParams.get("locale"))].queryFailed });
    }
  }

  private async return(res: http.ServerResponse, url: URL) {
    const outTradeNo = url.searchParams.get("o") ?? "", back = url.searchParams.get("back");
    const locale = localeOf(url.searchParams.get("locale")), t = COPY[locale];
    if (!TRADE_NO.test(outTradeNo)) return this.html(res, 400, page(locale, `<p>${t.invalid}</p>`));
    const order = await this.deps.codes.order(outTradeNo);
    if (!order) return this.html(res, 404, page(locale, `<p>${t.noOrder}</p>`));
    let state: OrderState;
    try { state = await this.deps.wechat.queryOrder(outTradeNo); } catch (error) {
      log.error("hatch_pay_query_failed", { outTradeNo, error });
      return this.html(res, 502, this.waiting(url, locale, order, back, t.queryFailed));
    }
    if (state.tradeState !== "SUCCESS") return this.html(res, 200, this.waiting(url, locale, order, back));
    const settled = await this.settle(state);
    if (!settled || settled.status === "pending" || settled.status === "void") {
      return this.html(res, 409, page(locale, `<p>${t.mismatch}</p>`));
    }
    return isChatUrl(back)
      ? this.redirect(res, withCode(back, settled.code))
      : this.html(res, 200, page(locale, `<p>${t.yourCode}</p><p class="code">${escapeHtml(settled.code)}</p>`));
  }

  private waiting(url: URL, locale: Locale, order: { productId: string; email: string | null }, back: string | null, note?: string) {
    const again = isChatUrl(back) && order.email ? `<a class="alt" href="${escapeHtml(this.payUrl({ product: order.productId, email: order.email, back, locale }))}">${COPY[locale].payAgain}</a>` : "";
    return page(locale, `${note ? `<p>${escapeHtml(note)}</p>` : ""}<a class="btn" href="${escapeHtml(url.pathname + url.search)}">${COPY[locale].checkPaid}</a>${again}`);
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
