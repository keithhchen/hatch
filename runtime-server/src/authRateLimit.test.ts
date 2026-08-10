import assert from "node:assert/strict";
import type http from "node:http";
import test from "node:test";
import {
  AuthRateLimiter,
  TrustedProxyPolicy,
  authRateLimitOptionsFromEnvironment,
  authRequestSourceIp,
  authTrustedProxyPolicyFromEnvironment
} from "./authRateLimit.js";

test("identity budgets count only normalized failures and a success clears the lock", () => {
  let now = 1_000;
  const limiter = new AuthRateLimiter({
    windowMs: 10_000,
    ipMaxAttempts: 100,
    identityMaxFailures: 2,
    maxEntriesPerDimension: 100
  }, () => now);

  assert.deepEqual(limiter.beginAttempt("203.0.113.8", "signin", " User@Example.COM "), {
    allowed: true,
    identityLimited: false
  });
  assert.deepEqual(limiter.recordFailure("signin", "user@example.com"), { limited: false });
  limiter.beginAttempt("203.0.113.8", "signin", "USER@example.com");
  assert.deepEqual(limiter.recordFailure("signin", "USER@example.com"), { limited: false });
  assert.deepEqual(limiter.beginAttempt("203.0.113.8", "signin", "user@example.com"), {
    allowed: true,
    identityLimited: true,
    retryAfterSeconds: 10
  });

  limiter.recordSuccess("signin", " user@example.com ");
  assert.deepEqual(limiter.beginAttempt("203.0.113.8", "signin", "USER@example.com"), {
    allowed: true,
    identityLimited: false
  });

  limiter.recordFailure("signin", "other@example.com");
  now = 11_000;
  limiter.beginAttempt("203.0.113.8", "signin", "fresh@example.com");
  assert.deepEqual(limiter.trackedEntries(), { ip: 1, signinIdentity: 0, signupIdentity: 0 });
});

test("signin and signup identity failure buckets are independent", () => {
  const limiter = new AuthRateLimiter({
    windowMs: 30_000,
    ipMaxAttempts: 100,
    identityMaxFailures: 1,
    maxEntriesPerDimension: 100
  }, () => 5_000);

  limiter.beginAttempt("198.51.100.8", "signup", "target@example.com");
  limiter.recordFailure("signup", "target@example.com");
  assert.deepEqual(limiter.beginAttempt("198.51.100.8", "signup", "target@example.com"), {
    allowed: true,
    identityLimited: true,
    retryAfterSeconds: 30
  });
  assert.deepEqual(limiter.beginAttempt("198.51.100.8", "signin", "target@example.com"), {
    allowed: true,
    identityLimited: false
  });
  assert.deepEqual(limiter.trackedEntries(), { ip: 1, signinIdentity: 0, signupIdentity: 1 });
});

test("capacity exhaustion preserves every live bucket and expired buckets free capacity", () => {
  let now = 0;
  const limiter = new AuthRateLimiter({
    windowMs: 1_000,
    ipMaxAttempts: 100,
    identityMaxFailures: 100,
    maxEntriesPerDimension: 2
  }, () => now);

  limiter.beginAttempt("203.0.113.1", "signin", "one@example.com");
  limiter.beginAttempt("203.0.113.2", "signin", "two@example.com");
  assert.deepEqual(limiter.beginAttempt("203.0.113.3", "signin", "three@example.com"), {
    allowed: false,
    reason: "capacity",
    retryAfterSeconds: 1
  });
  // The first live bucket was not evicted to make room for the third.
  assert.equal(limiter.beginAttempt("203.0.113.1", "signin", "one@example.com").allowed, true);

  limiter.recordFailure("signin", "one@example.com");
  limiter.recordFailure("signin", "two@example.com");
  assert.deepEqual(limiter.recordFailure("signin", "three@example.com"), {
    limited: true,
    reason: "capacity",
    retryAfterSeconds: 1
  });
  assert.deepEqual(limiter.trackedEntries(), { ip: 2, signinIdentity: 2, signupIdentity: 0 });

  now = 1_000;
  assert.equal(limiter.beginAttempt("203.0.113.3", "signin", "three@example.com").allowed, true);
  limiter.recordFailure("signin", "three@example.com");
  assert.deepEqual(limiter.trackedEntries(), { ip: 1, signinIdentity: 1, signupIdentity: 0 });
});

test("source-IP budget remains a hard limit across identities and outcomes", () => {
  const limiter = new AuthRateLimiter({
    windowMs: 30_000,
    ipMaxAttempts: 2,
    identityMaxFailures: 100,
    maxEntriesPerDimension: 100
  }, () => 5_000);

  assert.equal(limiter.beginAttempt("198.51.100.8", "signin", "one@example.com").allowed, true);
  limiter.recordSuccess("signin", "one@example.com");
  assert.equal(limiter.beginAttempt("198.51.100.8", "signup", "two@example.com").allowed, true);
  assert.deepEqual(limiter.beginAttempt("198.51.100.8", "signin", "three@example.com"), {
    allowed: false,
    reason: "source_ip",
    retryAfterSeconds: 30
  });
});

test("auth rate limit environment settings are configurable and fail closed on invalid values", () => {
  assert.deepEqual(authRateLimitOptionsFromEnvironment({
    HATCH_AUTH_RATE_LIMIT_WINDOW_MS: "30000",
    HATCH_AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS: "20",
    HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES: "5",
    HATCH_AUTH_RATE_LIMIT_MAX_ENTRIES: "500"
  }), {
    windowMs: 30_000,
    ipMaxAttempts: 20,
    identityMaxFailures: 5,
    maxEntriesPerDimension: 500
  });
  assert.throws(
    () => authRateLimitOptionsFromEnvironment({ HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES: "0" }),
    /HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES/
  );
  assert.equal(authRateLimitOptionsFromEnvironment({
    HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_ATTEMPTS: "7"
  }).identityMaxFailures, 7);
});

test("authRequestSourceIp accepts XFF only from an explicitly configured trusted proxy", () => {
  const fromCaddy = {
    socket: { remoteAddress: "::ffff:172.18.0.4" },
    headers: { "x-forwarded-for": "198.51.100.3, 203.0.113.9" }
  } as unknown as http.IncomingMessage;
  assert.equal(authRequestSourceIp(fromCaddy), "172.18.0.4");
  assert.equal(
    authRequestSourceIp(fromCaddy, new TrustedProxyPolicy(["172.16.0.0/12"])),
    "203.0.113.9"
  );
  assert.equal(
    authRequestSourceIp(fromCaddy, authTrustedProxyPolicyFromEnvironment({
      HATCH_AUTH_TRUSTED_PROXY_CIDRS: "172.18.0.4/32"
    })),
    "203.0.113.9"
  );
  assert.throws(
    () => authTrustedProxyPolicyFromEnvironment({ HATCH_AUTH_TRUSTED_PROXY_CIDRS: "not-a-cidr" }),
    /Invalid trusted proxy CIDR/
  );

  const directPublic = {
    socket: { remoteAddress: "198.51.100.7" },
    headers: { "x-forwarded-for": "203.0.113.99" }
  } as unknown as http.IncomingMessage;
  assert.equal(
    authRequestSourceIp(directPublic, new TrustedProxyPolicy(["172.16.0.0/12"])),
    "198.51.100.7"
  );
});
