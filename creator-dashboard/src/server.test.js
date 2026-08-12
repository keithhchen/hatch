import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

const catalogAgent = {
  creator_id: "maya-chen",
  creator_name: "Maya Chen",
  agent_id: "signal-resume-reviewer",
  product_id: "signal-resume-review",
  product_name: "Signal Resume Review",
  product_description: "Resume review",
  product_promise: "Turn a resume into a concise signal map.",
  product_boundaries: ["Does not submit applications."],
  product_offer: { model: "per_delivery", amount_minor: 0, currency: "USD" },
  presentation: { accent: "fern" },
  corpus_digest: "sha256:current-corpus",
  published_at: "2026-08-02T00:00:00.000Z"
};

const readyFactoryRun = {
  id: "factory_ready_candidate",
  task_name: "Signal Resume Review",
  status: "ready",
  version: 1,
  agent_id: catalogAgent.agent_id,
  product: {
    id: catalogAgent.product_id,
    name: catalogAgent.product_name,
    description: catalogAgent.product_description,
    promise: catalogAgent.product_promise,
    boundaries: catalogAgent.product_boundaries
  },
  candidate: {
    version: 1,
    corpus_digest: "sha256:candidate-corpus",
    system_digest: "sha256:candidate-system",
    corpus_verified: true,
    regression_digest: "sha256:regression-report",
    held_out_digest: "sha256:held-out-report",
    held_out_sample_count: 3,
    failed_critical_cases: 0,
    factory_version: "creator-factory-contract-1"
  },
  updated_at: "2026-08-03T00:00:00.000Z"
};

test("Dashboard readiness fails closed when Registry is unavailable", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-health-"));
  const registry = registryFixture({ role: "user" });
  await listen(registry);
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const healthy = await fetch(`${serverUrl(api)}/readyz`);
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, commerce: "ready", registry: "ready" });

  await new Promise((resolve) => registry.close(resolve));
  const unhealthy = await fetch(`${serverUrl(api)}/readyz`);
  assert.equal(unhealthy.status, 503);
  assert.equal((await unhealthy.json()).error.code, "dashboard_not_ready");
  const live = await fetch(`${serverUrl(api)}/healthz`);
  assert.equal(live.status, 200);
});

test("creator products are projected directly from the Agent Corpus Registry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-creator-"));
  const registry = registryFixture({ role: "creator" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const response = await fetch(`${serverUrl(api)}/v1/creator/overview`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const overview = await response.json();

  assert.equal(response.status, 200, JSON.stringify(overview));
  assert.equal(overview.products[0].agent_id, catalogAgent.agent_id);
  assert.equal(overview.products[0].corpus_digest, catalogAgent.corpus_digest);
  assert.equal(overview.products[0].promise, catalogAgent.product_promise);
  assert.deepEqual(overview.products[0].boundaries, catalogAgent.product_boundaries);
  assert.equal(overview.products[0].status, "published");
  assert.equal(overview.metrics.orders, 0);
});

test("Creator can approve a verified candidate, set an offer, preview, publish, and receive a share URL", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-publish-"));
  const publishCalls = [];
  const registry = registryFixture({ role: "creator", factoryRun: readyFactoryRun, publishCalls });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const productId = catalogAgent.product_id;
  const candidateId = readyFactoryRun.id;

  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  const candidate = (await candidateResponse.json()).candidate;
  assert.equal(candidateResponse.status, 200);
  assert.equal(candidate.corpus_verified, true);

  const approvalResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-signal-resume-v1" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const approved = (await approvalResponse.json()).product;
  assert.equal(approvalResponse.status, 200);
  assert.equal(approved.status, "offer_required");
  const approvalReplay = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-signal-resume-v1" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  assert.equal(approvalReplay.status, 200);
  assert.equal((await approvalReplay.json()).product.version, approved.version);

  const offerResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/offer-draft`, {
    method: "PUT",
    headers: { ...headers, "idempotency-key": "offer-signal-resume-v1" },
    body: JSON.stringify({
      purchase_model: "per_delivery",
      amount_minor: 0,
      currency: "USD",
      unit: "delivery",
      included_units: 1,
      expected_version: approved.version
    })
  });
  const offered = (await offerResponse.json()).product;
  assert.equal(offerResponse.status, 200);
  assert.equal(offered.status, "ready_to_preview");
  const changedOfferReplay = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/offer-draft`, {
    method: "PUT",
    headers: { ...headers, "idempotency-key": "offer-signal-resume-v1" },
    body: JSON.stringify({
      purchase_model: "per_delivery",
      amount_minor: 0,
      currency: "USD",
      unit: "delivery",
      included_units: 2,
      expected_version: approved.version
    })
  });
  assert.equal(changedOfferReplay.status, 409);
  assert.equal((await changedOfferReplay.json()).error.code, "idempotency_conflict");

  const previewResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/storefront-preview`, { headers });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.readiness.ready, true);
  assert.equal(preview.offer.amount_minor, 0);

  const stalePublishResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-signal-resume-stale" },
    body: JSON.stringify({
      candidate_id: candidateId,
      offer_revision: offered.offer_draft.revision,
      expected_version: approved.version
    })
  });
  assert.equal(stalePublishResponse.status, 409);
  assert.equal(publishCalls.length, 0);

  const publishBody = {
    candidate_id: candidateId,
    offer_revision: offered.offer_draft.revision,
    expected_version: offered.version
  };
  const publishResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-signal-resume-v1" },
    body: JSON.stringify(publishBody)
  });
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 201);
  assert.equal(published.product.status, "published");
  assert.equal(published.public_url, `/agents/maya-chen/${productId}`);
  assert.equal(publishCalls.length, 1);
  const publicResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${productId}`);
  const publicProduct = (await publicResponse.json()).agent;
  assert.equal(publicResponse.status, 200);
  assert.equal(publicProduct.offer.offer_id, offered.offer_draft.offer_id);
  assert.equal(publicProduct.offer.revision, offered.offer_draft.revision);
  assert.deepEqual(
    dashboard.ledger.listEvents().filter((event) => event.event_type.startsWith("offer.")).map((event) => event.event_type),
    ["offer.revision_created", "offer.activated", "offer.revision_created", "offer.activated"]
  );
  const replayResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-signal-resume-v1" },
    body: JSON.stringify(publishBody)
  });
  assert.equal(replayResponse.status, 200);
  assert.equal(publishCalls.length, 1);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "offer.activated").length, 2);
});

