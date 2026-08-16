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
import { InMemoryConversationRepository } from "./conversationRepository.js";
import { AgentCorpusResolver } from "./agentCorpus.js";
import { HttpCommerceEventSink } from "./commerceHttpSink.js";
import { DeliveryAccountingOutbox } from "./deliveryOutbox.js";
import { RegistryEntitlementResolver } from "./entitlements.js";
import { createRuntimeServer, durableConversationId, type RuntimeServer } from "./index.js";
import { PROTOCOL_VERSION, type OutboundMessage } from "./protocol.js";
import {
  activateCurrentCorpus,
  materializeAgentCorpusRelease,
  verifyAgentCorpus
} from "./registryCorpus.js";
import { RuntimeStore } from "./store.js";

const CREATOR_ID = "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21";
const PRODUCT_ID = "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42";
const AGENT_ID = PRODUCT_ID;
const BUYER_ID = "8e2b6f7a-3d6c-4f1b-9a2e-5c7d8f901234";
const BUYER_TOKEN = "buyer-cross-process-token";
const DEPLOYMENT_SERVICE_TOKEN = "registry-deployment-cross-process";
const COMMERCE_SERVICE_TOKEN = "runtime-commerce-cross-process";
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(currentDirectory, "..");
const repositoryRoot = path.resolve(runtimeRoot, "..");
const dashboardEntry = path.join(repositoryRoot, "creator-dashboard", "server.mjs");

type JsonRecord = Record<string, any>;

