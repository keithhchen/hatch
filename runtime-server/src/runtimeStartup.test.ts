import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { InMemoryConversationRepository } from "./conversationRepository.js";
import type { CommerceEventSink } from "./delivery.js";
import { DeliveryAccountingOutbox } from "./deliveryOutbox.js";
import { commerceEventSinkFromEnvironment, createConversationStore, createRuntimeServer } from "./index.js";
import { PostgresStore } from "./postgresStore.js";
import { RuntimeStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("Runtime prefers the authenticated internal Commerce HTTP API", async () => {
  const requests: Array<{ path: string; authorization?: string; idempotencyKey?: string; body: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      ...(typeof request.headers.authorization === "string" ? { authorization: request.headers.authorization } : {}),
      ...(typeof request.headers["idempotency-key"] === "string" ? { idempotencyKey: request.headers["idempotency-key"] } : {}),
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET" ? { event: { event_id: "event_demo" } } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const sink = await commerceEventSinkFromEnvironment({
      HATCH_COMMERCE_URL: `http://127.0.0.1:${address.port}`,
      HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN: "runtime-commerce-secret",
      HATCH_COMMERCE_LEDGER_FILE: "/must/not/be/opened.jsonl"
    });
    assert.ok(sink);
    await sink.findByIdempotencyKey?.("delivery:key/with slash");
    await sink.append("task.started", { task_id: "task_demo" }, { idempotencyKey: "task:demo" });
    await sink.advanceEntitlementVersion?.({
      entitlement_id: "ent_demo",
      from_digest: `sha256:${"a".repeat(64)}`,
      to_digest: `sha256:${"b".repeat(64)}`,
      compatibility_declaration_id: "compatibility-demo",
      reason: "compatible_release_published"
    }, { idempotencyKey: "version:demo" });
    await sink.authorizeAndReserve?.({
      entitlement_id: "ent_demo",
      reservation_id: "reservation_demo",
      run_id: "run_demo",
      task_id: "task_demo",
      units: 1
    }, { idempotencyKey: "reserve:demo" });
    await sink.releaseReservation?.({ reservation_id: "reservation_demo", reason: "run_failed" }, { idempotencyKey: "release:demo" });
    await sink.completeDelivery?.({
      reservation_id: "reservation_demo",
      task_id: "task_demo",
      artifact_id: "artifact_demo",
      delivery_id: "delivery_demo",
      artifact_type: "message",
      effective_corpus_digest: `sha256:${"a".repeat(64)}`
    }, { idempotencyKey: "delivery:demo" });
    await sink.checkReady?.();
    assert.deepEqual(requests.map((request) => request.path), [
      "/v1/internal/commerce/idempotency/delivery%3Akey%2Fwith%20slash",
      "/v1/internal/commerce/events",
      "/v1/internal/commerce/entitlements/ent_demo/advance-version",
      "/v1/internal/commerce/reservations",
      "/v1/internal/commerce/reservations/reservation_demo/release",
      "/v1/internal/commerce/deliveries",
      "/readyz",
      "/v1/internal/commerce/idempotency/runtime%3Areadiness"
    ]);
    assert.ok(requests.every((request) => request.authorization === "Bearer runtime-commerce-secret"));
    const reservationRequest = requests.find((request) => request.path === "/v1/internal/commerce/reservations");
    assert.ok(reservationRequest?.body && typeof reservationRequest.body === "object");
    assert.equal(Object.hasOwn(reservationRequest.body as object, "conversation_id"), false);
    assert.deepEqual(requests.flatMap((request) => request.idempotencyKey ? [request.idempotencyKey] : []), [
      "task:demo", "version:demo", "reserve:demo", "release:demo", "delivery:demo"
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("production Runtime never falls back to the Registry database credential", async () => {
  assert.throws(
    () => createConversationStore({
      NODE_ENV: "production",
      HATCH_REGISTRY_DATABASE_URL: "postgresql://registry-role:secret@127.0.0.1:5432/hatch"
    }),
    /requires HATCH_RUNTIME_DATABASE_URL/
  );
  const explicit = createConversationStore({
    NODE_ENV: "production",
    HATCH_RUNTIME_DATABASE_URL: "postgresql://runtime-role:secret@127.0.0.1:5432/hatch",
    HATCH_REGISTRY_DATABASE_URL: "postgresql://registry-role:secret@127.0.0.1:5432/hatch"
  });
  assert.ok(explicit instanceof PostgresStore);
  await explicit.close();
  const developmentFallback = createConversationStore({
    HATCH_REGISTRY_DATABASE_URL: "postgresql://registry-role:secret@127.0.0.1:5432/hatch"
  });
  assert.ok(developmentFallback instanceof PostgresStore);
  await developmentFallback.close();
});

test("Runtime health waits for repository, durable outbox, and authenticated Commerce readiness", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-readiness-"));
  temporaryDirectories.push(directory);
  let commerceReady = false;
  const readinessProbes: string[] = [];
  const commerce = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer readiness-secret");
    readinessProbes.push(request.url ?? "");
    if (request.url === "/readyz") {
      response.writeHead(commerceReady ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(commerceReady ? { status: "ready" } : { detail: "Commerce database is starting" }));
      return;
    }
    if (request.url === "/v1/internal/commerce/idempotency/runtime%3Areadiness") {
      response.writeHead(commerceReady ? 404 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify(commerceReady ? {} : { detail: "Commerce is starting" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => commerce.listen(0, "127.0.0.1", resolve));
  const commerceAddress = commerce.address();
  assert.ok(commerceAddress && typeof commerceAddress !== "string");
  const sink = await commerceEventSinkFromEnvironment({
    HATCH_COMMERCE_URL: `http://127.0.0.1:${commerceAddress.port}`,
    HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN: "readiness-secret"
  });
  assert.ok(sink);
  const repository = new DeferredConversationRepository();
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(path.join(directory, "runtime")),
    conversationRepository: repository,
    commerceEventSink: sink,
    deliveryAccountingOutbox: new DeliveryAccountingOutbox(path.join(directory, "outbox.json")),
    deliveryReconcileIntervalMs: 20
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const runtimeAddress = runtime.server.address();
  assert.ok(runtimeAddress && typeof runtimeAddress !== "string");
  const livenessUrl = `http://127.0.0.1:${runtimeAddress.port}/healthz`;
  const readinessUrl = `http://127.0.0.1:${runtimeAddress.port}/readyz`;
  try {
    const live = await fetch(livenessUrl);
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true });
    const starting = await fetch(readinessUrl);
    assert.equal(starting.status, 503);
    assert.deepEqual(await starting.json(), {
      ok: false,
      checks: { conversation_repository: "starting", delivery_accounting: "starting" }
    });

    repository.finishInitialization();
    await waitForHealth(readinessUrl, 503, {
      conversation_repository: "ready",
      delivery_accounting: "failed"
    });

    commerceReady = true;
    await waitForHealth(readinessUrl, 200, {
      conversation_repository: "ready",
      delivery_accounting: "ready"
    });
    const internalProbeIndex = readinessProbes.lastIndexOf("/v1/internal/commerce/idempotency/runtime%3Areadiness");
    assert.ok(internalProbeIndex > 0);
    assert.equal(readinessProbes[internalProbeIndex - 1], "/readyz");
  } finally {
    await runtime.close();
    await new Promise<void>((resolve, reject) => commerce.close((error) => error ? reject(error) : resolve()));
  }
});

test("Runtime health reports failed repository initialization", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-readiness-failed-"));
  temporaryDirectories.push(directory);
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(path.join(directory, "runtime")),
    conversationRepository: new FailingConversationRepository()
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/healthz`)).status, 200);
    await waitForHealth(`http://127.0.0.1:${address.port}/readyz`, 503, {
      conversation_repository: "failed",
      delivery_accounting: "disabled"
    });
  } finally {
    await runtime.close();
  }
});

