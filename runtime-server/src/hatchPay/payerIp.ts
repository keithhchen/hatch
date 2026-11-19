import type http from "node:http";
import { isIP } from "node:net";

const firstValidIp = (...values: unknown[]) => values.map(v => String(v ?? "").trim()).find(v => isIP(v));
const firstHop = (headers: http.IncomingHttpHeaders) => String(headers["x-forwarded-for"] ?? "").split(",")[0];

/** The payer behind a request that came through the merchant's proxy (anyteach.cn), which sets X-Real-IP: that, else the first X-Forwarded-For hop. */
export function payerIp(headers: http.IncomingHttpHeaders): string | undefined {
  return firstValidIp(headers["x-real-ip"], firstHop(headers));
}