test("public slug aliases resolve in the API and redirect browsers to the canonical product URL", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-slug-alias-"));
  const aliasedAgent = {
    ...catalogAgent,
    creator_slug: "maya-chen",
    product_slug: "signal-resume-review",
    creator_slug_aliases: ["maya-old"],
    product_slug_aliases: ["resume-review-old"]
  };
  const registry = registryFixture({ role: "user", catalogAgents: [aliasedAgent] });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry)
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const browserResponse = await fetch(`${serverUrl(api)}/creators/maya-old/resume-review-old`, { redirect: "manual" });
  assert.equal(browserResponse.status, 308);
  assert.equal(browserResponse.headers.get("location"), "/creators/maya-chen/signal-resume-review");

  const apiResponse = await fetch(`${serverUrl(api)}/v1/public/products/maya-old/resume-review-old`);
  const body = await apiResponse.json();
  assert.equal(apiResponse.status, 200, JSON.stringify(body));
  assert.equal(body.agent.public_url, "/creators/maya-chen/signal-resume-review");
});

test("Factory-only first publish does not seed a fake legacy deployment", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-first-publish-"));
  const deploymentCalls = [];
  const registry = registryFixture({
    role: "creator",
    factoryRun: readyFactoryRun,
    creatorAgents: [],
    catalogAgents: [],
    deploymentCalls
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryDeploymentServiceToken: "test-deployment-service",
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const productId = readyFactoryRun.product.id;
  const candidateId = readyFactoryRun.id;
  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  let candidate = (await candidateResponse.json()).candidate;
  assert.equal(candidateResponse.status, 200);

  const rejectionResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/reject`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "reject-first-publish-candidate" },
    body: JSON.stringify({ expected_version: candidate.resource_version, reason: "review_again" })
  });
  assert.equal(rejectionResponse.status, 200);
  const rejected = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(rejected.release, undefined);
  assert.equal(rejected.active_deployment_id, undefined);

  const refreshedCandidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  candidate = (await refreshedCandidateResponse.json()).candidate;
  assert.equal(refreshedCandidateResponse.status, 200);

  const approvalResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-first-publish" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const approved = (await approvalResponse.json()).product;
  assert.equal(approvalResponse.status, 200);
  const unseeded = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(unseeded.release, undefined);
  assert.equal(unseeded.active_deployment_id, undefined);
  assert.equal(dashboard.commerce.getActiveOffer(catalogAgent.creator_id, productId), undefined);

  const offerResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/offer-draft`, {
    method: "PUT",
    headers: { ...headers, "idempotency-key": "offer-first-publish" },
    body: JSON.stringify({
      purchase_model: "per_delivery",
      amount_minor: 0,
      currency: "USD",
      unit: "delivery",
      included_units: 1,
      expected_version: approved.version
    })
  });
  const offered = (await offerResponse.json()).product;
  assert.equal(offerResponse.status, 200);

  const publishResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-first-deployment" },
    body: JSON.stringify({
      candidate_id: candidateId,
      offer_revision: offered.offer_draft.revision,
      expected_version: offered.version
    })
  });
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 201, JSON.stringify(published));
  assert.equal(published.product.status, "published");
  assert.equal(published.release.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(deploymentCalls.filter((call) => call.type === "stage").length, 1);
  const activation = deploymentCalls.find((call) => call.type === "activate");
  assert.equal(activation.body.expected_current_digest, null);
  assert.equal(
    dashboard.commerce.getActiveOffer(catalogAgent.creator_id, productId).operation_id,
    dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId).active_deployment_id
  );
});

