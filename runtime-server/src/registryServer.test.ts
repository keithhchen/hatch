import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { test } from "node:test";
import { InMemoryCreatorFactoryRepository, PostgresCreatorFactoryRepository } from "./creatorLearning/repository.js";
import { createRegistryServerFromEnvironment, creatorFactoryRepositoryForRegistry } from "./registryServer.js";

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function corpusBundle(creatorId: string, productName = "Agent Demo", backwardCompatibleWith?: string): Uint8Array {
  const system = "Use the creator method.\n";
  const synthetic = "[]\n";
  const heldOut = "[]\n";
  const asset = (id: string, assetPath: string, content: string) => ({
    id,
    path: assetPath,
    sha256: digest(content)
  });
  return zipSync({
    "agent.json": strToU8(JSON.stringify({
      contract_version: "1",
      agent_id: "agent-demo",
      creator: { id: creatorId, name: "Test Creator" },
      ...(backwardCompatibleWith ? { release: { backward_compatible_with: backwardCompatibleWith } } : {}),
      product: { id: "agent-demo", name: productName, boundaries: [], presentation: {} },
      instructions: { system: asset("system", "instructions/system.md", system) },
      skills: [],
      knowledge: { documents: [] },
      tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }],
      evaluations: {
        synthetic_qa: [asset("synthetic", "evals/synthetic.json", synthetic)],
        held_out: [asset("held-out", "evals/held-out.json", heldOut)]
      }
    })),
    "instructions/system.md": strToU8(system),
    "evals/synthetic.json": strToU8(synthetic),
    "evals/held-out.json": strToU8(heldOut)
  });
}

test("Registry uses the dedicated Factory database URL instead of its Registry pool", async () => {
  const registryPool = { query: async () => ({ rows: [] }) } as never;
  const dedicated = creatorFactoryRepositoryForRegistry({
    HATCH_FACTORY_DATABASE_URL: "postgresql://factory-owner:secret@127.0.0.1:5432/hatch"
  }, registryPool);
  assert.ok(dedicated instanceof PostgresCreatorFactoryRepository);
  assert.notEqual(dedicated.pool, registryPool);
  await dedicated.close();

  const legacyShared = creatorFactoryRepositoryForRegistry({}, registryPool);
  assert.ok(legacyShared instanceof PostgresCreatorFactoryRepository);
  assert.equal(legacyShared.pool, registryPool);
  await legacyShared.close();

  const local = creatorFactoryRepositoryForRegistry({});
  assert.ok(local instanceof InMemoryCreatorFactoryRepository);
  await local.close();
});

test("TypeScript Registry exposes auth and Corpus catalog endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-server-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_REGISTRY_COMMERCE_SERVICE_TOKEN: "commerce-test-token",
    HATCH_AUTH_SIGNING_SECRET: "test-secret",
    HATCH_REGISTRY_ACCESS_SERVICE_TOKEN: "test-access-service",
    HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN: "test-deployment-service",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/healthz`);
    assert.deepEqual(await health.json(), { status: "ok" });
    const readiness = await fetch(`${base}/readyz`);
    assert.deepEqual(await readiness.json(), {
      status: "ok",
      checks: { registry_store: "ready", service_credentials: "ready" }
    });
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com", password: "password-123", role: "user", display_name: "Test User" }) });
    assert.equal(signup.status, 201);
    assert.equal(signup.headers.get("cache-control"), "no-store");
    const auth = await signup.json() as { token: string; session: { token: string; expires_at: string }; account: { id: string; role: string } };
    assert.equal(auth.account.role, "user");
    assert.equal(auth.session.token, auth.token);
    assert.match(auth.session.expires_at, /^20/);
    const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("cache-control"), "no-store");
    const mePayload = await me.json() as { id: string; session_expires_at: string };
    assert.match(mePayload.id, /test-user/);
    assert.match(mePayload.session_expires_at, /^20/);

    const legacy = legacyAuthToken(auth.account.id, "user", "test-secret");
    const rejectedLegacy = await fetch(`${base}/v1/auth/me`, {
      headers: { authorization: `Bearer ${legacy}` }
    });
    assert.equal(rejectedLegacy.status, 401);

    const access = await fetch(`${base}/v1/user/agent-access`, {
      headers: { authorization: `Bearer ${auth.session.token}` }
    });
    assert.equal(access.status, 200);
    assert.deepEqual(await access.json(), []);

    const selfGrant = await fetch(`${base}/v1/user/agents/maya/signal/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ order_id: "order_forged" })
    });
    assert.equal(selfGrant.status, 404);

    const userTokenOnCommerceRoute = await fetch(`${base}/v1/commerce/agent-access`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.id, creator_id: "maya", agent_id: "signal", order_id: "order_forged" })
    });
    assert.equal(userTokenOnCommerceRoute.status, 401);

    const missingOrder = await fetch(`${base}/v1/commerce/agent-access`, {
      method: "POST",
      headers: { authorization: "Bearer commerce-test-token", "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.id, creator_id: "maya", agent_id: "signal" })
    });
    assert.equal(missingOrder.status, 400);

    const commerceOnly = await fetch(`${base}/v1/commerce/agent-access`, {
      method: "POST",
      headers: { authorization: "Bearer commerce-test-token", "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.id, creator_id: "maya", agent_id: "signal", order_id: "order_real" })
    });
    assert.equal(commerceOnly.status, 404);

    const oversizedPassword = await fetch(`${base}/v1/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", password: "x".repeat(1025) })
    });
    assert.equal(oversizedPassword.status, 400);
    assert.equal(oversizedPassword.headers.get("cache-control"), "no-store");

    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.session.token}` }
    });
    assert.equal(logout.status, 204);
    const revoked = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(revoked.status, 401);
  } finally {
    await registry.close();
  }
});

