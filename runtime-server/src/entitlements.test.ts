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