test("legacy live storefront remains stable until its replacement deployment commits", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-legacy-migration-"));
  const deploymentCalls = [];
  const registry = registryFixture({
    role: "creator",
    factoryRun: readyFactoryRun,
    deploymentCalls,
    activationFailures: 1
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryDeploymentServiceToken: "test-deployment-service",
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const productId = catalogAgent.product_id;
  const candidateId = readyFactoryRun.id;
  const candidateResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}`, { headers });
  const candidate = (await candidateResponse.json()).candidate;
  assert.equal(candidateResponse.status, 200);
  const approvalResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/candidates/${candidateId}/approve`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "approve-legacy-replacement" },
    body: JSON.stringify({
      expected_version: candidate.resource_version,
      report_digest: candidate.report_digest,
      acknowledgements: candidate.known_losses.map((loss) => loss.id)
    })
  });
  const approved = (await approvalResponse.json()).product;
  assert.equal(approvalResponse.status, 200);

  const seeded = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(seeded.release.corpus_digest, catalogAgent.corpus_digest);
  assert.match(seeded.active_deployment_id, /^migration:/);
  assert.equal(
    dashboard.commerce.getActiveOffer(catalogAgent.creator_id, productId).operation_id,
    seeded.active_deployment_id
  );

  const offerResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/offer-draft`, {
    method: "PUT",
    headers: { ...headers, "idempotency-key": "offer-legacy-replacement" },
    body: JSON.stringify({
      purchase_model: "per_delivery",
      amount_minor: 0,
      currency: "USD",
      unit: "delivery",
      included_units: 1,
      expected_version: approved.version
    })
  });
  const offered = (await offerResponse.json()).product;
  assert.equal(offerResponse.status, 200);

  const interruptedResponse = await fetch(`${serverUrl(api)}/v1/creator/products/${productId}/publish`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "publish-legacy-replacement" },
    body: JSON.stringify({
      candidate_id: candidateId,
      offer_revision: offered.offer_draft.revision,
      expected_version: offered.version
    })
  });
  assert.equal(interruptedResponse.status, 503);
  const pending = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(pending.release.corpus_digest, catalogAgent.corpus_digest);
  assert.ok(pending.publish_operation.offer_activated_at);
  assert.equal(pending.publish_operation.registry_activated_at, undefined);

  const duringResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${productId}`);
  const during = (await duringResponse.json()).agent;
  assert.equal(duringResponse.status, 200);
  assert.equal(during.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(during.offer.offer_id, seeded.offer_active.offer_id);
  assert.equal(during.offer.revision, seeded.offer_active.revision);

  const reconciled = await dashboard.reconcileDeployments();
  assert.equal(reconciled[0].status, "published");
  const committed = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, productId);
  assert.equal(committed.release.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.notEqual(committed.active_deployment_id, seeded.active_deployment_id);
  const activationCalls = deploymentCalls.filter((call) => call.type === "activate");
  assert.equal(activationCalls.length, 2);
  assert.equal(activationCalls[0].body.expected_current_digest, catalogAgent.corpus_digest);

  const afterResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${productId}`);
  const after = (await afterResponse.json()).agent;
  assert.equal(afterResponse.status, 200);
  assert.equal(after.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(after.offer.offer_id, offered.offer_draft.offer_id);
  assert.equal(after.offer.revision, offered.offer_draft.revision);
});

test("deployment reconciler resumes after Registry activation failure without exposing a mixed storefront tuple", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-deployment-reconcile-"));
  const deploymentCalls = [];
  const registry = registryFixture({
    role: "creator",
    factoryRun: readyFactoryRun,
    deploymentCalls,
    activationFailures: 1
  });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    portalStatePath: path.join(directory, "portal-state.json"),
    registryUrl: serverUrl(registry),
    registryDeploymentServiceToken: "test-deployment-service"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const candidate = {
    candidate_id: readyFactoryRun.id,
    agent_id: catalogAgent.agent_id,
    digest: readyFactoryRun.candidate.corpus_digest,
    report_digest: "sha256:deployment-report",
    corpus_verified: true
  };
  const approved = await dashboard.portalState.approveCandidate(
    catalogAgent.creator_id,
    catalogAgent.product_id,
    candidate,
    0
  );
  const offered = await dashboard.portalState.saveOffer(catalogAgent.creator_id, catalogAgent.product_id, {
    purchase_model: "per_delivery",
    amount_minor: 0,
    currency: "USD",
    unit: "delivery",
    included_units: 1
  }, approved.version);
  const pending = await dashboard.portalState.beginPublishProduct(catalogAgent.creator_id, catalogAgent.product_id, {
    candidate_id: candidate.candidate_id,
    offer_revision: offered.offer_draft.revision,
    expected_version: offered.version,
    agent_id: catalogAgent.agent_id,
    command_key: "deployment-reconcile"
  });

  const interrupted = await dashboard.reconcileDeployments();
  assert.equal(interrupted[0].status, "pending");
  let state = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, catalogAgent.product_id);
  assert.equal(state.release, undefined);
  assert.ok(state.publish_operation.materialized_at);
  assert.ok(state.publish_operation.offer_activated_at);
  assert.equal(state.publish_operation.registry_activated_at, undefined);
  assert.equal(state.publish_operation.attempts, 1);
  assert.equal(dashboard.commerce.getActiveOffer(catalogAgent.creator_id, catalogAgent.product_id).operation_id, pending.publish_operation.operation_id);

  const duringFailure = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${catalogAgent.product_id}`);
  const duringProduct = (await duringFailure.json()).agent;
  assert.equal(duringFailure.status, 200);
  assert.equal(duringProduct.offer, null);
  assert.equal(duringProduct.availability, "not_for_sale");

  const recovered = await dashboard.reconcileDeployments();
  assert.equal(recovered[0].status, "published");
  state = dashboard.portalState.getCreatorProduct(catalogAgent.creator_id, catalogAgent.product_id);
  assert.equal(state.publish_operation, undefined);
  assert.equal(state.release.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(state.active_deployment_id, pending.publish_operation.operation_id);
  assert.equal(deploymentCalls.filter((call) => call.type === "stage").length, 1);
  assert.equal(deploymentCalls.filter((call) => call.type === "activate").length, 2);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "offer.activated").length, 1);

  const afterRecovery = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${catalogAgent.product_id}`);
  const recoveredProduct = (await afterRecovery.json()).agent;
  assert.equal(recoveredProduct.corpus_digest, readyFactoryRun.candidate.corpus_digest);
  assert.equal(recoveredProduct.offer.revision, offered.offer_draft.revision);
});

test("zero-value checkout creates an idempotent Agent Corpus order and entitlement", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-checkout-"));
  const accessBodies = [];
  const registry = registryFixture({ role: "user", accessBodies });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const token = await login(api);
  const checkout = (intentKey = "legacy-free-checkout-one") => fetch(`${serverUrl(api)}/v1/user/checkout`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": intentKey
    },
    body: JSON.stringify({ creator_id: catalogAgent.creator_id, product_id: catalogAgent.product_id })
  });

  const first = await checkout();
  const firstBody = await first.json();
  assert.equal(first.status, 201);
  assert.equal(firstBody.order.agent_id, catalogAgent.agent_id);
  assert.equal(firstBody.order.corpus_digest, catalogAgent.corpus_digest);
  assert.equal(firstBody.order.gross_minor, 0);
  assert.match(firstBody.entitlement.entitlement_id, /^entitlement_[a-f0-9]{24}$/);
  assert.equal(accessBodies[0].order_id, firstBody.order.order_id);
  assert.equal(accessBodies[0].entitlement_id, firstBody.entitlement.entitlement_id);
  assert.deepEqual(dashboard.ledger.listEvents().map((event) => event.event_type), [
    "offer.revision_created",
    "offer.activated",
    "order.placed",
    "entitlement.granted"
  ]);
  const activeOffer = dashboard.commerce.getActiveOffer(catalogAgent.creator_id, catalogAgent.product_id);
  assert.equal(activeOffer.offer_id, firstBody.order.offer_id);
  assert.equal(activeOffer.revision, firstBody.order.offer_revision);
  assert.equal(activeOffer.corpus_digest, catalogAgent.corpus_digest);

  const replay = await checkout();
  assert.equal(replay.status, 200);
  assert.equal(dashboard.ledger.listEvents().length, 4);

  const secondPurchase = await checkout("legacy-free-checkout-two");
  const secondBody = await secondPurchase.json();
  assert.equal(secondPurchase.status, 201);
  assert.notEqual(secondBody.order.order_id, firstBody.order.order_id);
  assert.notEqual(secondBody.entitlement.entitlement_id, firstBody.entitlement.entitlement_id);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "order.placed").length, 2);
  assert.equal(dashboard.ledger.listEvents().filter((event) => event.event_type === "entitlement.granted").length, 2);
});

test("V2 checkout session persists a free receipt and entitlement detail", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-v2-checkout-"));
  const accessBodies = [];
  const revokedEntitlements = [];
  const registry = registryFixture({ role: "user", accessBodies, revokedEntitlements });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "checkout-session-free" };

  const detailResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${catalogAgent.product_id}`);
  const detail = await detailResponse.json();
  assert.equal(detailResponse.status, 200);
  assert.equal(detail.agent.available, true);
  assert.equal(detail.agent.offer.amount_minor, 0);
  const canonicalDetailResponse = await fetch(`${serverUrl(api)}/v1/public/products/${catalogAgent.creator_id}/${catalogAgent.product_id}`);
  const canonicalDetail = await canonicalDetailResponse.json();
  assert.equal(canonicalDetailResponse.status, 200);
  assert.equal(canonicalDetail.agent.offer.amount_minor, 0);

  const createSession = () => fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      creator_id: catalogAgent.creator_id,
      product_id: catalogAgent.product_id,
      offer_id: detail.agent.offer.offer_id
    })
  });
  const firstSessionResponse = await createSession();
  const firstSession = (await firstSessionResponse.json()).checkout_session;
  assert.equal(firstSessionResponse.status, 201);
  assert.equal(firstSession.totals.total_minor, 0);
  const replaySessionResponse = await createSession();
  assert.equal(replaySessionResponse.status, 200);
  assert.equal((await replaySessionResponse.json()).checkout_session.checkout_session_id, firstSession.checkout_session_id);

  const confirm = () => fetch(`${serverUrl(api)}/v1/checkout-sessions/${firstSession.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  const confirmedResponse = await confirm();
  const confirmed = await confirmedResponse.json();
  assert.equal(confirmedResponse.status, 201);
  assert.equal(confirmed.payment.status, "not_required");
  assert.equal(confirmed.order.status, "fulfilled");
  assert.equal(confirmed.entitlement.remaining_units, 1);
  assert.equal(accessBodies[0].entitlement_id, confirmed.entitlement_id);

  const replayConfirmResponse = await confirm();
  assert.equal(replayConfirmResponse.status, 200);
  assert.equal((await replayConfirmResponse.json()).order_id, confirmed.order_id);

  const orderResponse = await fetch(`${serverUrl(api)}/v1/user/orders/${confirmed.order_id}`, { headers });
  const order = (await orderResponse.json()).order;
  assert.equal(orderResponse.status, 200);
  assert.equal(order.payment_status, "not_required");
  assert.equal(order.subtotal_minor, 0);
  assert.equal(order.discount_minor, 0);
  assert.equal(order.tax_minor, null);
  assert.equal(order.total_minor, 0);
  assert.equal(order.entitlement_status, "active");
  assert.equal(order.actions.can_request_refund, false);
  assert.equal(order.actions.can_cancel_access, true);

  const canonicalOrdersResponse = await fetch(`${serverUrl(api)}/v1/orders`, { headers });
  const canonicalOrders = await canonicalOrdersResponse.json();
  assert.equal(canonicalOrdersResponse.status, 200);
  assert.equal(canonicalOrders.orders.length, 1);
  const canonicalOrderResponse = await fetch(`${serverUrl(api)}/v1/orders/${encodeURIComponent(order.order_number ?? confirmed.order_id)}`, { headers });
  assert.equal(canonicalOrderResponse.status, 200);
  assert.equal((await canonicalOrderResponse.json()).order.order_id, confirmed.order_id);
  const canonicalLibraryResponse = await fetch(`${serverUrl(api)}/v1/library`, { headers });
  const canonicalLibrary = await canonicalLibraryResponse.json();
  assert.equal(canonicalLibraryResponse.status, 200);
  assert.equal(canonicalLibrary.entitlements.length, 1);

  const entitlementResponse = await fetch(`${serverUrl(api)}/v1/user/entitlements/${confirmed.entitlement_id}`, { headers });
  const entitlement = (await entitlementResponse.json()).entitlement;
  assert.equal(entitlementResponse.status, 200);
  assert.equal(entitlement.product.name, catalogAgent.product_name);
  assert.equal(entitlement.remaining_units, 1);
  const canonicalEntitlementResponse = await fetch(`${serverUrl(api)}/v1/library/${confirmed.entitlement_id}`, { headers });
  assert.equal(canonicalEntitlementResponse.status, 200);
  assert.equal((await canonicalEntitlementResponse.json()).entitlement.entitlement_id, confirmed.entitlement_id);

  await recordDelivery(dashboard, { order: confirmed.order, entitlement: confirmed.entitlement }, {
    prefix: "buyer-entitlement-history",
    artifactType: "markdown"
  });
  const deliveredEntitlementResponse = await fetch(`${serverUrl(api)}/v1/user/entitlements/${confirmed.entitlement_id}`, { headers });
  const deliveredEntitlement = (await deliveredEntitlementResponse.json()).entitlement;
  assert.equal(deliveredEntitlementResponse.status, 200);
  assert.equal(deliveredEntitlement.status, "consumed");
  assert.equal(deliveredEntitlement.deliveries.length, 1);
  assert.equal(deliveredEntitlement.deliveries[0].artifact_type, "markdown");
  assert.equal(deliveredEntitlement.deliveries[0].status, "completed");
  const deliveredOrderResponse = await fetch(`${serverUrl(api)}/v1/user/orders/${confirmed.order_id}`, { headers });
  const deliveredOrder = (await deliveredOrderResponse.json()).order;
  assert.equal(deliveredOrder.actions.can_cancel_access, false);
  const lateCancellation = await fetch(`${serverUrl(api)}/v1/user/orders/${confirmed.order_id}/refund-requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "too_late" })
  });
  assert.equal(lateCancellation.status, 409);
  assert.deepEqual(revokedEntitlements, []);
});