test("TypeScript Registry enables legacy HMAC only for explicit migration mode", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-legacy-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_ENABLE_LEGACY_HMAC_AUTH: "true",
    HATCH_AUTH_SIGNING_SECRET: "migration-secret",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${base}/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "legacy@example.com",
        password: "password-123",
        role: "user",
        display_name: "Legacy User"
      })
    });
    assert.equal(signup.status, 201);
    const auth = await signup.json() as { account: { id: string } };
    const token = legacyAuthToken(auth.account.id, "user", "migration-secret");
    const me = await fetch(`${base}/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(me.status, 200);
    const directGrant = await fetch(`${base}/v1/user/agents/creator-demo/agent-demo/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_id: "ignored", order_id: "order-forged", entitlement_id: "entitlement-forged" })
    });
    assert.equal(directGrant.status, 403);
    const unboundServiceGrant = await fetch(`${base}/v1/user/agents/creator-demo/agent-demo/access`, {
      method: "POST",
      headers: { authorization: "Bearer test-access-service", "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.role })
    });
    assert.equal(unboundServiceGrant.status, 400);
    const userActivation = await fetch(`${base}/v1/creator/agent-corpora/agent-demo/releases/sha256:${"a".repeat(64)}/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}` }
    });
    assert.equal(userActivation.status, 401);
    const creatorSignup = await fetch(`${base}/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "creator@example.com", password: "password-123", role: "creator", display_name: "Test Creator" })
    });
    assert.equal(creatorSignup.status, 201);
    const creatorAuth = await creatorSignup.json() as { token: string; account: { id: string } };
    const publishWithoutReviewedDigest = await fetch(`${base}/v1/creator/factory-runs/factory-missing/publish`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(publishWithoutReviewedDigest.status, 400);
    assert.deepEqual(await publishWithoutReviewedDigest.json(), {
      detail: "A valid corpus_digest for the reviewed Factory candidate is required."
    });
    const publish = await fetch(`${base}/v1/creator/agent-corpora?agent_id=agent-demo`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}`, "content-type": "application/zip" },
      body: Buffer.from(corpusBundle(creatorAuth.account.id))
    });
    assert.equal(publish.status, 201);
    const published = await publish.json() as { corpus_digest: string };
    const publishSecond = await fetch(`${base}/v1/creator/agent-corpora?agent_id=agent-demo`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}`, "content-type": "application/zip" },
      body: Buffer.from(corpusBundle(creatorAuth.account.id, "Agent Demo V2", published.corpus_digest))
    });
    assert.equal(publishSecond.status, 201);
    const publishedSecond = await publishSecond.json() as { corpus_digest: string };
    assert.notEqual(publishedSecond.corpus_digest, published.corpus_digest);

    const exactReleaseUrl = `${base}/v1/internal/deployments/agent-corpora/${creatorAuth.account.id}/agent-demo/releases/${publishedSecond.corpus_digest}`;
    const creatorCannotReadExactRelease = await fetch(exactReleaseUrl, {
      headers: { authorization: `Bearer ${creatorAuth.token}` }
    });
    assert.equal(creatorCannotReadExactRelease.status, 403);
    const exactRelease = await fetch(exactReleaseUrl, {
      headers: { authorization: "Bearer test-deployment-service" }
    });
    assert.equal(exactRelease.status, 200);
    const exactPublished = await exactRelease.json() as Record<string, unknown>;
    assert.equal(exactPublished.creator_id, creatorAuth.account.id);
    assert.equal(exactPublished.agent_id, "agent-demo");
    assert.equal(exactPublished.product_id, "agent-demo");
    assert.equal(exactPublished.corpus_digest, publishedSecond.corpus_digest);
    assert.equal(exactPublished.backward_compatible_with, published.corpus_digest);
    const wrongCreatorExactRelease = await fetch(
      `${base}/v1/internal/deployments/agent-corpora/another-creator/agent-demo/releases/${publishedSecond.corpus_digest}`,
      { headers: { authorization: "Bearer test-deployment-service" } }
    );
    assert.equal(wrongCreatorExactRelease.status, 404);
    const missingExactRelease = await fetch(
      `${base}/v1/internal/deployments/agent-corpora/${creatorAuth.account.id}/agent-demo/releases/sha256:${"f".repeat(64)}`,
      { headers: { authorization: "Bearer test-deployment-service" } }
    );
    assert.equal(missingExactRelease.status, 404);
    const currentAfterExactRead = await fetch(`${base}/v1/agent-corpora/${creatorAuth.account.id}/agent-demo`);
    assert.equal((await currentAfterExactRead.json() as { corpus_digest: string }).corpus_digest, publishedSecond.corpus_digest);

    const creatorCannotUseInternalStage = await fetch(`${base}/v1/internal/deployments/factory-runs/factory-missing/stage`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        creator_id: creatorAuth.account.id,
        operation_id: "deploy-stage-forbidden",
        corpus_digest: published.corpus_digest
      })
    });
    assert.equal(creatorCannotUseInternalStage.status, 403);
    const missingFactoryStage = await fetch(`${base}/v1/internal/deployments/factory-runs/factory-missing/stage`, {
      method: "POST",
      headers: { authorization: "Bearer test-deployment-service", "content-type": "application/json" },
      body: JSON.stringify({
        creator_id: creatorAuth.account.id,
        operation_id: "deploy-stage-missing",
        corpus_digest: published.corpus_digest
      })
    });
    assert.equal(missingFactoryStage.status, 404);
    assert.deepEqual(await missingFactoryStage.json(), { detail: "Factory run not found." });

    const creatorCannotUseInternalActivate = await fetch(
      `${base}/v1/internal/deployments/agent-corpora/agent-demo/releases/${published.corpus_digest}/activate`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${creatorAuth.token}`, "content-type": "application/json" },
        body: JSON.stringify({
          creator_id: creatorAuth.account.id,
          operation_id: "deploy-activate-forbidden",
          expected_current_digest: publishedSecond.corpus_digest
        })
      }
    );
    assert.equal(creatorCannotUseInternalActivate.status, 403);

    const missingExpectedDigest = await fetch(
      `${base}/v1/internal/deployments/agent-corpora/agent-demo/releases/${published.corpus_digest}/activate`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-deployment-service", "content-type": "application/json" },
        body: JSON.stringify({ creator_id: creatorAuth.account.id, operation_id: "deploy-missing-cas" })
      }
    );
    assert.equal(missingExpectedDigest.status, 400);

    const internalActivationUrl = `${base}/v1/internal/deployments/agent-corpora/agent-demo/releases/${published.corpus_digest}/activate`;
    const internalActivation = await fetch(internalActivationUrl, {
      method: "POST",
      headers: { authorization: "Bearer test-deployment-service", "content-type": "application/json" },
      body: JSON.stringify({
        creator_id: creatorAuth.account.id,
        operation_id: "deploy-rollback-v1",
        expected_current_digest: publishedSecond.corpus_digest
      })
    });
    assert.equal(internalActivation.status, 200);
    const internalActivated = await internalActivation.json() as {
      operation_id: string;
      current: boolean;
      agent_corpus: { corpus_digest: string };
    };
    assert.equal(internalActivated.operation_id, "deploy-rollback-v1");
    assert.equal(internalActivated.current, true);
    assert.equal(internalActivated.agent_corpus.corpus_digest, published.corpus_digest);

    const staleActivation = await fetch(
      `${base}/v1/internal/deployments/agent-corpora/agent-demo/releases/${publishedSecond.corpus_digest}/activate`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-deployment-service", "content-type": "application/json" },
        body: JSON.stringify({
          creator_id: creatorAuth.account.id,
          operation_id: "deploy-stale-v2",
          expected_current_digest: null
        })
      }
    );
    assert.equal(staleActivation.status, 409);
    assert.deepEqual(await staleActivation.json(), {
      detail: "The current Agent Corpus changed before activation.",
      code: "stale_current_digest",
      expected_current_digest: null,
      current_corpus_digest: published.corpus_digest,
      target_corpus_digest: publishedSecond.corpus_digest
    });

    const replayedInternalActivation = await fetch(internalActivationUrl, {
      method: "POST",
      headers: { authorization: "Bearer test-deployment-service", "content-type": "application/json" },
      body: JSON.stringify({
        creator_id: creatorAuth.account.id,
        operation_id: "deploy-rollback-v1",
        expected_current_digest: publishedSecond.corpus_digest
      })
    });
    assert.equal(replayedInternalActivation.status, 200);
    assert.deepEqual(await replayedInternalActivation.json(), internalActivated);
    const trackedGrant = await fetch(`${base}/v1/user/agents/${creatorAuth.account.id}/agent-demo/access`, {
      method: "POST",
      headers: { authorization: "Bearer test-access-service", "content-type": "application/json" },
      body: JSON.stringify({
        user_id: auth.account.id,
        order_id: "order-compatible",
        entitlement_id: "entitlement-compatible",
        purchased_corpus_digest: published.corpus_digest,
        version_policy: "track_current_compatible"
      })
    });
    assert.equal(trackedGrant.status, 201);
    const tracked = await trackedGrant.json() as Record<string, unknown>;
    assert.equal(tracked.version_policy, "track_current_compatible");
    assert.equal(tracked.purchased_corpus_digest, published.corpus_digest);
    assert.equal(tracked.effective_corpus_digest, published.corpus_digest);
    assert.deepEqual(tracked.version_history, []);
    const access = await fetch(`${base}/v1/user/agent-access`, {
      headers: { authorization: `Bearer ${auth.token}` }
    });
    assert.equal(access.status, 200);
    const accessList = await access.json() as Array<Record<string, unknown>>;
    assert.equal(accessList[0]?.version_policy, "track_current_compatible");
    const activationUrl = `${base}/v1/creator/agent-corpora/agent-demo/releases/${published.corpus_digest}/activate`;
    const activation = await fetch(activationUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}` }
    });
    assert.equal(activation.status, 200);
    const activated = await activation.json() as { current: boolean; agent_corpus: { corpus_digest: string } };
    assert.equal(activated.current, true);
    assert.equal(activated.agent_corpus.corpus_digest, published.corpus_digest);
    const repeatedActivation = await fetch(activationUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}` }
    });
    assert.equal(repeatedActivation.status, 200);
    assert.deepEqual(await repeatedActivation.json(), activated);
    const missingActivation = await fetch(`${base}/v1/creator/agent-corpora/agent-demo/releases/sha256:${"a".repeat(64)}/activate`, {
      method: "POST",
      headers: { authorization: `Bearer ${creatorAuth.token}` }
    });
    assert.equal(missingActivation.status, 404);
    assert.deepEqual(await missingActivation.json(), { detail: "The requested Agent Corpus release is not materialized." });
  } finally {
    await registry.close();
  }
});

