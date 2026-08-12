import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";
import { PortalTelemetryStore } from "../telemetry.mjs";

test("portal telemetry is allowlisted, privacy-safe, and durably idempotent", async () => {
  const store = await PortalTelemetryStore.open();
  const first = await store.record("product_viewed", {
    product_id: "product-safe",
    creator_id: "creator-safe",
    request_id: "request-safe"
  }, { idempotencyKey: "view-safe", now: "2026-08-12T00:00:00.000Z" });
  const replay = await store.record("product_viewed", {
    product_id: "product-safe",
    creator_id: "creator-safe",
    request_id: "request-safe"
  }, { idempotencyKey: "view-safe", now: "2026-08-12T00:01:00.000Z" });
  assert.equal(replay.event_id, first.event_id);
  assert.deepEqual(await store.summary(), { product_viewed: 1 });

  await assert.rejects(
    store.record("product_viewed", { product_id: "changed" }, { idempotencyKey: "view-safe" }),
    (error) => error.code === "idempotency_conflict" && error.status === 409
  );
  for (const [field, value] of [["prompt", "private"], ["workspace_path", "/private"], ["token", "secret"], ["email", "buyer@example.test"]]) {
    await assert.rejects(
      store.record("checkout_started", { [field]: value }, { idempotencyKey: `private-${field}` }),
      (error) => error.code === "private_telemetry_field"
    );
  }
  await assert.rejects(
    store.record("unknown_event", {}, { idempotencyKey: "unknown" }),
    (error) => error.code === "unsupported_telemetry_event"
  );
});

test("analytics HTTP ingestion is same-origin, retry-safe, private-field safe, and rate limited", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-telemetry-http-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal.json"),
    telemetryPath: path.join(directory, "telemetry.jsonl"),
    registryUrl: "http://127.0.0.1:1",
    analyticsRateLimit: 4
  });
  const api = createServer(dashboard.handler);
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => api.close(resolve));
    await dashboard.ledger.close?.();
    await dashboard.portalState.close?.();
    await dashboard.telemetry.close?.();
  });
  const address = api.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/analytics/events`;
  const ingest = (key, eventName, attributes, headers = {}) => fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key, ...headers },
    body: JSON.stringify({ event_name: eventName, attributes })
  });

  const crossSite = await ingest("cross-site", "product_viewed", {}, {
    origin: "https://attacker.example",
    "sec-fetch-site": "cross-site"
  });
  assert.equal(crossSite.status, 403);

  const privateField = await ingest("private", "checkout_started", { prompt: "private buyer text" });
  assert.equal(privateField.status, 422);
  assert.equal((await privateField.json()).error.code, "private_telemetry_field");

  const first = await ingest("view-retry", "product_viewed", { product_id: "product-http" });
  const firstBody = await first.json();
  assert.equal(first.status, 202);
  const replay = await ingest("view-retry", "product_viewed", { product_id: "product-http" });
  const replayBody = await replay.json();
  assert.equal(replay.status, 202);
  assert.equal(replayBody.event_id, firstBody.event_id);

  const conflict = await ingest("view-retry", "product_viewed", { product_id: "changed-product" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");

  const limited = await ingest("rate-limited", "catalog_viewed", {});
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "60");
  assert.deepEqual(await dashboard.telemetry.summary(), { product_viewed: 1 });
});