test("a free order can remove access before delivery", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-free-cancel-"));
  const revokedEntitlements = [];
  const registry = registryFixture({ role: "user", revokedEntitlements });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "free-cancel" };
  const detailResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${catalogAgent.creator_id}/${catalogAgent.product_id}`);
  const offer = (await detailResponse.json()).agent.offer;
  const sessionResponse = await fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ product_id: catalogAgent.product_id, offer_id: offer.offer_id })
  });
  const session = (await sessionResponse.json()).checkout_session;
  const confirmationResponse = await fetch(`${serverUrl(api)}/v1/checkout-sessions/${session.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  const confirmation = await confirmationResponse.json();
  assert.equal(confirmationResponse.status, 201, JSON.stringify(confirmation));

  const cancellationResponse = await fetch(`${serverUrl(api)}/v1/orders/${confirmation.order_id}/cancel`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "buyer_removed_free_access" })
  });
  const cancellation = await cancellationResponse.json();
  assert.equal(cancellationResponse.status, 201);
  assert.equal(cancellation.order.status, "cancelled");
  assert.equal(cancellation.order.entitlement_status, "revoked");
  assert.equal(cancellation.refund.gross_minor, 0);
  assert.deepEqual(revokedEntitlements, [confirmation.entitlement_id]);
});

