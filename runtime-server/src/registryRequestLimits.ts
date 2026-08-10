import { createHash } from "node:crypto";

type FixedWindowBucket = { attempts: number; resetAt: number };

export type SessionQueryLimitOptions = {
  windowMs: number;
  maxAttemptsPerSource: number;
  maxTrackedSources: number;
  maxConcurrent: number;
};

export type PublishWorkLimitOptions = {
  maxConcurrent: number;
  maxConcurrentPerPublisher: number;
  rateWindowMs: number;
  maxAttemptsPerPublisher: number;
  maxAttemptsGlobal: number;
  maxTrackedPublishers: number;
};

export type HttpRequestLimitOptions = {
  maxConcurrent: number;
  maxConcurrentPerSource: number;
  maxConnections: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
};

export const DEFAULT_SESSION_QUERY_LIMIT_OPTIONS: SessionQueryLimitOptions = {
  windowMs: 60_000,
  maxAttemptsPerSource: 600,
  maxTrackedSources: 20_000,
  maxConcurrent: 32,
};

export const DEFAULT_PUBLISH_WORK_LIMIT_OPTIONS: PublishWorkLimitOptions = {
  // One public Creator slot plus one slot reserved for the authenticated
  // Registry publish service used by deploy/factory seeding.
  maxConcurrent: 2,
  maxConcurrentPerPublisher: 1,
  rateWindowMs: 60 * 60 * 1000,
  maxAttemptsPerPublisher: 10,
  maxAttemptsGlobal: 20,
  maxTrackedPublishers: 20_000,
};

export const DEFAULT_HTTP_REQUEST_LIMIT_OPTIONS: HttpRequestLimitOptions = {
  maxConcurrent: 128,
  maxConcurrentPerSource: 16,
  maxConnections: 512,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
};

export type GateLease = { release: () => void };
export type GateDecision =
  | ({ allowed: true } & GateLease)
  | { allowed: false; reason: "source_rate" | "source_capacity" | "global_capacity"; retryAfterSeconds: number };

/**
 * Bounds opaque-session database work before a random bearer can reach
 * Postgres. Source identifiers are hashed and expired buckets are pruned, so
 * the limiter cannot become an unbounded store of client addresses.
 */
export class SessionQueryGate {
  private readonly buckets = new Map<string, FixedWindowBucket>();
  private active = 0;

  constructor(
    private readonly options: SessionQueryLimitOptions = DEFAULT_SESSION_QUERY_LIMIT_OPTIONS,
    private readonly clock: () => number = Date.now,
  ) {
    positiveInteger(options.windowMs, "session query windowMs");
    positiveInteger(options.maxAttemptsPerSource, "session query maxAttemptsPerSource");
    positiveInteger(options.maxTrackedSources, "session query maxTrackedSources");
    positiveInteger(options.maxConcurrent, "session query maxConcurrent");
  }

  begin(source: string, enforceSourceRate = true): GateDecision {
    const now = this.clock();
    if (enforceSourceRate) {
      pruneExpired(this.buckets, now);
      const key = opaqueKey("session-query", source || "unknown");
      let bucket = this.buckets.get(key);
      if (!bucket) {
        if (this.buckets.size >= this.options.maxTrackedSources) {
          return {
            allowed: false,
            reason: "source_capacity",
            retryAfterSeconds: earliestRetryAfter(this.buckets, now),
          };
        }
        bucket = { attempts: 0, resetAt: now + this.options.windowMs };
        this.buckets.set(key, bucket);
      }
      if (bucket.attempts >= this.options.maxAttemptsPerSource) {
        return {
          allowed: false,
          reason: "source_rate",
          retryAfterSeconds: retryAfter(bucket.resetAt, now),
        };
      }
      bucket.attempts += 1;
    }
    if (this.active >= this.options.maxConcurrent) {
      return { allowed: false, reason: "global_capacity", retryAfterSeconds: 1 };
    }
    this.active += 1;
    return idempotentLease(() => { this.active -= 1; });
  }

  activeCount(): number { return this.active; }
  trackedSourceCount(): number { return this.buckets.size; }
}

export type HttpRequestGateDecision =
  | ({ allowed: true } & GateLease)
  | { allowed: false; reason: "source_capacity" | "global_capacity"; retryAfterSeconds: number };

/** Bounds all requests after headers and before any route buffers a body. */
export class HttpRequestGate {
  private active = 0;
  private readonly activeBySource = new Map<string, number>();

  constructor(private readonly options: Pick<HttpRequestLimitOptions, "maxConcurrent" | "maxConcurrentPerSource">) {
    positiveInteger(options.maxConcurrent, "HTTP maxConcurrent");
    positiveInteger(options.maxConcurrentPerSource, "HTTP maxConcurrentPerSource");
    if (options.maxConcurrentPerSource > options.maxConcurrent) {
      throw new Error("HTTP per-source concurrency cannot exceed global concurrency");
    }
  }