test("real Dashboard process and Runtime HTTP client preserve permanent access, buyer non-reversal, and release-version invariants", {
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

  const invokedRuns = new Set<string>();
  const createScenarioRuntime = scenarioRuntimeFactory({ invokedRuns });
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
  // pinned V1 purchase must continue resolving with V1.
  const freePurchase = await checkout(dashboard.url, "free-v1");
  assert.equal(freePurchase.payment.status, "not_required");
  assert.equal(freePurchase.entitlement.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(freePurchase.entitlement.access_mode, "unmetered");
  assert.equal("remaining_units" in freePurchase.entitlement, false);

  await activateCurrentCorpus(CREATOR_ID, AGENT_ID, corpus.v2Digest, corpus.root);
  registry.publishDigest(corpus.v2Digest);

  const freeSession = await connectRuntime(firstRuntime.url, freePurchase.entitlement_id);
  sockets.push(freeSession.socket);
  const ready = await freeSession.ready;
  assert.equal(ready.corpus_digest, corpus.v1Digest);
  assert.equal(ready.purchased_corpus_digest, corpus.v1Digest);
  assert.equal(ready.effective_corpus_digest, corpus.v1Digest);
  assert.equal(ready.version_policy, "pinned");

  // A zero-price purchase is still a real purchase, but it has permanent
  // access. Repeated turns do not reserve, consume, or create delivery facts.
  freeSession.send(runMessage("run-success"));
  await freeSession.waitFor((message) => message.type === "turn.completed" && message.run_id === "run-success");
  await freeSession.waitFor((message) => (
    message.type === "turn.state" && message.run_id === "run-success" && message.status === "completed"
  ));
  freeSession.send(runMessage("run-repeat"));
  await freeSession.waitFor((message) => message.type === "turn.completed" && message.run_id === "run-repeat");
  await waitForEntitlement(dashboard.url, freePurchase.entitlement_id, (entitlement) => (
    entitlement.access_mode === "unmetered"
    && !Object.hasOwn(entitlement, "remaining_units")
    && !Object.hasOwn(entitlement, "reserved_units")
    && !Object.hasOwn(entitlement, "deliveries")
  ));

  const resiliencePurchase = await checkout(dashboard.url, "resilience-v2");
  assert.equal(resiliencePurchase.entitlement.access_mode, "unmetered");
  const resilienceSession = await connectRuntime(firstRuntime.url, resiliencePurchase.entitlement_id);
  sockets.push(resilienceSession.socket);
  assert.equal((await resilienceSession.ready).corpus_digest, corpus.v2Digest);

  // A model failure or cancellation also leaves permanent access unchanged.
  resilienceSession.send(runMessage("run-failed"));
  await resilienceSession.waitFor((message) => message.type === "turn.failed" && message.run_id === "run-failed");
  await resilienceSession.waitFor((message) => (
    message.type === "turn.state" && message.run_id === "run-failed" && message.status === "failed"
  ));
  await waitForEntitlement(dashboard.url, resiliencePurchase.entitlement_id, (entitlement) => (
    entitlement.access_mode === "unmetered"
    && !Object.hasOwn(entitlement, "remaining_units")
    && !Object.hasOwn(entitlement, "reserved_units")
  ));

  resilienceSession.send(runMessage("run-cancelled"));
  await resilienceSession.waitFor((message) => (
    message.type === "assistant.delta"
    && message.run_id === "run-cancelled"
    && message.delta?.kind === "status"
  ));
  resilienceSession.send({ type: "turn.cancel", run_id: "run-cancelled", reason: "buyer cancelled" });
  await resilienceSession.waitFor((message) => message.type === "turn.failed" && message.run_id === "run-cancelled");
  await resilienceSession.waitFor((message) => (
    message.type === "turn.state" && message.run_id === "run-cancelled" && message.status === "cancelled"
  ));
  await waitForEntitlement(dashboard.url, resiliencePurchase.entitlement_id, (entitlement) => (
    entitlement.access_mode === "unmetered"
    && !Object.hasOwn(entitlement, "remaining_units")
    && !Object.hasOwn(entitlement, "reserved_units")
  ));

  freeSession.socket.close();
  sockets.splice(sockets.indexOf(freeSession.socket), 1);
  resilienceSession.socket.close();
  sockets.splice(sockets.indexOf(resilienceSession.socket), 1);
  await firstRuntime.runtime.close();
  runtimes.splice(runtimes.indexOf(firstRuntime.runtime), 1);

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
  const restartedFreeSession = await connectRuntime(restartedRuntime.url, freePurchase.entitlement_id);
  sockets.push(restartedFreeSession.socket);
  assert.equal((await restartedFreeSession.ready).corpus_digest, corpus.v1Digest);
  restartedFreeSession.send(runMessage("run-after-restart"));
  await restartedFreeSession.waitFor((message) => message.type === "turn.completed" && message.run_id === "run-after-restart");
  const recoveredEntitlement = await waitForEntitlement(
    dashboard.url,
    resiliencePurchase.entitlement_id,
    (entitlement) => entitlement.access_mode === "unmetered" && !Object.hasOwn(entitlement, "remaining_units")
  );
  assert.equal(recoveredEntitlement.access_mode, "unmetered");

  const durableEvents = await readLedger(ledgerPath);
  const freeEvents = durableEvents.filter((event) => event.order_id === freePurchase.order_id);
  const resilienceEvents = durableEvents.filter((event) => event.order_id === resiliencePurchase.order_id);
  for (const events of [freeEvents, resilienceEvents]) {
    assert.equal(events.some((event) => event.event_type.startsWith("delivery.")), false);
    assert.equal(events.some((event) => event.event_type.startsWith("revenue.")), false);
    assert.equal(events.some((event) => event.event_type.startsWith("entitlement.units_")), false);
  }
  // A zero-price purchase is permanent. The buyer surface has no cancel or
  // refund action; an old client attempting either route must not change the
  // entitlement, and both existing and fresh sessions remain usable.
  const permanentPurchase = await checkout(dashboard.url, "permanent-free-v2");
  assert.equal(permanentPurchase.payment.status, "not_required");
  assert.equal(permanentPurchase.entitlement.purchased_corpus_digest, corpus.v2Digest);
  const permanentSession = await connectRuntime(restartedRuntime.url, permanentPurchase.entitlement_id);
  sockets.push(permanentSession.socket);
  assert.equal((await permanentSession.ready).corpus_digest, corpus.v2Digest);

  const refundResponse = await fetch(
    `${dashboard.url}/v1/user/orders/${encodeURIComponent(permanentPurchase.order_id)}/refund-requests`,
    {
      method: "POST",
      headers: buyerMutationHeaders("legacy-free-refund-attempt"),
      body: JSON.stringify({ reason: "buyer_requested" })
    }
  );
  const refundRejected = await refundResponse.json() as JsonRecord;
  assert.equal(refundResponse.status, 409, JSON.stringify(refundRejected));
  assert.equal(refundRejected.error?.code, "unmetered_purchase_not_reversible");

  permanentSession.send(runMessage("run-after-refund"));
  const stillUsableRun = await permanentSession.waitFor((message) => (
    message.type === "turn.completed" && message.run_id === "run-after-refund"
  ));
  assert.equal(stillUsableRun.run_id, "run-after-refund");
  assert.equal(invokedRuns.has("run-after-refund"), true, "permanent access remains usable after a rejected buyer refund");

  const freshPermanentSession = await connectRuntime(restartedRuntime.url, permanentPurchase.entitlement_id);
  sockets.push(freshPermanentSession.socket);
  assert.equal((await freshPermanentSession.ready).corpus_digest, corpus.v2Digest);

  const revokedOrderResponse = await fetch(
    `${dashboard.url}/v1/user/orders/${encodeURIComponent(permanentPurchase.order_id)}`,
    { headers: buyerHeaders() }
  );
  const permanentOrder = (await revokedOrderResponse.json() as JsonRecord).order;
  assert.equal(revokedOrderResponse.status, 200);
  assert.equal(permanentOrder.refund_status, "none");
  assert.equal("delivery_status" in permanentOrder, false);
  assert.equal(permanentOrder.access.status, "active");

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
};

async function startRegistryFixture(corpus: CorpusReleases): Promise<RegistryFixture> {
  let currentDigest = corpus.v1Digest;
  const releases = new Map([
    [corpus.v1Digest, { corpus_digest: corpus.v1Digest }],
    [corpus.v2Digest, { corpus_digest: corpus.v2Digest, backward_compatible_with: corpus.v1Digest }],
    [corpus.v3Digest, { corpus_digest: corpus.v3Digest }]
  ]);
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
      if (request.method === "GET" && ["/v1/catalog/agents", "/v1/public/products"].includes(url.pathname)) {
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
          presentation: { inputs: ["A local request"], outputs: ["A local file"] }
        }]);
      }
      if (request.method === "GET" && url.pathname === `/v1/public/products/${PRODUCT_ID}`) {
        return json(response, 200, {
          creator_id: CREATOR_ID,
          creator_name: "Cross Process Creator",
          product_id: PRODUCT_ID,
          product_name: "Cross Process Product",
          product_description: "A product used to prove the real Runtime and Commerce boundary.",
          product_promise: "Create one durable local delivery.",
          product_boundaries: ["Does not upload private Workspace content."],
          corpus_digest: currentDigest,
          status: "published",
          presentation: { inputs: ["A local request"], outputs: ["A local file"] }
        });
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
      return json(response, 404, { detail: `Unhandled Registry fixture route: ${request.method} ${url.pathname}` });
    } catch (error) {
      return json(response, 500, { detail: error instanceof Error ? error.message : String(error) });
    }
  });
  await listen(server);
  return {
    server,
    url: serverUrl(server),
    publishDigest: (digestValue) => { currentDigest = digestValue; }
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
  const conversationRepository = new InMemoryConversationRepository();
  for (const runId of ["run-success", "run-repeat", "run-failed", "run-cancelled", "run-after-restart", "run-after-refund"]) {
    const publicId = `conversation-${runId}`;
    await conversationRepository.createConversation({
      id: durableConversationId({ creatorId: CREATOR_ID, userId: BUYER_ID, agentId: AGENT_ID, productId: PRODUCT_ID }, publicId),
      publicId,
      ownerAccountId: BUYER_ID,
      creatorId: CREATOR_ID,
      agentId: AGENT_ID,
      productId: PRODUCT_ID,
      corpusDigest: `sha256:${"0".repeat(64)}`
    });
  }
  const runtime = createRuntimeServer({
    createRuntime: input.createRuntime,
    conversationStore: new RuntimeStore(input.dataRoot),
    entitlementResolver: new RegistryEntitlementResolver(input.registryUrl, fetch, {
      commerceUrl: input.dashboardUrl,
      commerceServiceToken: COMMERCE_SERVICE_TOKEN
    }),
    agentCorpusResolver: new AgentCorpusResolver(input.corpusRoot),
    commerceEventSink: new HttpCommerceEventSink(input.dashboardUrl, COMMERCE_SERVICE_TOKEN),
    deliveryAccountingOutbox: new DeliveryAccountingOutbox(input.outboxPath),
    deliveryReconcileIntervalMs: input.reconcileIntervalMs,
    conversationRepository
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
        name: "file_write",
        locality: "client",
        approval: "ask",
        status: "completed",
        arguments: {
          path: "/Users/buyer/Private Workspace/result.md",
          content: "private artifact body"
        }
      };
      yield { type: "turn.completed", run_id: run.run_id, finish_reason: "stop" };
    }
  });
}

async function checkout(dashboardUrl: string, key: string): Promise<JsonRecord> {
  const detailResponse = await fetch(`${dashboardUrl}/v1/public/products/${PRODUCT_ID}`);
  const detail = await detailResponse.json() as JsonRecord;
  assert.equal(detailResponse.status, 200, JSON.stringify(detail));
  const sessionResponse = await fetch(`${dashboardUrl}/v1/checkout-sessions`, {
    method: "POST",
    headers: buyerMutationHeaders(`${key}:session`),
    body: JSON.stringify({
      product_id: PRODUCT_ID
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
    waitFor: async (predicate, timeoutMs) => {
      try {
        return await waitFor(() => messages.find(predicate), timeoutMs);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; messages=${JSON.stringify(messages)}`);
      }
    }
  };
}

function hello(entitlementId: string): JsonRecord {
  return {
    type: "client.hello",
    protocol_version: PROTOCOL_VERSION,
    auth_token: BUYER_TOKEN,
    entitlement_id: entitlementId,
    creator_id: CREATOR_ID,
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
