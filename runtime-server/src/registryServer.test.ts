import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRegistryServerFromEnvironment, mergeCreatorProductListings } from "./registryServer.js";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";

test("Creator product listing keeps authoring fields when a published corpus has the same Product id", () => {
  const products = mergeCreatorProductListings(
    [{
      product_id: PRODUCT_ID,
      agent_id: PRODUCT_ID,
      product_name: "Published name",
      product_promise: "Published promise",
      product_description: "Published description",
      status: "published",
      corpus_digest: "sha256:published",
      published_at: "2026-08-16T00:00:00.000Z",
      brief_spec: { audience: "published" }
    }],
    [{
      id: PRODUCT_ID,
      creatorId: CREATOR_ID,
      name: "Current name",
      promise: "Current promise",
      brief: "Current promise",
      briefSpec: { contract_version: "1", fields: [{ id: "goal", label: "Goal", required: true }] },
      status: "active",
      createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-16T01:00:00.000Z"
    }],
    CREATOR_ID
  );
  assert.equal(products.length, 1);
  assert.deepEqual(products[0], {
    product_id: PRODUCT_ID,
    creator_id: CREATOR_ID,
    name: "Current name",
    promise: "Current promise",
    description: "Current promise",
    status: "published",
    corpus_digest: "sha256:published",
    published_at: "2026-08-16T00:00:00.000Z",
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-16T01:00:00.000Z",
    brief_spec: { contract_version: "1", fields: [{ id: "goal", label: "Goal", required: true }] }
  });
});

test("TypeScript Registry exposes auth and Corpus catalog endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-server-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret",
    HATCH_QDRANT_URL: "",
    DASHSCOPE_API_KEY: ""
  });
  try {
    const address = registry.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${base}/health`);
    assert.deepEqual(await health.json(), {
      status: "ok",
      checks: { registry_store: "ready", release_store: "memory" }
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
    assert.match(mePayload.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(mePayload.session_expires_at, /^20/);

    const legacy = legacyAuthToken(auth.account.id, "user", "test-secret");
    const rejectedLegacy = await fetch(`${base}/v1/auth/me`, {
      headers: { authorization: `Bearer ${legacy}` }
    });
    assert.equal(rejectedLegacy.status, 401);

    const access = await fetch(`${base}/v1/user/product-access`, {
      headers: { authorization: `Bearer ${auth.session.token}` }
    });
    assert.equal(access.status, 404);

    const selfGrant = await fetch(`${base}/v1/user/products/${PRODUCT_ID}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ order_id: "order_forged" })
    });
    assert.equal(selfGrant.status, 404);

    const userTokenOnCommerceRoute = await fetch(`${base}/v1/commerce/product-access`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.id, creator_id: CREATOR_ID, product_id: PRODUCT_ID, order_id: "order_forged" })
    });
    assert.equal(userTokenOnCommerceRoute.status, 404);

    const missingOrder = await fetch(`${base}/v1/commerce/product-access`, {
      method: "POST",
      headers: { authorization: "Bearer commerce-test-token", "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.id, creator_id: CREATOR_ID, product_id: PRODUCT_ID })
    });
    assert.equal(missingOrder.status, 404);

    const commerceOnly = await fetch(`${base}/v1/commerce/product-access`, {
      method: "POST",
      headers: { authorization: "Bearer commerce-test-token", "content-type": "application/json" },
      body: JSON.stringify({ user_id: auth.account.id, creator_id: CREATOR_ID, product_id: PRODUCT_ID, order_id: "55555555-5555-4555-8555-555555555555" })
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
