import { createHash } from "node:crypto";
import type http from "node:http";
import { BlockList, isIP } from "node:net";
import { normalizeAccountIdentity } from "./registryAuth.js";

export type AuthRoute = "signin" | "signup";

export type AuthRateLimitOptions = {
  windowMs: number;
  ipMaxAttempts: number;
  identityMaxFailures: number;
  maxEntriesPerDimension: number;
};

export type AuthAttemptDecision =
  | { allowed: true; identityLimited: false }
  | { allowed: true; identityLimited: true; retryAfterSeconds: number }
  | { allowed: false; reason: "source_ip" | "capacity"; retryAfterSeconds: number };

export type AuthFailureDecision =
  | { limited: false }
  | { limited: true; reason: "identity_failures" | "capacity"; retryAfterSeconds: number };

export type AuthSourceDecision =
  | { allowed: true }
  | { allowed: false; reason: "source_ip" | "capacity"; retryAfterSeconds: number };

export type AuthIdentityDecision =
  | { allowed: true; identityLimited: false }
  | { allowed: true; identityLimited: true; retryAfterSeconds: number };

export const DEFAULT_AUTH_RATE_LIMIT_OPTIONS: AuthRateLimitOptions = {
  windowMs: 10 * 60 * 1000,
  ipMaxAttempts: 60,
  identityMaxFailures: 10,
  maxEntriesPerDimension: 20_000
};

type FixedWindowBucket = {
  attempts: number;
  resetAt: number;
};

/**
 * A process-local limiter for the single Registry instance. Every auth request
 * consumes the hard source-IP budget. Signin and signup keep independent
 * identity failure budgets so duplicate signup traffic cannot lock signin.
 * Raw addresses and identities are never retained.
 */
export class AuthRateLimiter {
  private readonly ipBuckets = new Map<string, FixedWindowBucket>();
  private readonly signinIdentityBuckets = new Map<string, FixedWindowBucket>();
  private readonly signupIdentityBuckets = new Map<string, FixedWindowBucket>();

  constructor(
    private readonly options: AuthRateLimitOptions = DEFAULT_AUTH_RATE_LIMIT_OPTIONS,
    private readonly clock: () => number = Date.now
  ) {
    validateOptions(options);
  }

  beginAttempt(sourceIp: string, route: AuthRoute, identity: string): AuthAttemptDecision {
    const sourceDecision = this.beginSourceAttempt(sourceIp);
    if (!sourceDecision.allowed) return sourceDecision;
    return this.checkIdentity(route, identity);
  }

  /** Consume the hard source budget before the request body is buffered. */
  beginSourceAttempt(sourceIp: string): AuthSourceDecision {
    const now = this.clock();
    const ipDecision = consumeHardAttempt(
      this.ipBuckets,
      opaqueKey("ip", normalizeSourceIp(sourceIp) || "unknown"),
      this.options.ipMaxAttempts,
      this.options.windowMs,
      this.options.maxEntriesPerDimension,
      now
    );
    if (!ipDecision.allowed) return ipDecision;

    return { allowed: true };
  }

  /** Check the normalized failure lock after the body reveals an identity. */
  checkIdentity(route: AuthRoute, identity: string): AuthIdentityDecision {
    const now = this.clock();
    const identityBucket = this.identityBuckets(route);
    pruneExpiredBuckets(identityBucket, now);
    const bucket = identityBucket.get(identityKey(route, identity));
    if (!bucket || bucket.attempts < this.options.identityMaxFailures) {
      return { allowed: true, identityLimited: false };
    }
    return {
      allowed: true,
      identityLimited: true,
      retryAfterSeconds: retryAfterSeconds(bucket.resetAt, now)
    };
  }

  recordFailure(route: AuthRoute, identity: string): AuthFailureDecision {
    const now = this.clock();
    const buckets = this.identityBuckets(route);
    const key = identityKey(route, identity);
    pruneExpiredBuckets(buckets, now);
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= this.options.maxEntriesPerDimension) {
        return {
          limited: true,
          reason: "capacity",
          retryAfterSeconds: capacityRetryAfterSeconds(buckets, now)
        };
      }
      bucket = { attempts: 0, resetAt: now + this.options.windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.attempts >= this.options.identityMaxFailures) {
      return {
        limited: true,
        reason: "identity_failures",
        retryAfterSeconds: retryAfterSeconds(bucket.resetAt, now)
      };
    }
    bucket.attempts += 1;
    return { limited: false };
  }

  recordSuccess(route: AuthRoute, identity: string): void {
    this.identityBuckets(route).delete(identityKey(route, identity));
  }

  /** Exposes only counts for invariant tests and diagnostics. */
  trackedEntries(): { ip: number; signinIdentity: number; signupIdentity: number } {
    return {
      ip: this.ipBuckets.size,
      signinIdentity: this.signinIdentityBuckets.size,
      signupIdentity: this.signupIdentityBuckets.size
    };
  }

  private identityBuckets(route: AuthRoute): Map<string, FixedWindowBucket> {
    return route === "signin" ? this.signinIdentityBuckets : this.signupIdentityBuckets;
  }
}

