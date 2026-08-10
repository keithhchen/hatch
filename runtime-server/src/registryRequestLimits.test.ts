import assert from "node:assert/strict";
import test from "node:test";
import {
  HttpRequestGate,
  PublishWorkGate,
  SessionQueryGate,
  publishWorkLimitOptionsFromEnvironment,
  httpRequestLimitOptionsFromEnvironment,
  sessionQueryLimitOptionsFromEnvironment,
} from "./registryRequestLimits.js";

test("HTTP request gate bounds global and per-source body work", () => {
  const gate = new HttpRequestGate({ maxConcurrent: 2, maxConcurrentPerSource: 1 });
  const first = gate.begin("203.0.113.1");
  assert.equal(first.allowed, true);
  assert.equal(gate.begin("203.0.113.1").allowed, false);
  const second = gate.begin("203.0.113.2");
  assert.equal(second.allowed, true);
  const global = gate.begin("203.0.113.3");
  assert.deepEqual(global, { allowed: false, reason: "global_capacity", retryAfterSeconds: 1 });
  if (first.allowed) first.release();
  if (second.allowed) second.release();
  assert.equal(gate.activeCount(), 0);

  const internal: Array<ReturnType<HttpRequestGate["begin"]>> = [];
  for (let index = 0; index < 2; index += 1) internal.push(gate.begin("shared-runtime", false));
  assert.ok(internal.every((decision) => decision.allowed));
  for (const decision of internal) if (decision.allowed) decision.release();
});

test("session query gate bounds source rate, tracked sources, and concurrent database work", () => {
  let now = 1_000;
  const gate = new SessionQueryGate({
    windowMs: 10_000,
    maxAttemptsPerSource: 2,
    maxTrackedSources: 2,
    maxConcurrent: 1,
  }, () => now);

  const first = gate.begin("203.0.113.1");
  assert.equal(first.allowed, true);
  assert.equal(gate.activeCount(), 1);
  assert.deepEqual(gate.begin("203.0.113.1"), {
    allowed: false,
    reason: "global_capacity",
    retryAfterSeconds: 1,
  });
  if (first.allowed) {
    first.release();
    first.release();
  }
  assert.equal(gate.activeCount(), 0);
  assert.deepEqual(gate.begin("203.0.113.1"), {
    allowed: false,
    reason: "source_rate",
    retryAfterSeconds: 10,
  });

  const secondSource = gate.begin("203.0.113.2");
  assert.equal(secondSource.allowed, true);
  if (secondSource.allowed) secondSource.release();
  assert.deepEqual(gate.begin("203.0.113.3"), {
    allowed: false,
    reason: "source_capacity",
    retryAfterSeconds: 10,
  });

  now += 10_001;
  const afterExpiry = gate.begin("203.0.113.3");
  assert.equal(afterExpiry.allowed, true);
  if (afterExpiry.allowed) afterExpiry.release();
  assert.equal(gate.trackedSourceCount(), 1);

  const internal = gate.begin("shared-runtime-source", false);
  assert.equal(internal.allowed, true);
  if (internal.allowed) internal.release();
});

test("publish gate rejects a second body from one publisher and bounds global work", () => {
  const gate = new PublishWorkGate({
    maxConcurrent: 2,
    maxConcurrentPerPublisher: 1,
    rateWindowMs: 60_000,
    maxAttemptsPerPublisher: 10,
    maxAttemptsGlobal: 10,
    maxTrackedPublishers: 100,
  });
  const first = gate.begin("creator-a");
  assert.equal(first.allowed, true);
  assert.deepEqual(gate.begin("creator-a"), {
    allowed: false,
    reason: "publisher_capacity",
    retryAfterSeconds: 1,
  });
  assert.deepEqual(gate.begin("creator-b"), {
    allowed: false,
    reason: "global_capacity",
    retryAfterSeconds: 1,
  });
  const trusted = gate.begin("registry-publish-service", false);
  assert.equal(trusted.allowed, true);
  if (first.allowed) first.release();
  if (trusted.allowed) trusted.release();
  assert.equal(gate.activeCount(), 0);
});

test("capacity rejections do not poison the shared publish rate budget", () => {
  const gate = new PublishWorkGate({
    maxConcurrent: 1,
    maxConcurrentPerPublisher: 1,
    rateWindowMs: 60_000,
    maxAttemptsPerPublisher: 2,
    maxAttemptsGlobal: 2,
    maxTrackedPublishers: 100,
  });
  const active = gate.begin("creator-a");
  assert.equal(active.allowed, true);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(gate.begin(`rejected-${index}`).allowed, false);
  }
  if (active.allowed) active.release();
  const legitimate = gate.begin("creator-b");
  assert.equal(legitimate.allowed, true);
  if (legitimate.allowed) legitimate.release();
});