test("Creator fulfilled filter includes delivered orders and disconnected payouts do not invent balances", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-creator-delivery-"));
  const registry = registryFixture({ role: "creator" });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registry),
    exposeBearerTokens: true
  });
  await dashboard.commerce.createPayment({
    payment_id: "pay-creator-filter",
    buyer_id: "buyer-creator-filter",
    creator_id: catalogAgent.creator_id,
    product_id: catalogAgent.product_id,
    amount_minor: 3900,
    currency: "USD",
    provider: "test-provider",
    idempotency_key: "payment:creator-filter"
  });
  await dashboard.commerce.recordPaymentProviderEvent({
    payment_id: "pay-creator-filter",
    provider: "test-provider",
    provider_event_id: "payment-event-creator-filter",
    provider_payment_id: "provider-pay-creator-filter",
    status: "succeeded"
  });
  const checkout = await dashboard.commerce.confirmCheckout({
    buyer_id: "buyer-creator-filter",
    buyer_display_name: "Delivery Buyer",
    creator_id: catalogAgent.creator_id,
    creator_display_name: catalogAgent.creator_name,
    agent_id: catalogAgent.agent_id,
    product_id: catalogAgent.product_id,
    product_name: catalogAgent.product_name,
    corpus_digest: catalogAgent.corpus_digest,
    release_id: catalogAgent.corpus_digest,
    offer_id: "offer-paid-filter",
    offer_revision: 1,
    gross_minor: 3900,
    currency: "USD",
    payment_status: "paid",
    payment_id: "pay-creator-filter",
    included_units: 1,
    idempotency_key: "checkout:creator-filter"
  });
  await recordDelivery(dashboard, checkout, { prefix: "creator-filter", artifactType: "pdf" });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}` };

  const ordersResponse = await fetch(`${serverUrl(api)}/v1/creator/orders?order=fulfilled`, { headers });
  const orders = (await ordersResponse.json()).orders;
  assert.equal(ordersResponse.status, 200);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "delivered");
  assert.equal(orders[0].delivery_status, "completed");

  const exportResponse = await fetch(`${serverUrl(api)}/v1/creator/orders/export?order=fulfilled`, { headers });
  const exported = await exportResponse.text();
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get("content-type"), /^text\/csv/);
  assert.match(exportResponse.headers.get("content-disposition"), /hatch-creator-orders\.csv/);
  assert.match(exported, /order_reference,buyer_display_name,product_id/);
  assert.match(exported, /Delivery Buyer/);
  assert.match(exported, /pdf/);
  for (const privateField of ["prompt", "workspace", "artifact_path", "conversation", "tool_arguments", "file_content"]) {
    assert.doesNotMatch(exported.toLowerCase(), new RegExp(privateField));
  }

  const payoutsResponse = await fetch(`${serverUrl(api)}/v1/creator/payouts`, { headers });
  const payouts = await payoutsResponse.json();
  assert.equal(payoutsResponse.status, 200);
  assert.equal(payouts.account_status, "not_connected");
  assert.equal(payouts.balance_status, "unavailable");
  assert.equal(payouts.setup_available, false);
  assert.equal(payouts.available_minor, null);
  assert.equal(payouts.pending_minor, null);
  assert.deepEqual(payouts.payouts, []);
});

test("paid test checkout can be fully refunded and revokes Registry access", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-v2-refund-"));
  const paidAgent = { ...catalogAgent, product_offer: { model: "per_delivery", amount_minor: 3900, currency: "USD", included_units: 1 } };
  const revokedEntitlements = [];
  const registry = registryFixture({ role: "user", agent: paidAgent, revokedEntitlements });
  await listen(registry);
  context.after(() => registry.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryAccessServiceToken: "test-access-service",
    registryUrl: serverUrl(registry),
    paymentMode: "test",
    exposeBearerTokens: true
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const token = await login(api);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": "paid-flow" };
  const detailResponse = await fetch(`${serverUrl(api)}/v1/catalog/agents/${paidAgent.creator_id}/${paidAgent.product_id}`);
  const offer = (await detailResponse.json()).agent.offer;

  const sessionResponse = await fetch(`${serverUrl(api)}/v1/checkout-sessions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ product_id: paidAgent.product_id, offer_id: offer.offer_id })
  });
  const session = (await sessionResponse.json()).checkout_session;
  assert.equal(sessionResponse.status, 201);
  assert.equal(session.totals.total_minor, 3900);
  const confirmationResponse = await fetch(`${serverUrl(api)}/v1/checkout-sessions/${session.checkout_session_id}/confirm`, {
    method: "POST",
    headers,
    body: "{}"
  });
  const confirmation = await confirmationResponse.json();
  assert.equal(confirmationResponse.status, 201, JSON.stringify(confirmation));
  assert.equal(confirmation.payment.status, "succeeded");

  const beforeRefund = await fetch(`${serverUrl(api)}/v1/user/orders/${confirmation.order_id}`, { headers });
  assert.equal((await beforeRefund.json()).order.actions.can_request_refund, true);
  const refundResponse = await fetch(`${serverUrl(api)}/v1/user/orders/${confirmation.order_id}/refund-requests`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: "buyer_requested" })
  });
  const refunded = await refundResponse.json();
  assert.equal(refundResponse.status, 201);
  assert.equal(refunded.order.status, "refunded");
  assert.equal(refunded.order.entitlement_status, "revoked");
  assert.equal(refunded.refund.gross_minor, 3900);
  assert.deepEqual(revokedEntitlements, [confirmation.entitlement_id]);
});