  begin(source: string, enforceSourceCapacity = true): HttpRequestGateDecision {
    const key = opaqueKey("http-source", source || "unknown");
    if (enforceSourceCapacity && (this.activeBySource.get(key) ?? 0) >= this.options.maxConcurrentPerSource) {
      return { allowed: false, reason: "source_capacity", retryAfterSeconds: 1 };
    }
    if (this.active >= this.options.maxConcurrent) {
      return { allowed: false, reason: "global_capacity", retryAfterSeconds: 1 };
    }
    this.active += 1;
    this.activeBySource.set(key, (this.activeBySource.get(key) ?? 0) + 1);
    return idempotentLease(() => {
      this.active -= 1;
      const remaining = (this.activeBySource.get(key) ?? 1) - 1;
      if (remaining === 0) this.activeBySource.delete(key);
      else this.activeBySource.set(key, remaining);
    });
  }

  activeCount(): number { return this.active; }
}

export type PublishGateDecision =
  | ({ allowed: true } & GateLease)
  | { allowed: false; reason: "publisher_rate" | "publisher_tracking_capacity" | "publisher_capacity" | "global_rate" | "global_capacity"; retryAfterSeconds: number };

/** A non-queuing gate acquired before Registry reads or inflates a bundle. */
export class PublishWorkGate {
  private active = 0;
  private activeRateLimited = 0;
  private readonly activeByPublisher = new Map<string, number>();
  private readonly attemptsByPublisher = new Map<string, FixedWindowBucket>();
  private globalAttempts: FixedWindowBucket | undefined;

  constructor(private readonly options: PublishWorkLimitOptions = DEFAULT_PUBLISH_WORK_LIMIT_OPTIONS) {
    positiveInteger(options.maxConcurrent, "publish maxConcurrent");
    positiveInteger(options.maxConcurrentPerPublisher, "publish maxConcurrentPerPublisher");
    positiveInteger(options.rateWindowMs, "publish rateWindowMs");
    positiveInteger(options.maxAttemptsPerPublisher, "publish maxAttemptsPerPublisher");
    positiveInteger(options.maxAttemptsGlobal, "publish maxAttemptsGlobal");
    positiveInteger(options.maxTrackedPublishers, "publish maxTrackedPublishers");
    if (options.maxConcurrentPerPublisher > options.maxConcurrent) {
      throw new Error("publish per-publisher concurrency cannot exceed global concurrency");
    }
  }

  begin(publisher: string, enforceRate = true): PublishGateDecision {
    const now = Date.now();
    const key = opaqueKey("publisher", publisher || "unknown");
    // A request that never acquires work capacity must not consume the shared
    // hourly budget. Otherwise a burst of already-rejected uploads could lock
    // every legitimate Creator out for the full window.
    if ((this.activeByPublisher.get(key) ?? 0) >= this.options.maxConcurrentPerPublisher) {
      return { allowed: false, reason: "publisher_capacity", retryAfterSeconds: 1 };
    }
    const publicCapacity = Math.max(1, this.options.maxConcurrent - 1);
    if (enforceRate && this.activeRateLimited >= publicCapacity) {
      return { allowed: false, reason: "global_capacity", retryAfterSeconds: 1 };
    }
    if (this.active >= this.options.maxConcurrent) {
      return { allowed: false, reason: "global_capacity", retryAfterSeconds: 1 };
    }
    if (enforceRate) {
      pruneExpired(this.attemptsByPublisher, now);
      let publisherAttempts = this.attemptsByPublisher.get(key);
      if (!publisherAttempts) {
        if (this.attemptsByPublisher.size >= this.options.maxTrackedPublishers) {
          return {
            allowed: false,
            reason: "publisher_tracking_capacity",
            retryAfterSeconds: earliestRetryAfter(this.attemptsByPublisher, now),
          };
        }
        publisherAttempts = { attempts: 0, resetAt: now + this.options.rateWindowMs };
        this.attemptsByPublisher.set(key, publisherAttempts);
      }
      if (!this.globalAttempts || this.globalAttempts.resetAt <= now) {
        this.globalAttempts = { attempts: 0, resetAt: now + this.options.rateWindowMs };
      }
      if (publisherAttempts.attempts >= this.options.maxAttemptsPerPublisher) {
        return {
          allowed: false,
          reason: "publisher_rate",
          retryAfterSeconds: retryAfter(publisherAttempts.resetAt, now),
        };
      }
      if (this.globalAttempts.attempts >= this.options.maxAttemptsGlobal) {
        return {
          allowed: false,
          reason: "global_rate",
          retryAfterSeconds: retryAfter(this.globalAttempts.resetAt, now),
        };
      }
      publisherAttempts.attempts += 1;
      this.globalAttempts.attempts += 1;
    }
    this.active += 1;
    if (enforceRate) this.activeRateLimited += 1;
    this.activeByPublisher.set(key, (this.activeByPublisher.get(key) ?? 0) + 1);
    return idempotentLease(() => {
      this.active -= 1;
      if (enforceRate) this.activeRateLimited -= 1;
      const remaining = (this.activeByPublisher.get(key) ?? 1) - 1;
      if (remaining === 0) this.activeByPublisher.delete(key);
      else this.activeByPublisher.set(key, remaining);
    });
  }

