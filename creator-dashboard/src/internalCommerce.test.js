import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";

test("Runtime Commerce API is service-authenticated, idempotent, and privacy-safe", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-internal-commerce-"));
  const sourceDigest = `sha256:${"a".repeat(64)}`;
  const compatibleDigest = `sha256:${"b".repeat(64)}`;
  const wrongLineageDigest = `sha256:${"c".repeat(64)}`;
  const registryAuthority = createRegistryAuthorityFixture({
    token: "registry-deployment-secret",
    releases: [
      {
        creator_id: "creator-internal",
        agent_id: "agent-internal",
        product_id: "product-internal",
        corpus_digest: compatibleDigest,
        backward_compatible_with: sourceDigest,
        status: "published"
      },
      {
        creator_id: "creator-internal",
        agent_id: "agent-internal",
        product_id: "product-internal",
        corpus_digest: wrongLineageDigest,
        backward_compatible_with: `sha256:${"d".repeat(64)}`,
        status: "published"
      }
    ]
  });
  await listen(registryAuthority);
  context.after(() => registryAuthority.close());
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: serverUrl(registryAuthority),
    registryDeploymentServiceToken: "registry-deployment-secret",
    commerceRuntimeServiceToken: "runtime-commerce-secret"
  });
  const checkout = await dashboard.commerce.confirmCheckout({
    buyer_id: "buyer-internal",
    creator_id: "creator-internal",
    agent_id: "agent-internal",
    product_id: "product-internal",
    corpus_digest: sourceDigest,
    release_id: sourceDigest,
    gross_minor: 0,
    currency: "USD",
    version_policy: "track_current_compatible",
    idempotency_key: "checkout-internal"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const base = serverUrl(api);

  const unauthorized = await fetch(`${base}/v1/internal/commerce/reservations`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "reserve-internal" },
    body: JSON.stringify({ entitlement_id: checkout.entitlement.entitlement_id, run_id: "run-internal" })
  });
  assert.equal(unauthorized.status, 403);

  const headers = {
    authorization: "Bearer runtime-commerce-secret",
    "content-type": "application/json"
  };
  const authorizationUrl = `${base}/v1/internal/commerce/entitlements/${checkout.entitlement.entitlement_id}/authorization`;
  const authorization = await fetch(authorizationUrl, { headers });
  const authorizationBody = (await authorization.json()).authorization;
  assert.equal(authorization.status, 200);
  assert.equal(authorizationBody.authorized, true);
  assert.equal(authorizationBody.reason, "authorized");
  assert.equal(authorizationBody.order_id, checkout.order.order_id);
  assert.equal(authorizationBody.purchased_corpus_digest, sourceDigest);
  assert.equal(authorizationBody.effective_corpus_digest, sourceDigest);
  const unauthorizedRead = await fetch(authorizationUrl);
  assert.equal(unauthorizedRead.status, 403);
  const versionAdvanceUrl = `${base}/v1/internal/commerce/entitlements/${checkout.entitlement.entitlement_id}/advance-version`;
  const versionEventCount = () => dashboard.ledger.listEvents()
    .filter((event) => event.event_type === "entitlement.version_advanced").length;
  const forgedDeclaration = await fetch(versionAdvanceUrl, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "advance-forged-declaration" },
    body: JSON.stringify({
      from_digest: sourceDigest,
      to_digest: compatibleDigest,
      from_release_id: sourceDigest,
      to_release_id: compatibleDigest,
      compatibility_declaration_id: "caller-forged-compatibility"
    })
  });
  assert.equal(forgedDeclaration.status, 409);
  assert.equal((await forgedDeclaration.json()).error.code, "compatibility_declaration_invalid");
  assert.equal(versionEventCount(), 0, "a forged declaration must not append a version event");

  const wrongLineage = await fetch(versionAdvanceUrl, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "advance-wrong-lineage" },
    body: JSON.stringify({
      from_digest: sourceDigest,
      to_digest: wrongLineageDigest,
      from_release_id: sourceDigest,
      to_release_id: wrongLineageDigest,
      compatibility_declaration_id: `corpus-compatibility:creator-internal:agent-internal:${wrongLineageDigest}`
    })
  });
  assert.equal(wrongLineage.status, 409);
  assert.equal((await wrongLineage.json()).error.code, "version_lineage_unverified");
  assert.equal(versionEventCount(), 0, "an unrelated Registry release must not append a version event");

  const advance = await fetch(`${base}/v1/internal/commerce/entitlements/${checkout.entitlement.entitlement_id}/advance-version`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "advance-internal" },
    body: JSON.stringify({
      from_digest: checkout.entitlement.effective_corpus_digest,
      to_digest: compatibleDigest,
      from_release_id: sourceDigest,
      to_release_id: compatibleDigest,
      compatibility_declaration_id: `corpus-compatibility:creator-internal:agent-internal:${compatibleDigest}`,
      creator_id: "caller-must-not-control-identity",
      product_id: "caller-must-not-control-product"
    })
  });
  const advanced = (await advance.json()).entitlement;
  assert.equal(advance.status, 200);
  assert.equal(advanced.purchased_corpus_digest, checkout.entitlement.purchased_corpus_digest);
  assert.equal(advanced.effective_corpus_digest, compatibleDigest);
  const replayedAdvance = await fetch(versionAdvanceUrl, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "advance-internal" },
    body: JSON.stringify({
      from_digest: sourceDigest,
      to_digest: compatibleDigest,
      from_release_id: sourceDigest,
      to_release_id: compatibleDigest,
      compatibility_declaration_id: `corpus-compatibility:creator-internal:agent-internal:${compatibleDigest}`,
      creator_id: "another-untrusted-caller-identity"
    })
  });
  assert.equal(replayedAdvance.status, 200);
  assert.equal((await replayedAdvance.json()).entitlement.effective_corpus_digest, compatibleDigest);
  assert.equal(versionEventCount(), 1, "an idempotent replay must retain one authoritative version event");
  const versionEvent = dashboard.ledger.listEvents().find((event) => event.event_type === "entitlement.version_advanced");
  assert.equal(versionEvent.creator_id, "creator-internal");
  assert.equal(versionEvent.product_id, "product-internal");
  const rejectedPrivateReservation = await fetch(`${base}/v1/internal/commerce/reservations`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "reserve-private" },
    body: JSON.stringify({
      entitlement_id: checkout.entitlement.entitlement_id,
      run_id: "run-private",
      conversation_id: "must-not-cross-commerce"
    })
  });
  assert.equal(rejectedPrivateReservation.status, 400);
  assert.equal((await rejectedPrivateReservation.json()).error.code, "private_commerce_field");

  const forbiddenMatrix = [
    ["artifact_path", "/Users/buyer/private-output.md"],
    ["WorkspacePath", "/Users/buyer/workspace"],
    ["content", "verbatim buyer prompt"],
    ["conversation-id", "conversation-private"],
    ["toolArguments", { query: "private research" }],
    ["ARGUMENTS", ["--secret", "private-token"]]
  ];
  for (const [index, [field, value]] of forbiddenMatrix.entries()) {
    const response = await fetch(`${base}/v1/internal/commerce/reservations`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `reserve-private-matrix-${index}` },
      body: JSON.stringify({
        entitlement_id: checkout.entitlement.entitlement_id,
        run_id: `run-private-matrix-${index}`,
        metadata: { nested: { [field]: value } }
      })
    });
    assert.equal(response.status, 400, field);
    assert.equal((await response.json()).error.code, "private_commerce_field", field);
  }

  const reserve = await fetch(`${base}/v1/internal/commerce/reservations`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "reserve-internal" },
    body: JSON.stringify({
      entitlement_id: checkout.entitlement.entitlement_id,
      run_id: "run-internal",
      task_id: "task-internal"
    })
  });
  const rejectedReservation = await reserve.json();
  assert.equal(reserve.status, 409);
  assert.equal(rejectedReservation.error.code, "access_unmetered");

  const rejectedPrivateArtifact = await fetch(`${base}/v1/internal/commerce/events`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": "artifact-private" },
    body: JSON.stringify({
      type: "artifact.created",
      payload: { artifact_id: "private", artifact_path: "/Users/buyer/private.md" }
    })
  });
  assert.equal(rejectedPrivateArtifact.status, 400);
  assert.equal((await rejectedPrivateArtifact.json()).error.code, "private_commerce_field");

  const stillAuthorized = await fetch(authorizationUrl, { headers });
  const stillAuthorizedBody = (await stillAuthorized.json()).authorization;
  assert.equal(stillAuthorized.status, 200);
  assert.equal(stillAuthorizedBody.authorized, true);
  assert.equal(stillAuthorizedBody.reason, "authorized");
  assert.equal(stillAuthorizedBody.access_mode, "unmetered");
  assert.equal(dashboard.ledger.listEvents().some((event) => event.conversation_id), false);
  assert.equal(dashboard.ledger.listEvents().some((event) => event.artifact_path), false);
  const persistedCommerce = JSON.stringify(dashboard.ledger.listEvents());
  for (const [, value] of forbiddenMatrix) {
    const privateNeedle = typeof value === "string" ? value : JSON.stringify(value);
    assert.equal(persistedCommerce.includes(privateNeedle), false);
  }

  await dashboard.telemetry.record("checkout_started", {}, {
    idempotencyKey: "operations-funnel-checkout-started"
  });
  const operations = await fetch(`${base}/v1/internal/commerce/operations`, { headers });
  const operational = await operations.json();
  assert.equal(operations.status, 200);
  assert.equal(operational.funnel.checkout_started, 1);
  assert.equal(operational.counts.revenue_pending, 0);
  assert.equal(operational.counts.refund_projection_lag, 0);
  assert.equal(operational.counts.stale_reservations, 0);
  assert.equal(operational.counts.alerts, 0);
  assert.deepEqual(operational.alerts, []);

  const staleClock = () => new Date(Date.now() - 10 * 60_000);
  dashboard.portalState.clock = staleClock;
  const pendingCheckout = await dashboard.portalState.createCheckoutSession({
    request_key: "checkout-operational-stale",
    buyer_id: "buyer-operational",
    product: { creator_id: "creator-internal", product_id: "product-internal" },
    totals: { total_minor: 0, currency: "USD" }
  });
  await dashboard.portalState.markCheckoutFulfillmentPending(pendingCheckout.checkout_session_id, {
    order_id: "order-operational",
    entitlement_id: "entitlement-operational"
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dashboard.portalState.noteCheckoutReconcileFailure(pendingCheckout.checkout_session_id, {
      code: "registry_unavailable"
    });
  }
  dashboard.portalState.clock = () => new Date();

  const attentionResponse = await fetch(`${base}/v1/internal/commerce/operations`, { headers });
  const attention = await attentionResponse.json();
  assert.equal(attentionResponse.status, 200);
  assert.equal(attention.counts.fulfillment_pending, 1);
  assert.equal(attention.counts.alerts, 1);
  assert.deepEqual(attention.alerts[0], {
    severity: "critical",
    category: "fulfillment_pending",
    resource_id: pendingCheckout.checkout_session_id,
    age_ms: attention.alerts[0].age_ms,
    retry_count: 3,
    last_error_category: "registry_unavailable"
  });
  assert.ok(attention.alerts[0].age_ms >= 9 * 60_000);
});