async function recordDelivery(app, checkout, { prefix, artifactType }) {
  const taskId = `task-${prefix}`;
  const artifactId = `artifact-${prefix}`;
  const deliveryId = `delivery-${prefix}`;
  const reservation = await app.commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: taskId,
    task_id: taskId,
    idempotency_key: `reserve:${prefix}`
  });
  const identity = {
    order_id: checkout.order.order_id,
    buyer_id: checkout.order.buyer_id,
    creator_id: checkout.order.creator_id,
    agent_id: checkout.order.agent_id,
    product_id: checkout.order.product_id,
    corpus_digest: checkout.order.corpus_digest
  };
  await app.ledger.append("task.started", {
    ...identity,
    entitlement_id: checkout.entitlement.entitlement_id,
    task_id: taskId
  }, { idempotencyKey: `task:${prefix}` });
  await app.ledger.append("artifact.created", {
    ...identity,
    task_id: taskId,
    artifact_id: artifactId,
    artifact_digest: `sha256:${"d".repeat(64)}`
  }, { idempotencyKey: `artifact:${prefix}` });
  return app.commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    task_id: taskId,
    artifact_id: artifactId,
    artifact_type: artifactType,
    delivery_id: deliveryId,
    idempotency_key: `delivery:${prefix}`
  });
}

