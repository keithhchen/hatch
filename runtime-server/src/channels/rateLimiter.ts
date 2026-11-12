export type Rate = { capacity: number; perSecond: number };

/** Port: a token bucket every process shares. */
export interface RateLimiter {
  /** Takes one token. Zero means go ahead; otherwise the milliseconds until one is free. */
  take(key: string, rate: Rate, now?: Date): Promise<number>;
}
