import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { attachCreatorAvatars, createRegistryServerFromEnvironment, mergeCreatorProductListings } from "./registryServer.js";

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

test("published catalog rows use the current Creator account name and avatar", async () => {
  const rows = await attachCreatorAvatars(
    [{ creator_id: CREATOR_ID, creator_name: "Old Corpus name", product_id: PRODUCT_ID }],
    async creatorId => creatorId === CREATOR_ID ? { display_name: "Current account name", avatar_url: "https://media.example/avatar.webp" } : undefined
  );
  assert.deepEqual(rows, [{ creator_id: CREATOR_ID, creator_name: "Current account name", product_id: PRODUCT_ID, creator_avatar_url: "https://media.example/avatar.webp" }]);
});

test("published catalog rows omit products whose Creator account is missing", async () => {
  const rows = await attachCreatorAvatars(
    [
      { creator_id: CREATOR_ID, creator_name: "Old Corpus name", product_id: PRODUCT_ID },
      { creator_id: "missing-creator", creator_name: "Orphaned Corpus name", product_id: "orphaned-product" }
    ],
    async creatorId => creatorId === CREATOR_ID
      ? { display_name: "Current account name", avatar_url: null }
      : undefined
  );
  assert.deepEqual(rows, [{ creator_id: CREATOR_ID, creator_name: "Current account name", product_id: PRODUCT_ID, creator_avatar_url: null }]);
});

test("TypeScript Registry exposes auth and Corpus catalog endpoints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-ts-registry-server-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret",
    HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN: "deployment-test-token",
    HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN: "runtime-test-token",
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
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com", password: "password-123", display_name: "Test User" }) });
    assert.equal(signup.status, 201);
    assert.equal(signup.headers.get("cache-control"), "no-store");
    const auth = await signup.json() as { token: string; session: { token: string; expires_at: string }; account: Record<string, unknown> & { id: string } };
    assert.equal(Object.hasOwn(auth.account, "role"), false);
    assert.equal(auth.session.token, auth.token);
    assert.match(auth.session.expires_at, /^20/);
    const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(me.status, 200);
    assert.equal(me.headers.get("cache-control"), "no-store");
    const mePayload = await me.json() as { id: string; session_expires_at: string };
    assert.match(mePayload.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(mePayload.session_expires_at, /^20/);
    assert.equal(Object.hasOwn(mePayload, "role"), false);
    const rename = (body: unknown, token = auth.session.token) => fetch(`${base}/v1/auth/me`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const renamed = await rename({ display_name: "  New   Name " });
    assert.equal(renamed.status, 200);
    assert.deepEqual(await renamed.json(), { id: mePayload.id, email: "user@example.com", display_name: "New Name", avatar_url: null });
    assert.equal(((await (await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.session.token}` } })).json()) as { display_name: string }).display_name, "New Name");
    assert.equal((await rename({ display_name: "   " })).status, 400);
    assert.equal((await rename({ display_name: "x".repeat(129) })).status, 400);
    assert.equal((await rename({ display_name: "Intruder" }, "not-a-session")).status, 401);
    // One kind of account: any signed-in account can author in Studio.
    const ownProducts = await fetch(`${base}/v1/creator/products`, { headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(ownProducts.status, 200);
    const ownReleases = await fetch(`${base}/v1/runtime/creators/${mePayload.id}/releases`, { headers: { authorization: "Bearer runtime-test-token" } });
    assert.deepEqual(await ownReleases.json(), { releases: [] });
    assert.equal((await fetch(`${base}/v1/runtime/creators/${mePayload.id}/releases`)).status, 401);
    const creatorSignup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "creator@example.com", password: "password-123", display_name: "Account Creator Name" }) });
    assert.equal(creatorSignup.status, 201);
    const creatorAuth = await creatorSignup.json() as { account: { id: string } };
    const creatorAccounts = await fetch(`${base}/v1/internal/creator-accounts?ids=${creatorAuth.account.id}`, { headers: { authorization: "Bearer deployment-test-token" } });
    assert.equal(creatorAccounts.status, 200);
    assert.deepEqual(await creatorAccounts.json(), { accounts: [{ id: creatorAuth.account.id, display_name: "Account Creator Name" }] });
    const unauthorizedCreatorAccounts = await fetch(`${base}/v1/internal/creator-accounts?ids=${creatorAuth.account.id}`);
    assert.equal(unauthorizedCreatorAccounts.status, 401);

    const legacy = legacyAuthToken(auth.account.id, "test-secret");
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

    const minted = await fetch(`${base}/v1/auth/sessions`, { method: "POST", headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(minted.status, 201);
    const device = await minted.json() as { session: { token: string }; account: { id: string } };
    assert.notEqual(device.session.token, auth.session.token);
    assert.equal(device.account.id, auth.account.id);
    assert.equal((await fetch(`${base}/v1/auth/sessions`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/v1/auth/sessions`, { method: "POST", headers: { authorization: `Bearer ${legacy}` } })).status, 401);
    const logout = await fetch(`${base}/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.session.token}` }
    });
    assert.equal(logout.status, 204);
    const revoked = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(revoked.status, 401);
    const deviceMe = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${device.session.token}` } });
    assert.equal(deviceMe.status, 200);
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
        display_name: "Legacy User"
      })
    });
    assert.equal(signup.status, 201);
    const auth = await signup.json() as { account: { id: string } };
    const token = legacyAuthToken(auth.account.id, "migration-secret");
    const me = await fetch(`${base}/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(me.status, 200);
  } finally {
    await registry.close();
  }
});

function legacyAuthToken(sub: string, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "HATCH" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub,
    exp: Math.floor(Date.now() / 1000) + 3_600
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
