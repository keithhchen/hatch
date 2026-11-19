import type http from "node:http";
import { isIP } from "node:net";
import type { AccessCodes } from "./accessCodes.js";

/** The caller's address: X-Real-IP (set by the merchant's proxy, passed through unchanged), else the first X-Forwarded-For hop. */
export function clientIp(headers: http.IncomingHttpHeaders): string | undefined {
  return [headers["x-real-ip"], String(headers["x-forwarded-for"] ?? "").split(",")[0]].map(v => String(v ?? "").trim()).find(v => isIP(v));
}

/** Counts failures per key; a key at its limit is blocked until old failures age out. */
export interface AttemptLimiter {
  blocked(key: string): boolean;
  fail(key: string): void;
}

export class TooManyAttempts extends Error {
  readonly status = 429;
  constructor() { super("尝试次数过多，请稍后再试"); }
}

/** In memory, for one Runtime instance: at most `limit` failures per `windowMs`. */
export class MemoryAttemptLimiter implements AttemptLimiter {
  private readonly failures = new Map<string, number[]>();
  constructor(private readonly limit = 10, private readonly windowMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter(at => at > cutoff);
    if (recent.length) this.failures.set(key, recent); else this.failures.delete(key);
    return recent;
  }
  blocked(key: string) { return this.recent(key).length >= this.limit; }
  fail(key: string) {
    if (this.failures.size > 10_000) for (const k of [...this.failures.keys()]) this.recent(k);
    this.failures.set(key, [...this.recent(key), this.now()]);
  }
}

/**
 * The port as one client sees it: a client at its limit gets TooManyAttempts (status 429) before any code is looked at; a redeem that
 * fails or a lookup that finds nothing counts against it; a success does not. Without a known address nothing is let through.
 */
export function rateLimitedAccessCodes(inner: AccessCodes, limiter: AttemptLimiter, ip: string | undefined): AccessCodes {
  const guarded = async <T>(attempt: () => Promise<T>, failed: (result: T) => boolean): Promise<T> => {
    if (!ip) throw new TooManyAttempts();
    if (limiter.blocked(ip)) throw new TooManyAttempts();
    const result = await attempt();
    if (failed(result)) limiter.fail(ip);
    return result;
  };
  return {
    createPending: input => inner.createPending(input),
    activatePaid: input => inner.activatePaid(input),
    order: outTradeNo => inner.order(outTradeNo),
    peek: code => inner.peek(code),
    redeem: input => guarded(() => inner.redeem(input), result => !result.ok),
    lookup: code => guarded(() => inner.lookup(code), result => result === null)
  };
}