test("TypeScript Registry does not listen before its durable store is ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-not-ready-"));
  const statePath = path.join(root, "state.json");
  await writeFile(statePath, "{not-json", "utf8");
  await assert.rejects(
    createRegistryServerFromEnvironment({
      REGISTRY_HOST: "127.0.0.1",
      REGISTRY_PORT: "0",
      HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
      HATCH_REGISTRY_STATE_PATH: statePath,
      HATCH_AUTH_SIGNING_SECRET: "test-secret",
      HATCH_QDRANT_URL: "",
      DASHSCOPE_API_KEY: ""
    })
  );
});

test("production Registry readiness fails closed when service credentials are incomplete", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-credentials-"));
  const registry = await createRegistryServerFromEnvironment({
    NODE_ENV: "production",
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "configured-auth-secret",
    HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN: "configured-publish-token",
    HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: "configured-runtime-token",
    HATCH_REGISTRY_ACCESS_SERVICE_TOKEN: "configured-access-token",
    // Deliberately omit HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN. Deployment
    // stage/activate routes are privileged separately from every legacy token.
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const readiness = await fetch(`${base}/readyz`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), {
      status: "unavailable",
      checks: { registry_store: "ready", service_credentials: "failed" }
    });
  } finally {
    await registry.close();
  }
});