test("entitlement version advance fails closed without Registry authority", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-version-authority-closed-"));
  const dashboard = await createDashboardApp({
    ledgerPath: path.join(directory, "ledger.jsonl"),
    registryUrl: "http://127.0.0.1:1",
    commerceRuntimeServiceToken: "runtime-commerce-secret"
  });
  const sourceDigest = `sha256:${"1".repeat(64)}`;
  const targetDigest = `sha256:${"2".repeat(64)}`;
  const checkout = await dashboard.commerce.confirmCheckout({
    buyer_id: "buyer-authority-closed",
    creator_id: "creator-authority-closed",
    agent_id: "agent-authority-closed",
    product_id: "product-authority-closed",
    corpus_digest: sourceDigest,
    release_id: sourceDigest,
    gross_minor: 0,
    currency: "USD",
    included_units: 1,
    version_policy: "track_current_compatible",
    idempotency_key: "checkout-authority-closed"
  });
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());
  const response = await fetch(
    `${serverUrl(api)}/v1/internal/commerce/entitlements/${checkout.entitlement.entitlement_id}/advance-version`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer runtime-commerce-secret",
        "content-type": "application/json",
        "idempotency-key": "advance-authority-closed"
      },
      body: JSON.stringify({
        from_digest: sourceDigest,
        to_digest: targetDigest,
        from_release_id: sourceDigest,
        to_release_id: targetDigest,
        compatibility_declaration_id: `corpus-compatibility:creator-authority-closed:agent-authority-closed:${targetDigest}`
      })
    }
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "version_authority_unavailable");
  assert.equal(
    dashboard.ledger.listEvents().filter((event) => event.event_type === "entitlement.version_advanced").length,
    0
  );
});

