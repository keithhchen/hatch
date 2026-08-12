import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WebSocket } from "ws";
import type { AgentRuntime } from "./agentRuntime.js";
import { AgentCorpusResolver } from "./agentCorpus.js";
import { HttpCommerceEventSink } from "./commerceHttpSink.js";
import { DeliveryAccountingOutbox } from "./deliveryOutbox.js";
import { RegistryEntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, type RuntimeServer } from "./index.js";
import type { OutboundMessage } from "./protocol.js";
import {
  activateCurrentCorpus,
  materializeAgentCorpusRelease,
  verifyAgentCorpus
} from "./registryCorpus.js";
import { RuntimeStore } from "./store.js";

const CREATOR_ID = "creator-cross-process";
const AGENT_ID = "agent-cross-process";
const PRODUCT_ID = "product-cross-process";
const BUYER_ID = "buyer-cross-process";
const BUYER_TOKEN = "buyer-cross-process-token";
const ACCESS_SERVICE_TOKEN = "registry-access-cross-process";
const DEPLOYMENT_SERVICE_TOKEN = "registry-deployment-cross-process";
const COMMERCE_SERVICE_TOKEN = "runtime-commerce-cross-process";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(currentDirectory, "..");
const repositoryRoot = path.resolve(runtimeRoot, "..");
const dashboardEntry = path.join(repositoryRoot, "creator-dashboard", "server.mjs");

type JsonRecord = Record<string, any>;