function registryFixture({
  role,
  accessBodies = [],
  revokedEntitlements = [],
  agent = catalogAgent,
  creatorAgents,
  catalogAgents,
  factoryRun = null,
  publishCalls = [],
  deploymentCalls = [],
  activationFailures = 0
}) {
  let remainingActivationFailures = activationFailures;
  const publishedCreatorAgents = creatorAgents ?? [agent];
  const publishedCatalogAgents = catalogAgents ?? [agent];
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://registry.test");
    let content = "";
    for await (const chunk of request) content += chunk;
    response.setHeader("content-type", "application/json");
    const account = role === "creator"
      ? { id: "maya-chen", role: "creator", email: "creator@example.test", display_name: "Maya Chen" }
      : { id: "buyer-zero", role: "user", email: "buyer@example.test", display_name: "Zero Buyer" };
    if (requestUrl.pathname === "/health" || requestUrl.pathname === "/readyz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/signin") {
      response.end(JSON.stringify({ token: `signed-${role}-token`, account }));
      return;
    }
    if (requestUrl.pathname === "/v1/auth/me") {
      response.end(JSON.stringify(account));
      return;
    }
    if (requestUrl.pathname === "/v1/catalog/agents") {
      response.end(JSON.stringify(publishedCatalogAgents));
      return;
    }
    if (requestUrl.pathname === "/v1/creator/agents") {
      response.end(JSON.stringify(publishedCreatorAgents));
      return;
    }
    if (requestUrl.pathname === "/v1/creator/factory-runs" && request.method === "GET") {
      response.end(JSON.stringify({ runs: factoryRun ? [factoryRun] : [] }));
      return;
    }
    if (factoryRun && requestUrl.pathname === `/v1/creator/factory-runs/${factoryRun.id}` && request.method === "GET") {
      response.end(JSON.stringify(factoryRun));
      return;
    }
    if (factoryRun && requestUrl.pathname === `/v1/creator/factory-runs/${factoryRun.id}/publish` && request.method === "POST") {
      publishCalls.push(content ? JSON.parse(content) : {});
      response.end(JSON.stringify({ ...agent, corpus_digest: factoryRun.candidate.corpus_digest }));
      return;
    }
    if (factoryRun
      && requestUrl.pathname === `/v1/internal/deployments/factory-runs/${factoryRun.id}/stage`
      && request.method === "POST") {
      const body = content ? JSON.parse(content) : {};
      deploymentCalls.push({ type: "stage", body });
      response.end(JSON.stringify({
        agent_corpus: { ...agent, corpus_digest: factoryRun.candidate.corpus_digest },
        current: false,
        operation_id: body.operation_id
      }));
      return;
    }
    const deploymentActivate = requestUrl.pathname.match(/^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/releases\/([^/]+)\/activate$/);
    if (deploymentActivate && request.method === "POST") {
      const body = content ? JSON.parse(content) : {};
      deploymentCalls.push({ type: "activate", body });
      if (remainingActivationFailures > 0) {
        remainingActivationFailures -= 1;
        response.statusCode = 503;
        response.end(JSON.stringify({ code: "registry_temporarily_unavailable", detail: "activation interrupted" }));
        return;
      }
      response.end(JSON.stringify({
        agent_corpus: {
          ...agent,
          agent_id: decodeURIComponent(deploymentActivate[1]),
          corpus_digest: decodeURIComponent(deploymentActivate[2])
        },
        current: true,
        operation_id: body.operation_id
      }));
      return;
    }
    if (requestUrl.pathname === "/v1/user/agent-access" && request.method === "GET") {
      response.end(JSON.stringify([]));
      return;
    }
    if (requestUrl.pathname === `/v1/user/agents/${agent.creator_id}/${agent.agent_id}/access`) {
      const accessBody = content ? JSON.parse(content) : {};
      accessBodies.push(accessBody);
      response.end(JSON.stringify({
        entitlement_id: accessBody.entitlement_id ?? "ent_zero",
        order_id: accessBody.order_id,
        user_id: "buyer-zero",
        creator_id: agent.creator_id,
        agent_id: agent.agent_id,
        product_id: agent.product_id,
        status: "active",
        granted_at: "2026-08-02T00:00:00.000Z"
      }));
      return;
    }
    const revokeMatch = requestUrl.pathname.match(/^\/v1\/user\/agent-access\/([^/]+)$/);
    if (request.method === "DELETE" && revokeMatch) {
      revokedEntitlements.push(decodeURIComponent(revokeMatch[1]));
      response.end(JSON.stringify({ entitlement_id: decodeURIComponent(revokeMatch[1]), status: "revoked" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ detail: "not found" }));
  });
}

async function login(server) {
  const response = await fetch(`${serverUrl(server)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "fixture@example.test", password: "test-only" })
  });
  return (await response.json()).token;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