test("publish gate rate-limits persistent submissions before body work", () => {
  const gate = new PublishWorkGate({
    maxConcurrent: 2,
    maxConcurrentPerPublisher: 1,
    rateWindowMs: 60_000,
    maxAttemptsPerPublisher: 1,
    maxAttemptsGlobal: 2,
    maxTrackedPublishers: 100,
  });
  const first = gate.begin("creator-a");
  assert.equal(first.allowed, true);
  if (first.allowed) first.release();
  const limited = gate.begin("creator-a");
  assert.equal(limited.allowed, false);
  if (!limited.allowed) assert.equal(limited.reason, "publisher_rate");
  const service = gate.begin("registry-publish-service", false);
  assert.equal(service.allowed, true);
  if (service.allowed) service.release();
});

test("public uploads cannot consume the trusted publish-service reserve", () => {
  const gate = new PublishWorkGate({
    maxConcurrent: 2,
    maxConcurrentPerPublisher: 1,
    rateWindowMs: 60_000,
    maxAttemptsPerPublisher: 10,
    maxAttemptsGlobal: 10,
    maxTrackedPublishers: 100,
  });
  const publicUpload = gate.begin("creator-a");
  assert.equal(publicUpload.allowed, true);
  assert.deepEqual(gate.begin("creator-b"), {
    allowed: false,
    reason: "global_capacity",
    retryAfterSeconds: 1,
  });
  const trustedUpload = gate.begin("registry-publish-service", false);
  assert.equal(trustedUpload.allowed, true);
  if (publicUpload.allowed) publicUpload.release();
  if (trustedUpload.allowed) trustedUpload.release();
  assert.equal(gate.activeCount(), 0);
});

test("Registry request limit environment settings are bounded", () => {
  assert.equal(httpRequestLimitOptionsFromEnvironment({}).requestTimeoutMs, 30_000);
  assert.equal(publishWorkLimitOptionsFromEnvironment({}).maxAttemptsGlobal, 20);
  assert.deepEqual(httpRequestLimitOptionsFromEnvironment({
    HATCH_REGISTRY_HTTP_MAX_CONCURRENT: "8",
    HATCH_REGISTRY_HTTP_MAX_CONCURRENT_PER_SOURCE: "2",
    HATCH_REGISTRY_HTTP_MAX_CONNECTIONS: "16",
    HATCH_REGISTRY_HTTP_HEADERS_TIMEOUT_MS: "3000",
    HATCH_REGISTRY_HTTP_REQUEST_TIMEOUT_MS: "5000",
  }), {
    maxConcurrent: 8,
    maxConcurrentPerSource: 2,
    maxConnections: 16,
    headersTimeoutMs: 3_000,
    requestTimeoutMs: 5_000,
  });
  assert.deepEqual(sessionQueryLimitOptionsFromEnvironment({
    HATCH_AUTH_SESSION_RATE_LIMIT_WINDOW_MS: "5000",
    HATCH_AUTH_SESSION_RATE_LIMIT_MAX_ATTEMPTS: "25",
    HATCH_AUTH_SESSION_RATE_LIMIT_MAX_SOURCES: "100",
    HATCH_AUTH_SESSION_MAX_CONCURRENT: "3",
  }), {
    windowMs: 5_000,
    maxAttemptsPerSource: 25,
    maxTrackedSources: 100,
    maxConcurrent: 3,
  });
  assert.deepEqual(publishWorkLimitOptionsFromEnvironment({
    HATCH_REGISTRY_PUBLISH_MAX_CONCURRENT: "8",
    HATCH_REGISTRY_PUBLISH_MAX_CONCURRENT_PER_PUBLISHER: "2",
    HATCH_REGISTRY_PUBLISH_RATE_WINDOW_MS: "5000",
    HATCH_REGISTRY_PUBLISH_RATE_MAX_PER_PUBLISHER: "12",
    HATCH_REGISTRY_PUBLISH_RATE_MAX_GLOBAL: "50",
    HATCH_REGISTRY_PUBLISH_RATE_MAX_PUBLISHERS: "100",
  }), {
    maxConcurrent: 8,
    maxConcurrentPerPublisher: 2,
    rateWindowMs: 5_000,
    maxAttemptsPerPublisher: 12,
    maxAttemptsGlobal: 50,
    maxTrackedPublishers: 100,
  });
  assert.throws(
    () => sessionQueryLimitOptionsFromEnvironment({ HATCH_AUTH_SESSION_MAX_CONCURRENT: "0" }),
    /HATCH_AUTH_SESSION_MAX_CONCURRENT/,
  );
});
