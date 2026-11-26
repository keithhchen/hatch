import http from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import type { Locale } from "../locale.js";
import { HatchPay, handleHatchPayRoute } from "./routes.js";

export const PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
export const NO = `hp${"b".repeat(24)}`;
export const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
export const PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mobile/15E148) Mobile/15E148 Safari/604.1";
export const MERCHANT = { origin: "https://anyteach.cn", "content-type": "application/json" };
const corpora = { resolveByProduct: async () => ({ corpus: { creator: { name: "MSC咨询" }, product: { name: "出海官网获客诊断" } } }) };

export type Row = { code: string; productId: string; email: string; name: string | null; locale: Locale | null; status: "pending" | "active" | "used"; source: "paid"; outTradeNo: string; amountFen: number; createdAt: Date };

/** The order page and its routes against in-memory codes and a scripted WeChat: a real HTTP server, no network. */
export async function serve(options: { withCorpora?: boolean } = {}) {
  const clock = { now: new Date("2026-11-27T10:00:00Z") };
  const orders = new Map<string, Row>(), trade = { state: "NOTPAY", reject: undefined as Error | undefined };
  const made = { native: [] as Array<Record<string, unknown>>, h5: [] as Array<Record<string, unknown>>, jsapi: [] as Array<Record<string, unknown>> };
  const created: Array<Record<string, unknown>> = [], mailed: Array<Record<string, unknown>> = [], activations: string[] = [];
  let sequence = 0;
  const seed = (extra: Partial<Row> = {}) => {
    const row: Row = { code: "MSC222222", productId: PRODUCT, email: "a@b.co", name: null, locale: "zh", status: "pending", source: "paid", outTradeNo: NO, amountFen: 990, createdAt: clock.now, ...extra };
    orders.set(row.outTradeNo, row);
    return row;
  };
  const pay = new HatchPay({
    capabilities: new InMemoryProductCapabilities([[PRODUCT, "access_code"]]), publicBase: "https://anyteach.cn/hatch-pay", priceFen: 990, now: () => clock.now,
    wechat: {
      ready: () => true,
      queryOrder: async (outTradeNo: string) => ({ outTradeNo, tradeState: trade.state, transactionId: "42", amountFen: 990 }),
      createNativeOrder: async (input: Record<string, unknown>) => { if (trade.reject) throw trade.reject; made.native.push(input); return { codeUrl: "weixin://wxpay/bizpayurl?pr=abc" }; },
      createH5Order: async (input: Record<string, unknown>) => { if (trade.reject) throw trade.reject; made.h5.push(input); return { h5Url: "https://wx.example/pay?a=1" }; },
      createJsapiOrder: async (input: Record<string, unknown>) => { made.jsapi.push(input); return { prepayId: "wx1" }; },
      jsapiInvokeParams: (prepayId: string) => ({ package: `prepay_id=${prepayId}` })
    },
    codes: {
      createPending: async (input: Record<string, unknown>) => {
        created.push(input);
        const outTradeNo = `hp${(++sequence).toString(16).padStart(24, "0")}`;
        seed({ outTradeNo, code: `MSC00000${sequence}`, email: String(input.email), name: (input.name as string | undefined) ?? null, locale: (input.locale as Locale | undefined) ?? null });
        return { code: `MSC00000${sequence}`, outTradeNo };
      },
      order: async (outTradeNo: string) => orders.get(outTradeNo) && { ...orders.get(outTradeNo)! },
      activatePaid: async (input: { outTradeNo: string; amountFen: number }) => {
        const row = orders.get(input.outTradeNo);
        if (!row) return undefined;
        const activated = row.status === "pending" && row.amountFen === input.amountFen;
        if (activated) { row.status = "active"; activations.push(row.outTradeNo); }
        return { ...row, activated };
      }
    },
    openids: {}, mailer: { send: async (input: Record<string, unknown>) => { mailed.push(input); } }, ...options.withCorpora === false ? {} : { corpora }
  } as unknown as ConstructorParameters<typeof HatchPay>[0]);
  const server = http.createServer((req, res) => void handleHatchPayRoute(req, res, new URL(req.url!, "http://x"), pay));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hatch-pay`;
  const post = (path: string, body: unknown, headers: Record<string, string> = MERCHANT) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const page = async (path = `/o/${NO}`, headers: Record<string, string> = {}) => { const res = await fetch(`${base}${path}`, { headers: { "user-agent": DESKTOP, ...headers } }); return { res, html: await res.text() }; };
  return { base, orders, trade, made, created, mailed, activations, clock, seed, post, page, close: () => { server.closeAllConnections(); server.close(); } };
}

/** The `D` data the page hands its script. */
export const pageData = (html: string) => JSON.parse(/const D=(\{.*?\}),PILL=/.exec(html)![1]!) as Record<string, unknown>;
