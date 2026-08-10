import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createRegistryServerFromEnvironment } from "./registryServer.js";

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
    assert.deepEqual(await health.json(), { status: "ok" });
    const signup = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "user@example.com", password: "password-123", role: "user", display_name: "Test User" }) });
    assert.equal(signup.status, 201);
    const auth = await signup.json() as { token: string; session: { token: string; expires_at: string }; account: { id: string; role: string } };
    assert.equal(auth.account.role, "user");
    assert.equal(auth.session.token, auth.token);
    assert.match(auth.session.expires_at, /^20/);
    const me = await fetch(`${base}/v1/auth/me`, { headers: { authorization: `Bearer ${auth.session.token}` } });
    assert.equal(me.status, 200);
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