test("Runtime readiness fails closed for a corrupt delivery outbox", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-readiness-outbox-"));
  temporaryDirectories.push(directory);
  const outboxFile = path.join(directory, "outbox.json");
  await writeFile(outboxFile, "{not-json", "utf8");
  const sink: CommerceEventSink = {
    async append(): Promise<unknown> { return {}; }
  };
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(path.join(directory, "runtime")),
    commerceEventSink: sink,
    deliveryAccountingOutbox: new DeliveryAccountingOutbox(outboxFile),
    deliveryReconcileIntervalMs: 20
  });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await waitForHealth(`http://127.0.0.1:${address.port}/readyz`, 503, {
      conversation_repository: "ready",
      delivery_accounting: "failed"
    });
  } finally {
    await runtime.close();
  }
});

test("normal Runtime startup attaches a durable commerce ledger when configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-commerce-"));
  temporaryDirectories.push(directory);
  const ledgerFile = path.join(directory, "commerce.jsonl");
  const commerce = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href);
  const ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  const common = {
    order_id: "order_desktop_jordan",
    buyer_id: "buyer_jordan_lee",
    creator_id: "creator_maya_chen",
    agent_id: "signal-resume-review",
    product_id: "signal-resume-review",
    corpus_digest: `sha256:${"1".repeat(64)}`
  };
  await ledger.append("order.placed", {
    ...common,
    gross_minor: 0,
    currency: "USD",
    included_units: 2
  }, {
    idempotencyKey: "order:order_desktop_jordan"
  });
  await ledger.append("entitlement.granted", {
    ...common,
    entitlement_id: "entitlement_desktop_jordan",
    granted_units: 2
  }, { idempotencyKey: "entitlement:entitlement_desktop_jordan" });

  const sink = await commerceEventSinkFromEnvironment({ HATCH_COMMERCE_LEDGER_FILE: ledgerFile });
  assert.ok(sink);
  assert.equal(typeof sink.authorizeAndReserve, "function");
  assert.equal(typeof sink.completeDelivery, "function");
  assert.equal(typeof sink.releaseReservation, "function");
  await sink.append("task.started", {
    ...common,
    entitlement_id: "entitlement_desktop_jordan",
    task_id: "task_desktop_jordan"
  }, { idempotencyKey: "task:task_desktop_jordan:started" });

  await sink.authorizeAndReserve!({
    entitlement_id: "entitlement_desktop_jordan",
    reservation_id: "reservation_desktop_jordan",
    run_id: "run_desktop_jordan",
    task_id: "task_delivery_desktop_jordan",
    units: 1
  }, { idempotencyKey: "runtime:reserve:desktop-jordan" });
  await sink.append("task.started", {
    ...common,
    entitlement_id: "entitlement_desktop_jordan",
    task_id: "task_delivery_desktop_jordan"
  }, { idempotencyKey: "task:task_delivery_desktop_jordan:started" });
  await sink.append("artifact.created", {
    ...common,
    artifact_id: "artifact_desktop_jordan",
    task_id: "task_delivery_desktop_jordan",
    artifact_digest: `sha256:${"2".repeat(64)}`,
    artifact_type: "message"
  }, { idempotencyKey: "artifact:artifact_desktop_jordan:created" });
  await sink.completeDelivery!({
    reservation_id: "reservation_desktop_jordan",
    task_id: "task_delivery_desktop_jordan",
    artifact_id: "artifact_desktop_jordan",
    delivery_id: "delivery_desktop_jordan",
    artifact_type: "message",
    effective_corpus_digest: common.corpus_digest
  }, { idempotencyKey: "runtime:complete:desktop-jordan" });

  await sink.authorizeAndReserve!({
    entitlement_id: "entitlement_desktop_jordan",
    reservation_id: "reservation_desktop_release",
    run_id: "run_desktop_release",
    task_id: "task_desktop_release",
    units: 1
  }, { idempotencyKey: "runtime:reserve:desktop-release" });
  await sink.releaseReservation!({
    reservation_id: "reservation_desktop_release",
    reason: "run_cancelled"
  }, { idempotencyKey: "runtime:release:desktop-release" });

  const reopened = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  assert.deepEqual(reopened.listEvents().map((event: Record<string, unknown>) => event.event_type), [
    "order.placed",
    "entitlement.granted",
    "task.started",
    "entitlement.units_reserved",
    "task.started",
    "artifact.created",
    "delivery.completed",
    "entitlement.units_consumed",
    "entitlement.units_reserved",
    "entitlement.units_released"
  ]);
  assert.ok(!reopened.listEvents().some((event: Record<string, unknown>) => event.event_type === "revenue.recognized"));
});

test("normal Runtime startup leaves local development ledger-free when no ledger is configured", async () => {
  assert.equal(await commerceEventSinkFromEnvironment({}), undefined);
});

class DeferredConversationRepository extends InMemoryConversationRepository {
  private finish!: () => void;
  private readonly initialization = new Promise<void>((resolve) => { this.finish = resolve; });

  override async initialize(): Promise<void> {
    await this.initialization;
    await super.initialize();
  }

  finishInitialization(): void {
    this.finish();
  }
}

class FailingConversationRepository extends InMemoryConversationRepository {
  override async initialize(): Promise<void> {
    throw new Error("repository unavailable");
  }
}

async function waitForHealth(
  url: string,
  status: number,
  checks: { conversation_repository: string; delivery_accounting: string }
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    const body = await response.json() as { checks?: Record<string, string> };
    if (response.status === status
      && body.checks?.conversation_repository === checks.conversation_repository
      && body.checks?.delivery_accounting === checks.delivery_accounting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Runtime health did not become ${status} with ${JSON.stringify(checks)}`);
}
