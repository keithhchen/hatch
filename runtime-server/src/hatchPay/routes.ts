import type http from "node:http";
import type { AccessCodes, Activation } from "../accessCodes/accessCodes.js";
import { payerIp as payerIpOf } from "../accessCodes/rateLimit.js";
import type { ProductCapabilities } from "../agentBox/capabilities.js";
import { log } from "../observability/log.js";
import { readBoundedBytes } from "../http/httpSupport.js";
import type { CodeMailer } from "./codeMail.js";
import { escapeHtml } from "./email.js";
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

const isChatUrl = (value: string | null): value is string => {
  if (!value) return false;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "gethatchapp.com" || url.hostname.endsWith(".gethatchapp.com")); } catch { return false; }
};
const withCode = (back: string, code: string) => { const url = new URL(back); url.searchParams.set("code", code); return url.toString(); };

const PAGE_HEAD = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hatch</title>
<style>body{font:16px/1.6 system-ui,sans-serif;margin:0;padding:64px 24px;text-align:center}.price{font-size:44px;margin:0 0 32px}.btn{display:inline-block;font:inherit;padding:12px 40px;border:0;border-radius:8px;background:#111;color:#fff;text-decoration:none}.btn:disabled{opacity:.5}.alt{display:block;margin-top:20px;color:#555}.code{font:700 32px ui-monospace,monospace;letter-spacing:4px}#err{color:#b00020;margin-top:16px}</style></head><body>`;
const GUIDE = `<svg width="72" height="72" viewBox="0 0 72 72" style="position:fixed;top:12px;right:16px" fill="none" stroke="#111" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 58C20 36 38 22 58 14M40 12l18 2-4 18"/></svg><p style="margin-top:120px;font-size:20px">请点击右上角 ··· 选择『在浏览器打开』</p>`;
const page = (body: string, script = "") => `${PAGE_HEAD}${body}${script ? `<script>${script}</script>` : ""}</body></html>`;
const jsLiteral = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export class HatchPay {
  constructor(private readonly deps: HatchPayDeps) {}

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    // Until WeChat's verification keys are loaded nothing it says can be checked: not open yet, and a notification is left for its retry.
    if (!this.deps.wechat.ready()) {
      res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "retry-after": "10" });
      return void res.end("支付暂未开放");
    }
    const route = url.pathname.replace(/^\/hatch-pay\/?/, "/");
    // The buyer flow is H5 pay in a normal browser, never WeChat's in-app one: every buyer page there is the guide out of it, and no order is made. The notification is WeChat's own call.
    if (route !== "/notify" && /MicroMessenger/i.test(req.headers["user-agent"] ?? "")) {
      return req.method === "POST" ? this.json(res, 403, { error: "请在浏览器打开" }) : this.html(res, 200, page(GUIDE));
    }
    try {
      if (req.method === "GET" && route === "/")return await this.payPage(req, res, url);
      if (req.method === "GET" && route === "/oauth") return await this.oauth(res, url);
      if (req.method === "POST" && route === "/order") return await this.order(req, res);
      if (req.method === "GET" && route === "/return") return await this.return(res, url);
      if (req.method === "POST" && route === "/notify") return await this.notify(req, res);
      this.html(res, 404, page("<p>页面不存在</p>"));
    } catch (error) {
      log.error("hatch_pay_request_failed", { route, error });
      if (!res.headersSent) this.html(res, 500, page("<p>出错了，请稍后重试</p>"));
    }
  }

  private html(res: http.ServerResponse, status: number, body: string) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
    res.end(body);
  }
  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }
  private redirect(res: http.ServerResponse, location: string) {
    res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  }

  /** product, email and the way back, or an error page. */
  private ask(url: URL) {
    const product = url.searchParams.get("product") ?? "", email = (url.searchParams.get("email") ?? "").trim(), back = url.searchParams.get("back");
    return PRODUCT.test(product) && EMAIL.test(email) && isChatUrl(back) ? { product, email, back } : undefined;
  }
  private payUrl(ask: { product: string; email: string; back: string }) {
    return `${this.deps.publicBase}/?${new URLSearchParams(ask)}`;
  }

  private async payPage(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const ask = this.ask(url);
    if (!ask) return this.html(res, 400, page("<p>链接无效</p>"));
    if (!await this.deps.capabilities.has(ask.product, ACCESS_CODE_CAPABILITY)) return this.html(res, 403, page("<p>不可购买</p>"));
    if (/MicroMessenger/i.test(req.headers["user-agent"] ?? "")) {
      // Not reached while handle() sends WeChat's browser to the guide; kept for a later JSAPI flow. Inside WeChat the payer is known by openid, which only an OAuth round trip reveals.
      return this.redirect(res, this.deps.openids.authorizeUrl(`${this.deps.publicBase}/oauth?${new URLSearchParams(ask)}`));
    }
    this.html(res, 200, this.payHtml(ask));
  }

  private async oauth(res: http.ServerResponse, url: URL) {
    const ask = this.ask(url), code = url.searchParams.get("code");
    if (!ask) return this.html(res, 400, page("<p>链接无效</p>"));
    if (!await this.deps.capabilities.has(ask.product, ACCESS_CODE_CAPABILITY)) return this.html(res, 403, page("<p>不可购买</p>"));
    if (!code) return this.html(res, 400, page(`<p>未获得授权</p><a class="btn" href="${escapeHtml(this.payUrl(ask))}">重试</a>`));
    let openid: string;
    try { openid = await this.deps.openids.openidFor(code); } catch (error) {
      log.error("hatch_pay_oauth_failed", { error });
      return this.html(res, 502, page(`<p>授权失败</p><a class="btn" href="${escapeHtml(this.payUrl(ask))}">重试</a>`));
    }
    this.html(res, 200, this.payHtml(ask, openid));
  }

  private payHtml(ask: { product: string; email: string; back: string }, openid?: string) {
    const yuan = (this.deps.priceFen / 100).toFixed(2).replace(/\.?0+$/, "");
    return page(`<p class="price">¥${yuan}</p><button class="btn" id="pay">支付</button><div id="err"></div>`, `
const ask=${jsLiteral({ ...ask, ...openid ? { openid } : {} })},btn=document.getElementById('pay'),err=document.getElementById('err');
const fail=m=>{err.textContent=m;btn.disabled=false};
btn.onclick=async()=>{btn.disabled=true;err.textContent='';
 try{const r=await fetch(${jsLiteral(`${this.deps.publicBase}/order`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(ask)});
  const j=await r.json();if(!r.ok)return fail(j.error||'下单失败');
  if(j.mode==='h5'){location.href=j.url;return}
  WeixinJSBridge.invoke('getBrandWCPayRequest',j.params,x=>{if(x.err_msg==='get_brand_wcpay_request:ok')location.href=j.returnUrl;else fail('支付未完成')});
 }catch(e){fail('网络错误，请重试')}};`);
  }

  /** Origin (or Referer, for a client that sends no Origin) must be the merchant's own domain. */
  private fromMerchantPage(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin, referer = req.headers.referer;
    if (origin) return ORDER_ORIGINS.includes(origin);
    return !!referer && ORDER_ORIGINS.some(allowed => referer === allowed || referer.startsWith(`${allowed}/`));
  }

  private async order(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.fromMerchantPage(req)) return this.json(res, 403, { error: "forbidden" });
    let body: Record<string, unknown>;
    try { body = JSON.parse((await readBoundedBytes(req, 8 * 1024)).toString("utf8")); } catch { return this.json(res, 400, { error: "请求无效" }); }
    const ask = this.ask(new URL(`http://x/?${new URLSearchParams({ product: String(body.product ?? ""), email: String(body.email ?? ""), back: String(body.back ?? "") })}`));
    if (!ask) return this.json(res, 400, { error: "链接无效" });
    if (!await this.deps.capabilities.has(ask.product, ACCESS_CODE_CAPABILITY)) return this.json(res, 403, { error: "不可购买" });
    const openid = typeof body.openid === "string" && body.openid ? body.openid : undefined;
    const payerIp = payerIpOf(req.headers);
    if (!openid && !payerIp) return this.json(res, 400, { error: "无法获取网络地址" });

    const { code, outTradeNo } = await this.deps.codes.createPending({ productId: ask.product, email: ask.email, payChannel: openid ? "jsapi" : "h5" });
    const returnUrl = `${this.deps.publicBase}/return?${new URLSearchParams({ o: outTradeNo, back: ask.back })}`;
    const order = {
      outTradeNo, description: "Hatch 兑换码", amountFen: this.deps.priceFen,
      expiresAt: new Date((this.deps.now?.() ?? new Date()).getTime() + ORDER_MINUTES * 60_000)
    };
    try {
      if (openid) {
        const { prepayId } = await this.deps.wechat.createJsapiOrder({ ...order, openid });
        return this.json(res, 200, { mode: "jsapi", params: this.deps.wechat.jsapiInvokeParams(prepayId), returnUrl });
      }
      const { h5Url } = await this.deps.wechat.createH5Order({ ...order, payerIp: payerIp! });
      return this.json(res, 200, { mode: "h5", url: `${h5Url}&redirect_url=${encodeURIComponent(returnUrl)}` });
    } catch (error) {
      log.error("hatch_pay_order_failed", { outTradeNo, code, error });
      return this.json(res, 502, { error: "下单失败，请稍后重试" });
    }
  }

  private async return(res: http.ServerResponse, url: URL) {
    const outTradeNo = url.searchParams.get("o") ?? "", back = url.searchParams.get("back");
    if (!TRADE_NO.test(outTradeNo)) return this.html(res, 400, page("<p>链接无效</p>"));
    const order = await this.deps.codes.order(outTradeNo);
    if (!order) return this.html(res, 404, page("<p>订单不存在</p>"));
    let state: OrderState;
    try { state = await this.deps.wechat.queryOrder(outTradeNo); } catch (error) {
      log.error("hatch_pay_query_failed", { outTradeNo, error });
      return this.html(res, 502, this.waiting(url, order, back, "查询失败，请稍后重试"));
    }
    if (state.tradeState !== "SUCCESS") return this.html(res, 200, this.waiting(url, order, back));
    const settled = await this.settle(state);
    if (!settled || settled.status === "pending" || settled.status === "void") {
      return this.html(res, 409, page("<p>支付金额与订单不符，请联系我们</p>"));
    }
    return isChatUrl(back)
      ? this.redirect(res, withCode(back, settled.code))
      : this.html(res, 200, page(`<p>你的访问码</p><p class="code">${escapeHtml(settled.code)}</p>`));
  }

  private waiting(url: URL, order: { productId: string; email: string | null }, back: string | null, note?: string) {
    const again = isChatUrl(back) && order.email ? `<a class="alt" href="${escapeHtml(this.payUrl({ product: order.productId, email: order.email, back }))}">重新支付</a>` : "";
    return page(`${note ? `<p>${escapeHtml(note)}</p>` : ""}<a class="btn" href="${escapeHtml(url.pathname + url.search)}">我已支付，查询结果</a>${again}`);
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
      try {
        await this.deps.mailer.send({ code: activation.code, productId: activation.productId, to: activation.email });
      } catch (error) { log.error("hatch_pay_email_failed", { outTradeNo: state.outTradeNo, code: activation.code, error }); }
    }
    return activation;
  }
}

/** The /hatch-pay/ routes of the Runtime's HTTP server; 503 while payments are not configured. */
export async function handleHatchPayRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, pay: HatchPay | undefined): Promise<void> {
  if (pay) return pay.handle(req, res, url);
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  res.end("支付暂未开放");
}