test("real Dashboard process and Runtime HTTP client preserve delivery, recovery, revocation, and release-version invariants", {
  timeout: 60_000
}, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-runtime-commerce-cross-process-"));
  const ledgerPath = path.join(root, "commerce.jsonl");
  const portalStatePath = path.join(root, "portal-state.json");
  const telemetryPath = path.join(root, "telemetry.jsonl");
  const outboxPath = path.join(root, "delivery-outbox.json");
  const corpus = await createCorpusReleases(root);
  const registry = await startRegistryFixture(corpus);
  const dashboardPort = await availablePort();
  const dashboardProcesses: DashboardProcess[] = [];
  const runtimes: RuntimeServer[] = [];
  const sockets: WebSocket[] = [];

  context.after(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const runtime of runtimes.splice(0).reverse()) await runtime.close().catch(() => undefined);
    for (const dashboard of dashboardProcesses.splice(0).reverse()) await dashboard.stop();
    await closeServer(registry.server);
    await rm(root, { recursive: true, force: true });
  });

  let dashboard = await startDashboardProcess({
    port: dashboardPort,
    registryUrl: registry.url,
    ledgerPath,
    portalStatePath,
    telemetryPath
  });
  dashboardProcesses.push(dashboard);

  const outage = deferred<void>();
  const continueAfterOutage = deferred<void>();
  const invokedRuns = new Set<string>();
  const createScenarioRuntime = scenarioRuntimeFactory({
    invokedRuns,
    outageArtifactObserved: outage.resolve,
    continueAfterOutage: continueAfterOutage.promise
  });
  const firstRuntime = await startRuntime({
    dashboardUrl: dashboard.url,
    registryUrl: registry.url,
    corpusRoot: corpus.root,
    dataRoot: path.join(root, "runtime-first"),
    outboxPath,
    createRuntime: createScenarioRuntime,
    reconcileIntervalMs: 60_000
  });
  runtimes.push(firstRuntime.runtime);
  assert.equal((await fetch(`${firstRuntime.url}/readyz`)).status, 200, "Runtime is ready before checkout");

  // R05/R27: the already-running Runtime learns the entitlement created by a
  // later checkout. Publishing V2 changes the Registry current pointer, but a
  // pinned V1 purchase must continue resolving and delivering with V1.
  registry.setOffer({ amountMinor: 0, includedUnits: 4, versionPolicy: "pinned" });
  const freePurchase = await checkout(dashboard.url, "free-v1");
  assert.equal(freePurchase.payment.status, "not_required");
  assert.equal(freePurchase.entitlement.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(freePurchase.entitlement.remaining_units, 4);

  // R28 uses two independent tracking entitlements purchased on V1. The first
  // may advance only across V2's immutable predecessor declaration. The second
  // remains untouched until a later breaking release proves that a missing
  // lineage does not authorize an advance.
  registry.setOffer({ amountMinor: 0, includedUnits: 1, versionPolicy: "track_current_compatible" });
  const compatibleTrackPurchase = await checkout(dashboard.url, "track-compatible-v1");
  const brokenTrackPurchase = await checkout(dashboard.url, "track-breaking-v1");
  for (const purchase of [compatibleTrackPurchase, brokenTrackPurchase]) {
    assert.equal(purchase.entitlement.purchased_corpus_digest, corpus.v1Digest);
    assert.equal(purchase.entitlement.effective_corpus_digest, corpus.v1Digest);
    assert.equal(purchase.entitlement.version_policy, "track_current_compatible");
  }

  await activateCurrentCorpus(CREATOR_ID, AGENT_ID, corpus.v2Digest, corpus.root);
  registry.publishDigest(corpus.v2Digest);

  const freeSession = await connectRuntime(firstRuntime.url, freePurchase.entitlement_id);
  sockets.push(freeSession.socket);
  const ready = await freeSession.ready;
  assert.equal(ready.corpus_digest, corpus.v1Digest);
  assert.equal(ready.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(ready.effective_corpus_digest, corpus.v1Digest);
  assert.equal(ready.version_policy, "pinned");

  const compatibleTrackSession = await connectRuntime(firstRuntime.url, compatibleTrackPurchase.entitlement_id);
  sockets.push(compatibleTrackSession.socket);
  const compatibleReady = await compatibleTrackSession.ready;
  assert.equal(compatibleReady.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(compatibleReady.effective_corpus_digest, corpus.v2Digest);
  assert.equal(compatibleReady.corpus_digest, corpus.v2Digest);
  assert.equal(compatibleReady.version_policy, "track_current_compatible");
  assert.equal(compatibleReady.version_history.length, 1);
  assert.equal(compatibleReady.version_history[0].from_digest, corpus.v1Digest);
  assert.equal(compatibleReady.version_history[0].to_digest, corpus.v2Digest);
  compatibleTrackSession.send(runMessage("run-track-compatible"));
  await compatibleTrackSession.waitFor((message) => (
    message.type === "delivery.ready"
    && message.run_id === "run-track-compatible"
    && message.receipt_status === "recorded"
  ));
  await compatibleTrackSession.waitFor((message) => (
    message.type === "turn.completed" && message.run_id === "run-track-compatible"
  ));
  const compatibleEntitlement = await waitForEntitlement(
    dashboard.url,
    compatibleTrackPurchase.entitlement_id,
    (entitlement) => entitlement.remaining_units === 0 && entitlement.effective_corpus_digest === corpus.v2Digest
  );
  assert.equal(compatibleEntitlement.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(compatibleEntitlement.version_history.length, 1);

  // R06: a free delivery crosses real Runtime -> Dashboard HTTP, consumes one
  // unit, records task/artifact/delivery, and creates no revenue fact.
  freeSession.send(runMessage("run-success"));
  const successReceipt = await freeSession.waitFor((message) => (
    message.type === "delivery.ready"
    && message.run_id === "run-success"
    && message.receipt_status === "recorded"
  ));
  assert.equal(successReceipt.artifact_type, "file");
  await freeSession.waitFor((message) => message.type === "turn.completed" && message.run_id === "run-success");
  await waitForEntitlement(dashboard.url, freePurchase.entitlement_id, (entitlement) => (
    entitlement.remaining_units === 3 && entitlement.reserved_units === 0
  ));

  // R08: failure and cancellation both release their reservations. The unit
  // count remains reusable and no delivery or revenue is synthesized.
  freeSession.send(runMessage("run-failed"));
  await freeSession.waitFor((message) => message.type === "turn.failed" && message.run_id === "run-failed");
  await waitForEntitlement(dashboard.url, freePurchase.entitlement_id, (entitlement) => (
    entitlement.remaining_units === 3 && entitlement.reserved_units === 0
  ));

  freeSession.send(runMessage("run-cancelled"));
  await freeSession.waitFor((message) => (
    message.type === "assistant.delta"
    && message.run_id === "run-cancelled"
    && message.delta?.kind === "status"
  ));
  freeSession.send({ type: "turn.cancel", run_id: "run-cancelled", reason: "buyer cancelled" });
  await freeSession.waitFor((message) => message.type === "turn.failed" && message.run_id === "run-cancelled");
  await waitForEntitlement(dashboard.url, freePurchase.entitlement_id, (entitlement) => (
    entitlement.remaining_units === 3 && entitlement.reserved_units === 0
  ));

  // R07: let the Runtime observe a completed local artifact, then terminate
  // the actual Dashboard OS process before accounting begins. The Buyer-facing
  // turn still completes with a durable syncing receipt.
  freeSession.send(runMessage("run-outage"));
  await outage.promise;
  await dashboard.stop();
  dashboardProcesses.splice(dashboardProcesses.indexOf(dashboard), 1);
  continueAfterOutage.resolve();
  await freeSession.waitFor((message) => (
    message.type === "delivery.ready"
    && message.run_id === "run-outage"
    && message.receipt_status === "syncing"
  ));
  const syncingTurn = await freeSession.waitFor((message) => (
    message.type === "turn.completed"
    && message.run_id === "run-outage"
  ));
  assert.equal(syncingTurn.receipt_status, "syncing");
  const pendingOutbox = new DeliveryAccountingOutbox(outboxPath);
  await waitForAsync(async () => (await pendingOutbox.list()).length === 1 ? true : undefined);
  const serializedOutbox = await readFile(outboxPath, "utf8");
  assert.doesNotMatch(serializedOutbox, /Private Workspace|private artifact body|artifact_path|"content"/);

  freeSession.socket.close();
  sockets.splice(sockets.indexOf(freeSession.socket), 1);
  await firstRuntime.runtime.close();
  runtimes.splice(runtimes.indexOf(firstRuntime.runtime), 1);

  dashboard = await startDashboardProcess({
    port: dashboardPort,
    registryUrl: registry.url,
    ledgerPath,
    portalStatePath,
    telemetryPath
  });
  dashboardProcesses.push(dashboard);
  const restartedRuntime = await startRuntime({
    dashboardUrl: dashboard.url,
    registryUrl: registry.url,
    corpusRoot: corpus.root,
    dataRoot: path.join(root, "runtime-restarted"),
    outboxPath,
    createRuntime: createScenarioRuntime,
    reconcileIntervalMs: 20
  });
  runtimes.push(restartedRuntime.runtime);
  await waitForAsync(async () => (await new DeliveryAccountingOutbox(outboxPath).list()).length === 0 ? true : undefined, 8_000);
  const recoveredEntitlement = await waitForEntitlement(
    dashboard.url,
    freePurchase.entitlement_id,
    (entitlement) => entitlement.remaining_units === 2 && entitlement.reserved_units === 0
  );
  assert.equal(recoveredEntitlement.deliveries.length, 2);

  const durableEvents = await readLedger(ledgerPath);
  const freeEvents = durableEvents.filter((event) => event.order_id === freePurchase.order_id);
  assert.equal(freeEvents.filter((event) => event.event_type === "delivery.completed").length, 2);
  assert.equal(freeEvents.filter((event) => event.event_type === "revenue.recognized").length, 0);
  assert.deepEqual(
    freeEvents
      .filter((event) => event.event_type === "entitlement.units_released")
      .map((event) => event.reason)
      .sort(),
    ["run_cancelled", "run_failed"]
  );
  for (const delivery of freeEvents.filter((event) => event.event_type === "delivery.completed")) {
    assert.equal(delivery.corpus_digest, corpus.v1Digest);
    assert.equal(delivery.purchased_corpus_digest, corpus.v1Digest);
    assert.equal(delivery.effective_corpus_digest, corpus.v1Digest);
  }
  const compatibleEvents = durableEvents.filter((event) => event.order_id === compatibleTrackPurchase.order_id);
  const versionAdvances = compatibleEvents.filter((event) => event.event_type === "entitlement.version_advanced");
  assert.equal(versionAdvances.length, 1);
  assert.equal(versionAdvances[0].from_digest, corpus.v1Digest);
  assert.equal(versionAdvances[0].to_digest, corpus.v2Digest);
  assert.equal(versionAdvances[0].from_release_id, corpus.v1Digest);
  assert.equal(versionAdvances[0].to_release_id, corpus.v2Digest);
  assert.equal(
    versionAdvances[0].compatibility_declaration_id,
    `corpus-compatibility:${CREATOR_ID}:${AGENT_ID}:${corpus.v2Digest}`
  );
  const compatibleDelivery = compatibleEvents.find((event) => event.event_type === "delivery.completed");
  assert.ok(compatibleDelivery);
  assert.equal(compatibleDelivery.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(compatibleDelivery.effective_corpus_digest, corpus.v2Digest);

  // R22: establish a second Runtime session, refund its paid order before any
  // delivery, then prove both that already-connected session and a fresh
  // connection are denied without restarting Runtime.
  registry.setOffer({ amountMinor: 125, includedUnits: 1, versionPolicy: "pinned" });
  const paidPurchase = await checkout(dashboard.url, "paid-v2");
  assert.equal(paidPurchase.payment.status, "succeeded");
  assert.equal(paidPurchase.entitlement.purchased_corpus_digest, corpus.v2Digest);
  const paidSession = await connectRuntime(restartedRuntime.url, paidPurchase.entitlement_id);
  sockets.push(paidSession.socket);
  assert.equal((await paidSession.ready).corpus_digest, corpus.v2Digest);

  const refundResponse = await fetch(
    `${dashboard.url}/v1/user/orders/${encodeURIComponent(paidPurchase.order_id)}/refund-requests`,
    {
      method: "POST",
      headers: buyerMutationHeaders("refund-paid-v2"),
      body: JSON.stringify({ reason: "buyer_requested_before_delivery" })
    }
  );
  const refunded = await refundResponse.json() as JsonRecord;
  assert.equal(refundResponse.status, 201, JSON.stringify(refunded));
  assert.equal(refunded.order.status, "refunded");
  assert.equal(refunded.order.entitlement_status, "revoked");
  assert.equal(refunded.access_status, "revoked");

  paidSession.send(runMessage("run-after-refund"));
  const deniedRun = await paidSession.waitFor((message) => (
    message.type === "turn.failed" && message.run_id === "run-after-refund"
  ));
  assert.match(String(deniedRun.error?.message), /revoked|not active/i);
  assert.equal(invokedRuns.has("run-after-refund"), false, "revoked work is denied before model execution");

  const deniedConnection = await connectRuntimeExpectFailure(restartedRuntime.url, paidPurchase.entitlement_id);
  sockets.push(deniedConnection.socket);
  assert.equal(deniedConnection.failure.error?.code, "entitlement_not_found");

  const paidOrderResponse = await fetch(
    `${dashboard.url}/v1/user/orders/${encodeURIComponent(paidPurchase.order_id)}`,
    { headers: buyerHeaders() }
  );
  const paidOrder = (await paidOrderResponse.json() as JsonRecord).order;
  assert.equal(paidOrderResponse.status, 200);
  assert.equal(paidOrder.refund_status, "refunded");
  assert.equal(paidOrder.delivery_status, "not_started");
  assert.equal(paidOrder.access.status, "revoked");

  // A valid breaking V3 has no backward_compatible_with declaration. A fresh
  // Runtime lookup for the untouched tracking entitlement must therefore keep
  // the purchased V1 digest and must not ask Commerce to advance it.
  await activateCurrentCorpus(CREATOR_ID, AGENT_ID, corpus.v3Digest, corpus.root);
  registry.publishDigest(corpus.v3Digest);
  const brokenTrackSession = await connectRuntime(restartedRuntime.url, brokenTrackPurchase.entitlement_id);
  sockets.push(brokenTrackSession.socket);
  const brokenReady = await brokenTrackSession.ready;
  assert.equal(brokenReady.version_policy, "track_current_compatible");
  assert.equal(brokenReady.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(brokenReady.effective_corpus_digest, corpus.v1Digest);
  assert.equal(brokenReady.corpus_digest, corpus.v1Digest);
  assert.deepEqual(brokenReady.version_history, []);
  const afterBreakingPublish = await readLedger(ledgerPath);
  assert.equal(afterBreakingPublish.some((event) => (
    event.event_type === "entitlement.version_advanced"
    && event.entitlement_id === brokenTrackPurchase.entitlement_id
  )), false);

  // Registry still carries the immutable purchase identity, while Commerce is
  // authoritative for the last confirmed effective release. Reconnecting the
  // already-advanced entitlement after breaking V3 must therefore remain on
  // V2 instead of rolling back to V1 or jumping to V3.
  const advancedReconnect = await connectRuntime(restartedRuntime.url, compatibleTrackPurchase.entitlement_id);
  sockets.push(advancedReconnect.socket);
  const reconnectedReady = await advancedReconnect.ready;
  assert.equal(reconnectedReady.version_policy, "track_current_compatible");
  assert.equal(reconnectedReady.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(reconnectedReady.effective_corpus_digest, corpus.v2Digest);
  assert.equal(reconnectedReady.corpus_digest, corpus.v2Digest);
  assert.equal(reconnectedReady.version_history.length, 1);
  assert.equal(reconnectedReady.version_history[0].from_digest, corpus.v1Digest);
  assert.equal(reconnectedReady.version_history[0].to_digest, corpus.v2Digest);
  const afterAdvancedReconnect = await readLedger(ledgerPath);
  assert.equal(afterAdvancedReconnect.filter((event) => (
    event.event_type === "entitlement.version_advanced"
    && event.entitlement_id === compatibleTrackPurchase.entitlement_id
  )).length, 1);
});

type CorpusReleases = { root: string; v1Digest: string; v2Digest: string; v3Digest: string };

async function createCorpusReleases(temporaryRoot: string): Promise<CorpusReleases> {
  const corpusRoot = path.join(temporaryRoot, "corpora");
  const stagingRoot = path.join(temporaryRoot, "corpus-staging");
  const v1 = await writeCorpus(path.join(stagingRoot, "v1"), "V1 delivery method");
  await materializeAgentCorpusRelease(v1, corpusRoot);
  const v2 = await writeCorpus(
    path.join(stagingRoot, "v2"),
    "V2 newly published compatible method",
    v1.digest
  );
  await materializeAgentCorpusRelease(v2, corpusRoot);
  const v3 = await writeCorpus(path.join(stagingRoot, "v3"), "V3 breaking method without a predecessor");
  await materializeAgentCorpusRelease(v3, corpusRoot);
  await activateCurrentCorpus(CREATOR_ID, AGENT_ID, v1.digest, corpusRoot);
  return { root: corpusRoot, v1Digest: v1.digest, v2Digest: v2.digest, v3Digest: v3.digest };
}

async function writeCorpus(directory: string, systemText: string, compatibleWith?: string) {
  const synthetic = "[]\n";
  const heldOut = "[]\n";
  await Promise.all([
    mkdir(path.join(directory, "instructions"), { recursive: true }),
    mkdir(path.join(directory, "evals"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(directory, "instructions", "system.md"), systemText, "utf8"),
    writeFile(path.join(directory, "evals", "synthetic.json"), synthetic, "utf8"),
    writeFile(path.join(directory, "evals", "held-out.json"), heldOut, "utf8")
  ]);
  const asset = (id: string, assetPath: string, contents: string) => ({
    id,
    path: assetPath,
    sha256: digest(contents)
  });
  await writeFile(path.join(directory, "agent.json"), JSON.stringify({
    contract_version: "1",
    agent_id: AGENT_ID,
    creator: { id: CREATOR_ID, name: "Cross Process Creator" },
    ...(compatibleWith ? { release: { backward_compatible_with: compatibleWith } } : {}),
    product: {
      id: PRODUCT_ID,
      name: "Cross Process Product",
      description: "A product used to prove the real Runtime and Commerce boundary.",
      promise: "Create one durable local delivery.",
      boundaries: ["Does not upload private Workspace content."],
      presentation: {}
    },
    instructions: { system: asset("system", "instructions/system.md", systemText) },
    skills: [],
    knowledge: { documents: [] },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
    evaluations: {
      synthetic_qa: [asset("synthetic", "evals/synthetic.json", synthetic)],
      held_out: [asset("held-out", "evals/held-out.json", heldOut)]
    }
  }), "utf8");
  return verifyAgentCorpus(directory, CREATOR_ID, AGENT_ID);
}

type RegistryFixture = {
  server: Server;
  url: string;
  publishDigest: (digest: string) => void;
  setOffer: (input: {
    amountMinor: number;
    includedUnits: number;
    versionPolicy: "pinned" | "track_current_compatible";
  }) => void;
};

async function startRegistryFixture(corpus: CorpusReleases): Promise<RegistryFixture> {
  let currentDigest = corpus.v1Digest;
  const releases = new Map([
    [corpus.v1Digest, { corpus_digest: corpus.v1Digest }],
    [corpus.v2Digest, { corpus_digest: corpus.v2Digest, backward_compatible_with: corpus.v1Digest }],
    [corpus.v3Digest, { corpus_digest: corpus.v3Digest }]
  ]);
  let offer: {
    amountMinor: number;
    includedUnits: number;
    versionPolicy: "pinned" | "track_current_compatible";
  } = { amountMinor: 0, includedUnits: 4, versionPolicy: "pinned" };
  const access = new Map<string, JsonRecord>();
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://registry.cross-process");
      if (request.method === "GET" && ["/healthz", "/readyz"].includes(url.pathname)) {
        return json(response, 200, { status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/v1/auth/me") {
        return bearer(request.headers.authorization) === BUYER_TOKEN
          ? json(response, 200, { id: BUYER_ID, role: "user", display_name: "Cross Process Buyer" })
          : json(response, 401, { detail: "A valid account token is required." });
      }
      if (request.method === "GET" && url.pathname === "/v1/catalog/agents") {
        return json(response, 200, [{
          creator_id: CREATOR_ID,
          creator_name: "Cross Process Creator",
          creator_verified: true,
          agent_id: AGENT_ID,
          product_id: PRODUCT_ID,
          product_name: "Cross Process Product",
          product_description: "A product used to prove the real Runtime and Commerce boundary.",
          product_promise: "Create one durable local delivery.",
          product_boundaries: ["Does not upload private Workspace content."],
          corpus_digest: currentDigest,
          status: "published",
          published_at: new Date().toISOString(),
          product_offer: {
            offer_id: `offer-${currentDigest.slice(-12)}-${offer.amountMinor}-${offer.versionPolicy}`,
            revision: offer.versionPolicy === "track_current_compatible" ? 2 : offer.amountMinor === 0 ? 1 : 3,
            model: "per_delivery",
            purchase_model: "per_delivery",
            amount_minor: offer.amountMinor,
            currency: "USD",
            unit: "delivery",
            included_units: offer.includedUnits,
            refund_policy_version: "cross-process-v1",
            version_policy: offer.versionPolicy,
            status: "active"
          },
          presentation: { inputs: ["A local request"], outputs: ["A local file"] }
        }]);
      }
      const releaseAuthorityMatch = url.pathname.match(
        /^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/([^/]+)\/releases\/([^/]+)$/
      );
      if (request.method === "GET" && releaseAuthorityMatch) {
        if (bearer(request.headers.authorization) !== DEPLOYMENT_SERVICE_TOKEN) {
          return json(response, 403, { detail: "A valid deployment service token is required." });
        }
        const creatorId = decodeURIComponent(releaseAuthorityMatch[1]!);
        const agentId = decodeURIComponent(releaseAuthorityMatch[2]!);
        const digestValue = decodeURIComponent(releaseAuthorityMatch[3]!);
        const release = releases.get(digestValue);
        if (creatorId !== CREATOR_ID || agentId !== AGENT_ID || !release) {
          return json(response, 404, { detail: "The requested release is not materialized." });
        }
        return json(response, 200, {
          creator_id: CREATOR_ID,
          agent_id: AGENT_ID,
          product_id: PRODUCT_ID,
          ...release,
          status: "published"
        });
      }
      if (request.method === "GET" && url.pathname === "/v1/user/agent-access") {
        if (bearer(request.headers.authorization) !== BUYER_TOKEN) {
          return json(response, 401, { detail: "A valid account token is required." });
        }
        return json(response, 200, [...access.values()].filter((item) => item.status === "active"));
      }
      const grantMatch = url.pathname.match(/^\/v1\/user\/agents\/([^/]+)\/([^/]+)\/access$/);
      if (request.method === "POST" && grantMatch) {
        if (bearer(request.headers.authorization) !== ACCESS_SERVICE_TOKEN) {
          return json(response, 403, { detail: "A valid access service token is required." });
        }
        const body = await readJson(request);
        const entitlementId = String(body.entitlement_id ?? "");
        const existing = access.get(entitlementId);
        if (existing) return json(response, 201, existing);
        const purchasedDigest = String(body.purchased_corpus_digest ?? "");
        const record = {
          entitlement_id: entitlementId,
          order_id: String(body.order_id),
          user_id: String(body.user_id),
          creator_id: decodeURIComponent(grantMatch[1]!),
          agent_id: decodeURIComponent(grantMatch[2]!),
          product_id: PRODUCT_ID,
          purchased_corpus_digest: purchasedDigest,
          effective_corpus_digest: purchasedDigest,
          version_policy: body.version_policy === "track_current_compatible" ? "track_current_compatible" : "pinned",
          version_history: [],
          status: "active"
        };
        access.set(entitlementId, record);
        return json(response, 201, record);
      }
      const revokeMatch = url.pathname.match(/^\/v1\/user\/agent-access\/([^/]+)$/);
      if (request.method === "DELETE" && revokeMatch) {
        if (bearer(request.headers.authorization) !== ACCESS_SERVICE_TOKEN) {
          return json(response, 403, { detail: "A valid access service token is required." });
        }
        const body = await readJson(request);
        const entitlementId = decodeURIComponent(revokeMatch[1]!);
        const existing = access.get(entitlementId);
        if (!existing || existing.user_id !== body.user_id) {
          return json(response, 404, { detail: "Entitlement not found." });
        }
        const revoked = { ...existing, status: "revoked" };
        access.set(entitlementId, revoked);
        return json(response, 200, revoked);
      }
      return json(response, 404, { detail: `Unhandled Registry fixture route: ${request.method} ${url.pathname}` });
    } catch (error) {
      return json(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    }
  });
  await listen(server);
  return {
    server,
    url: serverUrl(server),
    publishDigest: (digestValue) => { currentDigest = digestValue; },
    setOffer: (input) => { offer = input; }
  };
}

type DashboardProcess = {
  child: ChildProcessWithoutNullStreams;
  url: string;
  stop: () => Promise<void>;
};

async function startDashboardProcess(input: {
  port: number;
  registryUrl: string;
  ledgerPath: string;
  portalStatePath: string;
  telemetryPath: string;
}): Promise<DashboardProcess> {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "HATCH_COMMERCE_DATABASE_URL",
    "DATABASE_URL",
    "HATCH_PAYMENT_PROVIDER_BASE_URL",
    "HATCH_PAYMENT_PROVIDER_API_TOKEN"
  ]) delete environment[key];
  Object.assign(environment, {
    NODE_ENV: "test",
    HATCH_CREATOR_DASHBOARD_API_HOST: "127.0.0.1",
    HATCH_CREATOR_DASHBOARD_API_PORT: String(input.port),
    HATCH_PUBLIC_ORIGIN: `http://127.0.0.1:${input.port}`,
    HATCH_REGISTRY_URL: input.registryUrl,
    HATCH_COMMERCE_LEDGER_PATH: input.ledgerPath,
    HATCH_PORTAL_STATE_PATH: input.portalStatePath,
    HATCH_PORTAL_TELEMETRY_PATH: input.telemetryPath,
    HATCH_REGISTRY_ACCESS_SERVICE_TOKEN: ACCESS_SERVICE_TOKEN,
    HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN: DEPLOYMENT_SERVICE_TOKEN,
    HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN: COMMERCE_SERVICE_TOKEN,
    HATCH_COMMERCE_PAYMENT_MODE: "sandbox"
  });
  const child = spawn(process.execPath, [dashboardEntry], {
    cwd: path.dirname(dashboardEntry),
    env: environment,
    stdio: "pipe"
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += String(chunk); });
  child.stderr.on("data", (chunk) => { logs += String(chunk); });
  const url = `http://127.0.0.1:${input.port}`;
  try {
    await waitForAsync(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Dashboard process exited during startup:\n${logs}`);
      }
      try {
        const response = await fetch(`${url}/readyz`);
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    }, 8_000);
  } catch (error) {
    await terminate(child);
    throw error;
  }
  return { child, url, stop: () => terminate(child) };
}

async function startRuntime(input: {
  dashboardUrl: string;
  registryUrl: string;
  corpusRoot: string;
  dataRoot: string;
  outboxPath: string;
  createRuntime: () => AgentRuntime;
  reconcileIntervalMs: number;
}): Promise<{ runtime: RuntimeServer; url: string }> {
  const runtime = createRuntimeServer({
    createRuntime: input.createRuntime,
    conversationStore: new RuntimeStore(input.dataRoot),
    entitlementResolver: new RegistryEntitlementResolver(input.registryUrl),
    agentCorpusResolver: new AgentCorpusResolver(input.corpusRoot),
    commerceEventSink: new HttpCommerceEventSink(input.dashboardUrl, COMMERCE_SERVICE_TOKEN),
    deliveryAccountingOutbox: new DeliveryAccountingOutbox(input.outboxPath),
    deliveryReconcileIntervalMs: input.reconcileIntervalMs
  });
  await listen(runtime.server);
  const url = serverUrl(runtime.server);
  await waitForAsync(async () => {
    const response = await fetch(`${url}/readyz`);
    return response.ok ? true : undefined;
  }, 8_000);
  return { runtime, url };
}

function scenarioRuntimeFactory(input: {
  invokedRuns: Set<string>;
  outageArtifactObserved: () => void;
  continueAfterOutage: Promise<void>;
}): () => AgentRuntime {
  return () => ({
    async *run(run, context): AsyncIterable<OutboundMessage> {
      input.invokedRuns.add(run.run_id);
      if (run.run_id === "run-failed") throw new Error("model failed before delivery");
      if (run.run_id === "run-cancelled") {
        while (context.state.status !== "cancelled") {
          yield {
            type: "assistant.delta",
            run_id: run.run_id,
            delta: { kind: "status", content: "working until buyer cancellation" }
          };
          await delay(5);
        }
        return;
      }
      yield {
        type: "tool_call.delta",
        run_id: run.run_id,
        tool_call_id: `write-${run.run_id}`,
        name: "fs.write",
        locality: "client",
        approval: "ask",
        status: "completed",
        arguments: {
          path: "/Users/buyer/Private Workspace/result.md",
          content: "private artifact body"
        }
      };
      if (run.run_id === "run-outage") {
        input.outageArtifactObserved();
        await input.continueAfterOutage;
      }
      yield { type: "turn.completed", run_id: run.run_id, finish_reason: "stop" };
    }
  });
}

async function checkout(dashboardUrl: string, key: string): Promise<JsonRecord> {
  const detailResponse = await fetch(`${dashboardUrl}/v1/catalog/agents/${CREATOR_ID}/${PRODUCT_ID}`);
  const detail = await detailResponse.json() as JsonRecord;
  assert.equal(detailResponse.status, 200, JSON.stringify(detail));
  const sessionResponse = await fetch(`${dashboardUrl}/v1/checkout-sessions`, {
    method: "POST",
    headers: buyerMutationHeaders(`${key}:session`),
    body: JSON.stringify({
      creator_id: CREATOR_ID,
      product_id: PRODUCT_ID,
      offer_id: detail.agent.offer.offer_id
    })
  });
  const sessionBody = await sessionResponse.json() as JsonRecord;
  assert.equal(sessionResponse.status, 201, JSON.stringify(sessionBody));
  const confirmResponse = await fetch(
    `${dashboardUrl}/v1/checkout-sessions/${encodeURIComponent(sessionBody.checkout_session.checkout_session_id)}/confirm`,
    {
      method: "POST",
      headers: buyerMutationHeaders(`${key}:confirm`),
      body: "{}"
    }
  );
  const purchase = await confirmResponse.json() as JsonRecord;
  assert.equal(confirmResponse.status, 201, JSON.stringify(purchase));
  assert.ok(purchase.order_id);
  assert.ok(purchase.entitlement_id);
  return purchase;
}

type RuntimeConnection = {
  socket: WebSocket;
  messages: JsonRecord[];
  ready: Promise<JsonRecord>;
  send: (message: JsonRecord) => void;
  waitFor: (predicate: (message: JsonRecord) => boolean, timeoutMs?: number) => Promise<JsonRecord>;
};

async function connectRuntime(runtimeUrl: string, entitlementId: string): Promise<RuntimeConnection> {
  const connection = await openRuntimeSocket(runtimeUrl);
  connection.send(hello(entitlementId));
  const ready = connection.waitFor((message) => message.type === "session.ready");
  return { ...connection, ready };
}

async function connectRuntimeExpectFailure(runtimeUrl: string, entitlementId: string) {
  const connection = await openRuntimeSocket(runtimeUrl);
  connection.send(hello(entitlementId));
  const failure = await connection.waitFor((message) => message.type === "turn.failed" && !message.run_id);
  return { ...connection, failure };
}

async function openRuntimeSocket(runtimeUrl: string): Promise<Omit<RuntimeConnection, "ready">> {
  const socket = new WebSocket(runtimeUrl.replace(/^http/, "ws") + "/runtime");
  const messages: JsonRecord[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return {
    socket,
    messages,
    send: (message) => socket.send(JSON.stringify(message)),
    waitFor: (predicate, timeoutMs) => waitFor(() => messages.find(predicate), timeoutMs)
  };
}

function hello(entitlementId: string): JsonRecord {
  return {
    type: "client.hello",
    protocol_version: "0.4",
    installation_id: "desktop-cross-process",
    auth_token: BUYER_TOKEN,
    entitlement_id: entitlementId,
    creator_id: CREATOR_ID,
    agent_id: AGENT_ID,
    product_id: PRODUCT_ID,
    local_tools: []
  };
}

function runMessage(runId: string): JsonRecord {
  return {
    type: "client.message",
    run_id: runId,
    conversation_id: `conversation-${runId}`,
    message: { role: "user", content: "Create the purchased delivery." }
  };
}

async function waitForEntitlement(
  dashboardUrl: string,
  entitlementId: string,
  predicate: (entitlement: JsonRecord) => boolean
): Promise<JsonRecord> {
  return waitForAsync(async () => {
    const response = await fetch(
      `${dashboardUrl}/v1/user/entitlements/${encodeURIComponent(entitlementId)}`,
      { headers: buyerHeaders() }
    );
    if (!response.ok) return undefined;
    const entitlement = (await response.json() as JsonRecord).entitlement;
    return predicate(entitlement) ? entitlement : undefined;
  }, 8_000);
}

async function readLedger(filePath: string): Promise<JsonRecord[]> {
  const contents = await readFile(filePath, "utf8");
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function buyerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${BUYER_TOKEN}`, accept: "application/json" };
}

function buyerMutationHeaders(idempotencyKey: string): Record<string, string> {
  return {
    ...buyerHeaders(),
    "content-type": "application/json",
    "idempotency-key": idempotencyKey
  };
}

function bearer(value: string | string[] | undefined): string {
  const authorization = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
}

async function readJson(request: import("node:http").IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await closeServer(server);
  return port;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = once(child, "exit").then(() => true);
  if (!await Promise.race([exited, delay(3_000).then(() => false)])) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 8_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = read();
    if (result !== undefined) return result;
    await delay(5);
  }
  throw new Error("Timed out waiting for cross-process Runtime state");
}

async function waitForAsync<T>(read: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(10);
  }
  throw new Error("Timed out waiting for asynchronous cross-process state");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
