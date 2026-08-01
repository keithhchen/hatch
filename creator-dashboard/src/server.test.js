import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDashboardApp } from "../server.mjs";
import { writeProductCatalogSnapshot } from "./catalog-import.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const sourceFactoryOutput = path.join(repositoryRoot, "docs/proof/creator-factory-e2e-v1");
const releaseId = "signal-resume-review@1.0.0";
const releaseDigest = "sha256:d806cf915b29fa952e43ab4aaf02431cc39dfdde6a29b0d20509a07562eaaec5";

test("publishing sends only immutable identity and a repeated publish after restart is explicit", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-dashboard-api-"));
  const factoryOutput = path.join(directory, "factory-output");
  await cp(sourceFactoryOutput, factoryOutput, { recursive: true });
  const passingEvidence = JSON.stringify({
    release_id: releaseId,
    release_digest: releaseDigest,
    passed: true
  });
  const passingComparison = JSON.stringify({
    release_id: releaseId,
    release_digest: releaseDigest,
    passed: true,
    gate: { passed: true },
    summary: {
      creator_agent: { pass_rate: 0.9 },
      generic_baseline: { pass_rate: 0.5 },
      delta: 0.4
    }
  });
  await writeFile(path.join(factoryOutput, "review/runtime-results.json"), passingEvidence);
  await writeFile(path.join(factoryOutput, "review/comparison-results.json"), passingComparison);

  const productCatalogPath = path.join(directory, "product-catalog.json");
  await writeProductCatalogSnapshot([factoryOutput], productCatalogPath);

  let registryRequestBody;
  let registryRequestHeaders;
  let registryRequestCount = 0;
  const registry = createServer(async (request, response) => {
    registryRequestCount += 1;
    let content = "";
    for await (const chunk of request) content += chunk;
    registryRequestBody = JSON.parse(content);
    registryRequestHeaders = request.headers;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      creator_id: "maya-chen",
      product_id: "signal-resume-review",
      release_id: releaseId,
      release_digest: releaseDigest,
      version: "1.0.0",
      creator: { id: "maya-chen", name: "Maya Chen" },
      product: {},
      presentation: {},
      published_at: "2026-07-31T10:00:00Z",
      status: "published"
    }));
  });
  await listen(registry);
  context.after(() => registry.close());

  const dashboardOptions = {
    fixture: {
      profiles: [{
        email: "creator@example.test",
        password: "test-only",
        id: "maya-chen",
        role: "creator",
        display_name: "Fixture Creator",
        handle: "@fixture",
        initials: "FC"
      }]
    },
    productCatalogPath,
    ledgerPath: path.join(directory, "ledger.jsonl"),
    productStatePath: path.join(directory, "product-state.json"),
    registryUrl: serverUrl(registry),
    registryPublishServiceToken: "registry-service-test-token"
  };
  const dashboard = await createDashboardApp(dashboardOptions);
  const api = createServer(dashboard.handler);
  await listen(api);
  context.after(() => api.close());

  const login = await fetch(`${serverUrl(api)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  const { token } = await login.json();
  const publish = await fetch(`${serverUrl(api)}/v1/creator/products/signal-resume-review/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });

  assert.equal(publish.status, 200);
  assert.deepEqual(registryRequestBody, {
    release_id: releaseId,
    release_digest: releaseDigest
  });
  assert.equal(registryRequestHeaders.authorization, "Bearer registry-service-test-token");
  assert.equal(registryRequestHeaders["x-hatch-creator-id"], "maya-chen");
  assert.equal(dashboard.ledger.listEvents().length, 0);

  const overview = await fetch(`${serverUrl(api)}/v1/creator/overview`, {
    headers: { authorization: `Bearer ${token}` }
  }).then((response) => response.json());
  assert.equal(overview.products[0].status, "published");
  assert.equal(overview.metrics.orders, 0);
  assert.equal(overview.metrics.creator_share_minor, 0);

  const restartedDashboard = await createDashboardApp(dashboardOptions);
  const restartedApi = createServer(restartedDashboard.handler);
  await listen(restartedApi);
  context.after(() => restartedApi.close());
  const restartedLogin = await fetch(`${serverUrl(restartedApi)}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "creator@example.test", password: "test-only" })
  });
  const { token: restartedToken } = await restartedLogin.json();
  const duplicate = await fetch(`${serverUrl(restartedApi)}/v1/creator/products/signal-resume-review/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${restartedToken}` }
  });
  const duplicateBody = await duplicate.json();

  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicateBody, {
    error: {
      code: "already_published",
      message: "This exact product release is already published.",
      release_id: releaseId,
      release_digest: releaseDigest,
      published_at: "2026-07-31T10:00:00Z"
    }
  });
  assert.equal(registryRequestCount, 1);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function serverUrl(server) {
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}
