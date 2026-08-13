import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  EntitlementError,
  FileEntitlementResolver,
  RegistryEntitlementResolver,
  registryAuthorizationTimeoutMs
} from "./entitlements.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CREATOR_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
const ENTITLEMENT_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "55555555-5555-4555-8555-555555555555";

test("file entitlement fixtures require explicit legacy HMAC opt-in and secret", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-file-entitlements-"));
  const fixture = path.join(root, "entitlements.json");
  await writeFile(fixture, JSON.stringify([{
    entitlement_id: "ent_fixture",
    order_id: "order_fixture",
    user_id: "user_fixture",
    creator_id: "creator_fixture",
    agent_id: "agent_fixture",
    product_id: "product_fixture",
    status: "active",
    license_token: "fixture-license"
  }]), "utf8");
  const secret = "fixture-secret";
  const resolver = new FileEntitlementResolver(fixture, {
    enableLegacyHmacAuth: true,
    hmacSecret: secret
  });
  assert.equal((await resolver.list({ authToken: legacyToken(secret, "user_fixture") }))[0]?.entitlement_id, "ent_fixture");
  assert.deepEqual(await resolver.list({ authToken: legacyToken("wrong-secret", "user_fixture") }), []);
  assert.throws(
    () => new FileEntitlementResolver(fixture, { enableLegacyHmacAuth: true, hmacSecret: "" }),
    /signing secret/
  );
});

test("Registry entitlement resolver strips registry bookkeeping fields", async () => {
  const resolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async () => new Response(JSON.stringify([{
      entitlement_id: ENTITLEMENT_ID,
      order_id: ORDER_ID,
      user_id: USER_ID,
      creator_id: CREATOR_ID,
      agent_id: PRODUCT_ID,
      product_id: PRODUCT_ID,
      status: "active",
      granted_at: "2026-08-02T15:00:00.000Z",
    }]), { status: 200, headers: { "content-type": "application/json" } }),
  );

  const [binding] = await resolver.list({ authToken: "signed-user-token" });
  assert.deepEqual(binding, {
    entitlement_id: ENTITLEMENT_ID,
    order_id: ORDER_ID,
    user_id: USER_ID,
    creator_id: CREATOR_ID,
    agent_id: PRODUCT_ID,
    product_id: PRODUCT_ID,
    status: "active",
  });
});

test("Registry entitlement resolution requests only the selected binding", async () => {
  let requestedUrl = "";
  const resolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify([{
        entitlement_id: ENTITLEMENT_ID,
        user_id: USER_ID,
        creator_id: CREATOR_ID,
        agent_id: PRODUCT_ID,
        product_id: PRODUCT_ID,
        status: "active",
      }]), { status: 200 });
    },
  );
  assert.equal((await resolver.resolve({
    authToken: "opaque-token",
    entitlementId: ENTITLEMENT_ID,
  })).entitlement_id, ENTITLEMENT_ID);
  assert.equal(new URL(requestedUrl).searchParams.get("entitlement_id"), ENTITLEMENT_ID);
});

test("Registry entitlement resolver rejects pre-cutover text identities and split product aliases", async () => {
  const resolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async () => new Response(JSON.stringify([{
      entitlement_id: "ent_old",
      user_id: USER_ID,
      creator_id: CREATOR_ID,
      agent_id: PRODUCT_ID,
      product_id: "product_old",
      status: "active"
    }]), { status: 200 })
  );
  await assert.rejects(resolver.list({ authToken: "signed-user-token" }), /Invalid uuid|invalid/i);
});

test("Registry authorization rejects oversized bodies before buffering them", async () => {
  const resolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(64 * 1024 + 1) },
    }),
  );
  await assert.rejects(
    resolver.resolveIdentity("opaque-token"),
    (error) => error instanceof EntitlementError && error.code === "auth_registry_unavailable",
  );
});

test("Registry identity resolver treats 401 as signed-out and returns server expiry", async () => {
  let serviceHeader: string | null = null;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    serviceHeader = new Headers(init?.headers).get("x-hatch-runtime-service-token");
    return new Response(JSON.stringify({
    id: USER_ID,
    role: "user",
    display_name: "Jordan Lee",
    session_expires_at: "2026-11-08T00:00:00.000Z"
    }), { status: 200 });
  };
  const resolver = new RegistryEntitlementResolver("https://registry.example.test", fetchImpl, {
    serviceToken: "runtime-service-token",
  });
  assert.deepEqual(await resolver.resolveIdentity("opaque-token"), {
    sub: USER_ID,
    role: "user",
    exp: Math.floor(Date.parse("2026-11-08T00:00:00.000Z") / 1000)
  });
  assert.equal(serviceHeader, "runtime-service-token");

  const signedOut = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async () => new Response(JSON.stringify({ detail: "expired" }), { status: 401 })
  );
  assert.equal(await signedOut.resolveIdentity("expired-token"), undefined);
});

test("Registry identity and entitlement requests time out with explicit unavailable errors", async () => {
  const abortableFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const resolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    abortableFetch,
    { timeoutMs: 20 }
  );

  await assert.rejects(
    resolver.resolveIdentity("opaque-token"),
    (error) => error instanceof EntitlementError && error.code === "auth_registry_unavailable"
  );
  await assert.rejects(
    resolver.list({ authToken: "opaque-token" }),
    (error) => error instanceof EntitlementError && error.code === "entitlement_registry_unavailable"
  );
});

test("Registry authorization requests propagate caller cancellation", async () => {
  let requestSignal: AbortSignal | null | undefined;
  const abortableFetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requestSignal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    });
  };
  const resolver = new RegistryEntitlementResolver("https://registry.example.test", abortableFetch);
  const controller = new AbortController();
  const pending = resolver.resolveIdentity("opaque-token", { signal: controller.signal });
  controller.abort(new Error("socket closed"));

  await assert.rejects(
    pending,
    (error) => error instanceof EntitlementError && error.code === "authorization_cancelled"
  );
  assert.equal(requestSignal?.aborted, true);
  assert.equal(registryAuthorizationTimeoutMs({ HATCH_REGISTRY_AUTH_TIMEOUT_MS: "250" }), 250);
  assert.throws(
    () => registryAuthorizationTimeoutMs({ HATCH_REGISTRY_AUTH_TIMEOUT_MS: "50" }),
    /HATCH_REGISTRY_AUTH_TIMEOUT_MS/
  );
});

function legacyToken(secret: string, subject: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: subject,
    role: "user",
    exp: Math.floor(Date.now() / 1000) + 3600
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