test("Registry bounds public opaque-session lookups before they reach account storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-session-limit-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: "",
    HATCH_AUTH_SESSION_RATE_LIMIT_WINDOW_MS: "60000",
    HATCH_AUTH_SESSION_RATE_LIMIT_MAX_ATTEMPTS: "2",
    HATCH_AUTH_SESSION_RATE_LIMIT_MAX_SOURCES: "100",
    HATCH_AUTH_SESSION_MAX_CONCURRENT: "1",
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const query = () => fetch(`${base}/v1/auth/me`, {
      headers: { authorization: "Bearer random-opaque-token" },
    });
    assert.equal((await query()).status, 401);
    assert.equal((await query()).status, 401);
    const limited = await query();
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
    assert.deepEqual(await limited.json(), { detail: "Too many session checks. Try again later." });
  } finally {
    await registry.close();
  }
});

test("Registry rate limits successful and failed auth attempts without exposing account existence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-rate-limit-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: "",
    HATCH_AUTH_RATE_LIMIT_WINDOW_MS: "60000",
    HATCH_AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS: "3",
    HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES: "100",
    HATCH_AUTH_RATE_LIMIT_MAX_ENTRIES: "100"
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const authRequest = (route: "signup" | "signin", email: string, password: string) => fetch(
      `${base}/v1/auth/${route}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(route === "signup"
          ? { email, password, role: "user", display_name: "Rate Limit User" }
          : { email, password })
      }
    );

    assert.equal((await authRequest("signup", "Rate.User@Example.COM", "password-123")).status, 201);
    assert.equal((await authRequest("signin", "rate.user@example.com", "wrong-password")).status, 401);
    assert.equal((await authRequest("signin", " RATE.USER@example.com ", "password-123")).status, 200);

    const knownAccount = await authRequest("signin", "rate.user@example.com", "wrong-password");
    const unknownAccount = await authRequest("signin", "unknown@example.com", "wrong-password");
    assert.equal(knownAccount.status, 429);
    assert.equal(unknownAccount.status, 429);
    assert.match(knownAccount.headers.get("retry-after") ?? "", /^\d+$/);
    assert.deepEqual(await knownAccount.json(), {
      detail: "Too many authentication attempts. Try again later."
    });
    assert.deepEqual(await unknownAccount.json(), {
      detail: "Too many authentication attempts. Try again later."
    });
  } finally {
    await registry.close();
  }
});

test("duplicate signup cannot lock signin and correct credentials clear a signin failure lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-identity-lock-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: "",
    HATCH_AUTH_RATE_LIMIT_WINDOW_MS: "60000",
    HATCH_AUTH_RATE_LIMIT_IP_MAX_ATTEMPTS: "100",
    HATCH_AUTH_RATE_LIMIT_IDENTITY_MAX_FAILURES: "2",
    HATCH_AUTH_RATE_LIMIT_MAX_ENTRIES: "100"
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const signup = (email: string, password = "password-123") => fetch(`${base}/v1/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, role: "user", display_name: "Lock Test" })
    });
    const signin = (email: string, password: string) => fetch(`${base}/v1/auth/signin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    assert.equal((await signup("Target@Example.COM")).status, 201);
    assert.equal((await signup("target@example.com")).status, 409);
    assert.equal((await signup(" TARGET@example.com ")).status, 409);
    assert.equal((await signup("target@example.com")).status, 429);

    // Signup and signin failure budgets are independent.
    assert.equal((await signin("target@example.com", "password-123")).status, 200);
    assert.equal((await signin("target@example.com", "wrong-password")).status, 401);
    assert.equal((await signin(" TARGET@example.com ", "wrong-password")).status, 401);
    assert.equal((await signin("target@example.com", "wrong-password")).status, 429);

    // The locked identity is still verified; a correct password clears only
    // the signin failure bucket while the source-IP hard budget remains.
    assert.equal((await signin("target@example.com", "password-123")).status, 200);
    assert.equal((await signin("target@example.com", "wrong-password")).status, 401);

    // Signup also evaluates a potentially successful request while its
    // failure bucket is locked, so corrected input can recover immediately.
    assert.equal((await signup("recover@example.com", "short")).status, 400);
    assert.equal((await signup(" RECOVER@example.com ", "short")).status, 400);
    assert.equal((await signup("recover@example.com", "password-123")).status, 201);
  } finally {
    await registry.close();
  }
});

function legacyAuthToken(sub: string, role: "user" | "creator", secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "HATCH" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub,
    role,
    exp: Math.floor(Date.now() / 1000) + 3_600
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
