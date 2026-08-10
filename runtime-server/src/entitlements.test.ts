import assert from "node:assert/strict";
import test from "node:test";
import { RegistryEntitlementResolver } from "./entitlements.js";

test("Registry entitlement resolver strips registry bookkeeping fields", async () => {
  const resolver = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async () => new Response(JSON.stringify([{
      entitlement_id: "ent_demo",
      user_id: "user_demo",
      creator_id: "creator_demo",
      agent_id: "agent_demo",
      product_id: "product_demo",
      status: "active",
      granted_at: "2026-08-02T15:00:00.000Z",
    }]), { status: 200, headers: { "content-type": "application/json" } }),
  );

  const [binding] = await resolver.list({ authToken: "signed-user-token" });
  assert.deepEqual(binding, {
    entitlement_id: "ent_demo",
    user_id: "user_demo",
    creator_id: "creator_demo",
    agent_id: "agent_demo",
    product_id: "product_demo",
    status: "active",
  });
});

test("Registry identity resolver treats 401 as signed-out and returns server expiry", async () => {
  const fetchImpl = async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
    id: "user_jordan",
    role: "user",
    display_name: "Jordan Lee",
    session_expires_at: "2026-11-08T00:00:00.000Z"
  }), { status: 200 });
  const resolver = new RegistryEntitlementResolver("https://registry.example.test", fetchImpl);
  assert.deepEqual(await resolver.resolveIdentity("opaque-token"), {
    sub: "user_jordan",
    role: "user",
    exp: Math.floor(Date.parse("2026-11-08T00:00:00.000Z") / 1000)
  });

  const signedOut = new RegistryEntitlementResolver(
    "https://registry.example.test",
    async () => new Response(JSON.stringify({ detail: "expired" }), { status: 401 })
  );
  assert.equal(await signedOut.resolveIdentity("expired-token"), undefined);
});