async function appendEvent(base, headers, key, type, payload) {
  const response = await fetch(`${base}/v1/internal/commerce/events`, {
    method: "POST",
    headers: { ...headers, "idempotency-key": key },
    body: JSON.stringify({ type, payload })
  });
  assert.equal(response.status, 201);
}

function createRegistryAuthorityFixture({ token, releases }) {
  const byIdentity = new Map(releases.map((release) => [
    `${release.creator_id}:${release.agent_id}:${release.corpus_digest}`,
    release
  ]));
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://registry.test");
    const match = url.pathname.match(
      /^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/([^/]+)\/releases\/([^/]+)$/
    );
    response.setHeader("content-type", "application/json");
    if (request.method !== "GET" || !match) {
      response.writeHead(404).end(JSON.stringify({ detail: "Route not found." }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(403).end(JSON.stringify({ detail: "Invalid deployment service token." }));
      return;
    }
    const creatorId = decodeURIComponent(match[1]);
    const agentId = decodeURIComponent(match[2]);
    const corpusDigest = decodeURIComponent(match[3]);
    const release = byIdentity.get(`${creatorId}:${agentId}:${corpusDigest}`);
    if (!release) {
      response.writeHead(404).end(JSON.stringify({ detail: "Release not found." }));
      return;
    }
    response.writeHead(200).end(JSON.stringify(release));
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