  activeCount(): number { return this.active; }
}

export function sessionQueryLimitOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SessionQueryLimitOptions {
  return {
    windowMs: integerSetting(environment, "HATCH_AUTH_SESSION_RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 24 * 60 * 60 * 1000),
    maxAttemptsPerSource: integerSetting(environment, "HATCH_AUTH_SESSION_RATE_LIMIT_MAX_ATTEMPTS", 600, 1, 1_000_000),
    maxTrackedSources: integerSetting(environment, "HATCH_AUTH_SESSION_RATE_LIMIT_MAX_SOURCES", 20_000, 100, 1_000_000),
    maxConcurrent: integerSetting(environment, "HATCH_AUTH_SESSION_MAX_CONCURRENT", 32, 1, 10_000),
  };
}

export function publishWorkLimitOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PublishWorkLimitOptions {
  return {
    maxConcurrent: integerSetting(environment, "HATCH_REGISTRY_PUBLISH_MAX_CONCURRENT", 2, 1, 128),
    maxConcurrentPerPublisher: integerSetting(environment, "HATCH_REGISTRY_PUBLISH_MAX_CONCURRENT_PER_PUBLISHER", 1, 1, 128),
    rateWindowMs: integerSetting(environment, "HATCH_REGISTRY_PUBLISH_RATE_WINDOW_MS", 60 * 60 * 1000, 1_000, 24 * 60 * 60 * 1000),
    maxAttemptsPerPublisher: integerSetting(environment, "HATCH_REGISTRY_PUBLISH_RATE_MAX_PER_PUBLISHER", 10, 1, 100_000),
    maxAttemptsGlobal: integerSetting(environment, "HATCH_REGISTRY_PUBLISH_RATE_MAX_GLOBAL", 20, 1, 1_000_000),
    maxTrackedPublishers: integerSetting(environment, "HATCH_REGISTRY_PUBLISH_RATE_MAX_PUBLISHERS", 20_000, 100, 1_000_000),
  };
}

export function httpRequestLimitOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): HttpRequestLimitOptions {
  const options = {
    maxConcurrent: integerSetting(environment, "HATCH_REGISTRY_HTTP_MAX_CONCURRENT", 128, 1, 100_000),
    maxConcurrentPerSource: integerSetting(environment, "HATCH_REGISTRY_HTTP_MAX_CONCURRENT_PER_SOURCE", 16, 1, 10_000),
    maxConnections: integerSetting(environment, "HATCH_REGISTRY_HTTP_MAX_CONNECTIONS", 512, 1, 100_000),
    headersTimeoutMs: integerSetting(environment, "HATCH_REGISTRY_HTTP_HEADERS_TIMEOUT_MS", 10_000, 1_000, 120_000),
    requestTimeoutMs: integerSetting(environment, "HATCH_REGISTRY_HTTP_REQUEST_TIMEOUT_MS", 30_000, 1_000, 10 * 60 * 1000),
  };
  if (options.headersTimeoutMs > options.requestTimeoutMs) {
    throw new Error("HATCH_REGISTRY_HTTP_HEADERS_TIMEOUT_MS must not exceed HATCH_REGISTRY_HTTP_REQUEST_TIMEOUT_MS");
  }
  if (options.maxConcurrentPerSource > options.maxConcurrent) {
    throw new Error("HATCH_REGISTRY_HTTP_MAX_CONCURRENT_PER_SOURCE must not exceed HATCH_REGISTRY_HTTP_MAX_CONCURRENT");
  }
  return options;
}

function idempotentLease(releaseOnce: () => void): { allowed: true; release: () => void } {
  let released = false;
  return {
    allowed: true,
    release() {
      if (released) return;
      released = true;
      releaseOnce();
    },
  };
}

function pruneExpired(buckets: Map<string, FixedWindowBucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

function earliestRetryAfter(buckets: Map<string, FixedWindowBucket>, now: number): number {
  let earliest = Number.POSITIVE_INFINITY;
  for (const bucket of buckets.values()) earliest = Math.min(earliest, bucket.resetAt);
  return retryAfter(earliest, now);
}

function retryAfter(resetAt: number, now: number): number {
  return Number.isFinite(resetAt) ? Math.max(1, Math.ceil((resetAt - now) / 1000)) : 1;
}

function opaqueKey(dimension: string, value: string): string {
  return createHash("sha256").update(`${dimension}\0${value}`, "utf8").digest("hex");
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function integerSetting(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