export function authRateLimitOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): AuthRateLimitOptions {
  const identityFailureSetting = environment.HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES !== undefined
    ? "HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES"
    : environment.HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_ATTEMPTS !== undefined
      ? "HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_ATTEMPTS"
      : "HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES";
  return {
    windowMs: integerSetting(
      environment,
      "HATCH_AUTH_RATE_LIMIT_WINDOW_MS",
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.windowMs,
      1_000,
      24 * 60 * 60 * 1000
    ),
    ipMaxAttempts: integerSetting(
      environment,
      "HATCH_AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS",
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.ipMaxAttempts,
      1,
      100_000
    ),
    identityMaxFailures: integerSetting(
      environment,
      identityFailureSetting,
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.identityMaxFailures,
      1,
      10_000
    ),
    maxEntriesPerDimension: integerSetting(
      environment,
      "HATCH_AUTH_RATE_LIMIT_MAX_ENTRIES",
      DEFAULT_AUTH_RATE_LIMIT_OPTIONS.maxEntriesPerDimension,
      100,
      1_000_000
    )
  };
}

/** Explicit allow-list for the reverse proxies permitted to supply XFF. */
export class TrustedProxyPolicy {
  private readonly blockList = new BlockList();

  constructor(cidrs: string[] = []) {
    for (const cidr of cidrs) this.add(cidr);
  }

  matches(address: string): boolean {
    const normalized = normalizeSourceIp(address);
    const family = isIP(normalized);
    return family !== 0 && this.blockList.check(normalized, family === 4 ? "ipv4" : "ipv6");
  }

  private add(raw: string): void {
    const value = raw.trim();
    const parts = value.split("/");
    if (!value || parts.length > 2) throw new Error(`Invalid trusted proxy CIDR: ${raw}`);
    const address = normalizeSourceIp(parts[0] ?? "");
    const family = isIP(address);
    const maximum = family === 4 ? 32 : family === 6 ? 128 : 0;
    const prefix = parts[1] === undefined ? maximum : Number(parts[1]);
    if (!maximum || !Number.isInteger(prefix) || prefix < 0 || prefix > maximum) {
      throw new Error(`Invalid trusted proxy CIDR: ${raw}`);
    }
    this.blockList.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
}

const NO_TRUSTED_PROXIES = new TrustedProxyPolicy();

export function authTrustedProxyPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): TrustedProxyPolicy {
  const configured = environment.HATCH_AUTH_TRUSTED_PROXY_CIDRS?.trim();
  return new TrustedProxyPolicy(configured ? configured.split(",") : []);
}

/**
 * X-Forwarded-For is ignored unless the direct peer matches the explicit
 * trusted-proxy allow-list. The rightmost address is the one hop supplied by
 * the deployment proxy.
 */
export function authRequestSourceIp(
  request: http.IncomingMessage,
  trustedProxies: TrustedProxyPolicy = NO_TRUSTED_PROXIES
): string {
  const peer = normalizeSourceIp(request.socket.remoteAddress ?? "");
  if (trustedProxies.matches(peer)) {
    const rawForwarded = request.headers["x-forwarded-for"];
    const forwarded = Array.isArray(rawForwarded) ? rawForwarded.join(",") : rawForwarded;
    if (forwarded) {
      const candidates = forwarded.split(",").map((value) => normalizeSourceIp(value));
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        if (isIP(candidates[index] ?? "")) return candidates[index]!;
      }
    }
  }
  return peer || "unknown";
}

function consumeHardAttempt(
  buckets: Map<string, FixedWindowBucket>,
  key: string,
  limit: number,
  windowMs: number,
  capacity: number,
  now: number
): Extract<AuthAttemptDecision, { allowed: false }> | { allowed: true; identityLimited: false } {
  pruneExpiredBuckets(buckets, now);
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= capacity) {
      return {
        allowed: false,
        reason: "capacity",
        retryAfterSeconds: capacityRetryAfterSeconds(buckets, now)
      };
    }
    bucket = { attempts: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  if (bucket.attempts >= limit) {
    return {
      allowed: false,
      reason: "source_ip",
      retryAfterSeconds: retryAfterSeconds(bucket.resetAt, now)
    };
  }
  bucket.attempts += 1;
  return { allowed: true, identityLimited: false };
}

function pruneExpiredBuckets(buckets: Map<string, FixedWindowBucket>, now: number): void {
  // Fixed windows are inserted in reset-time order and never reordered.
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt > now) break;
    buckets.delete(key);
  }
}

function capacityRetryAfterSeconds(buckets: Map<string, FixedWindowBucket>, now: number): number {
  let earliestReset = Number.POSITIVE_INFINITY;
  for (const bucket of buckets.values()) earliestReset = Math.min(earliestReset, bucket.resetAt);
  return retryAfterSeconds(earliestReset, now);
}

function retryAfterSeconds(resetAt: number, now: number): number {
  return Number.isFinite(resetAt) ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 1;
}

function identityKey(route: AuthRoute, identity: string): string {
  return opaqueKey(route, normalizeAccountIdentity(identity));
}

function opaqueKey(dimension: string, value: string): string {
  return createHash("sha256").update(dimension).update("\0").update(value).digest("hex");
}

function normalizeSourceIp(value: string): string {
  const normalized = value.trim().replace(/^\[|\]$/g, "").split("%", 1)[0] ?? "";
  if (normalized.toLowerCase().startsWith("::ffff:")) {
    const ipv4 = normalized.slice("::ffff:".length);
    if (isIP(ipv4) === 4) return ipv4;
  }
  return normalized.toLowerCase();
}

function integerSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateOptions(options: AuthRateLimitOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Auth rate limit option ${name} must be a positive integer`);
    }
  }
}
