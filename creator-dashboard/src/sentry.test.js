import assert from "node:assert/strict";
import test from "node:test";

globalThis.location = { origin: "https://hatch.example" };
const { initSentry } = await import("./sentry.js");
const { dashboardRequest, SERVICE_UNAVAILABLE_MESSAGE } = await import("./data.js");

function fakeSentry() {
  const calls = { init: [], breadcrumbs: [], tags: {}, captured: [] };
  return {
    calls,
    init: (options) => calls.init.push(options),
    browserTracingIntegration: () => "tracing",
    addBreadcrumb: (crumb) => calls.breadcrumbs.push(crumb),
    withScope: (fn) => fn({ setTag: (k, v) => { calls.tags[k] = v; }, setContext() {} }),
    captureException: (error) => calls.captured.push(error)
  };
}

test("Sentry is not initialized without a DSN", () => {
  const sentry = fakeSentry();
  assert.equal(initSentry({ PROD: true }, sentry), false);
  assert.equal(sentry.calls.init.length, 0);
});

test("Sentry is configured from the DSN, release and build mode", () => {
  const sentry = fakeSentry();
  assert.equal(initSentry({ VITE_SENTRY_DSN: "https://k@o.ingest.sentry.io/1", VITE_RELEASE: "abc123", PROD: true }, sentry), true);
  assert.deepEqual(sentry.calls.init[0], {
    dsn: "https://k@o.ingest.sentry.io/1",
    environment: "production",
    release: "abc123",
    integrations: ["tracing"],
    tracesSampleRate: 0.2,
    tracePropagationTargets: ["https://hatch.example"],
    sendDefaultPii: false
  });
  const local = fakeSentry();
  initSentry({ VITE_SENTRY_DSN: "https://k@o.ingest.sentry.io/1" }, local);
  assert.equal(local.calls.init[0].environment, "development");
  assert.equal(local.calls.init[0].tracesSampleRate, 1.0);
});

test("request helper maps an HTML 5xx to the friendly error and tags request_id", async () => {
  const sentry = fakeSentry();
  initSentry({ VITE_SENTRY_DSN: "https://k@o.ingest.sentry.io/1" }, sentry);
  globalThis.fetch = async () => new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "x-request-id": "req_1", "content-type": "text/html" } });
  await assert.rejects(dashboardRequest("/v1/products?x=1"), (error) => {
    assert.equal(error.message, SERVICE_UNAVAILABLE_MESSAGE);
    assert.equal(error.status, 502);
    assert.equal(error.request_id, "req_1");
    return true;
  });
  assert.equal(sentry.calls.tags.request_id, "req_1");
  assert.equal(sentry.calls.captured.length, 1);
  assert.equal(sentry.calls.breadcrumbs[0].data.path, "/v1/products");
});

test("a JSON 4xx is breadcrumbed but not captured", async () => {
  const sentry = fakeSentry();
  initSentry({ VITE_SENTRY_DSN: "https://k@o.ingest.sentry.io/1" }, sentry);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "No" } }), { status: 401, headers: { "x-request-id": "req_2" } });
  await assert.rejects(dashboardRequest("/v1/auth/me"), { status: 401, request_id: "req_2" });
  assert.equal(sentry.calls.breadcrumbs.length, 1);
  assert.equal(sentry.calls.captured.length, 0);
});
