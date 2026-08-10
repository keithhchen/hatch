import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import type { AgentCorpusResolver } from "./agentCorpus.js";
import { createRuntimeServer } from "./index.js";

test("Runtime delegates opaque session identity to the configured Registry verifier", async () => {
  const identityResolver = {
    resolveIdentity: async (token?: string) => token === "opaque-user"
      ? { sub: "user_jordan", role: "user" as const, exp: Math.floor(Date.now() / 1000) + 3600 }
      : undefined
  };
  const entitlementResolver = {
    list: async () => [],
    resolve: async () => { throw new Error("not entitled"); }
  };
  const runtime = createRuntimeServer({ authIdentityResolver: identityResolver, entitlementResolver });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const valid = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer opaque-user" }
    });
    assert.equal(valid.status, 200);
    assert.deepEqual(await valid.json(), { creator_agents: [] });

    const invalid = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer not-a-session" }
    });
    assert.equal(invalid.status, 401);
  } finally {
    await runtime.close();
  }
});

test("Runtime rejects another user's entitlement for an introspected session", async () => {
  const entitlement = {
    entitlement_id: "ent_jordan_resume",
    order_id: "order_jordan_resume",
    user_id: "user_jordan",
    creator_id: "creator_maya",
    product_id: "product_resume",
    agent_id: "agent_resume",
    status: "active" as const
  };
  const identityResolver = {
    resolveIdentity: async (token?: string) => token === "opaque-mallory"
      ? { sub: "user_mallory", role: "user" as const, exp: Math.floor(Date.now() / 1000) + 3600 }
      : undefined
  };
  // Simulate a Registry authorization regression: both lookups return an
  // active binding, but it belongs to a different account than introspection.
  const entitlementResolver = {
    list: async () => [entitlement],
    resolve: async () => entitlement
  };
  const corpus = {
    agent_id: entitlement.agent_id,
    creator: { id: entitlement.creator_id, name: "Maya" },
    product: {
      id: entitlement.product_id,
      name: "Resume Review",
      boundaries: [],
      presentation: {}
    },
    tools: [{ id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" }]
  };
  const agentCorpusResolver = {
    resolve: async () => ({
      root: "/tmp/hatch-runtime-auth-boundary",
      corpus,
      digest: `sha256:${"0".repeat(64)}`
    })
  } as unknown as AgentCorpusResolver;
  const runtime = createRuntimeServer({ authIdentityResolver: identityResolver, entitlementResolver, agentCorpusResolver });
  await new Promise<void>((resolve) => runtime.server.listen(0, "127.0.0.1", resolve));
  const address = runtime.server.address();
  assert.ok(address && typeof address !== "string");

  let socket: WebSocket | undefined;
  try {
    const library = await fetch(`http://127.0.0.1:${address.port}/v1/me/creator-agents`, {
      headers: { authorization: "Bearer opaque-mallory" }
    });
    const libraryBody = await library.json() as { error?: { code?: string } };

    socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
    const helloResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket!.once("error", reject);
      socket!.once("message", (data) => resolve(JSON.parse(String(data)) as Record<string, unknown>));
      socket!.once("open", () => socket!.send(JSON.stringify({
        type: "client.hello",
        protocol_version: "0.5",
        installation_id: "desktop-mallory",
        auth_token: "opaque-mallory",
        entitlement_id: entitlement.entitlement_id,
        creator_id: entitlement.creator_id,
        agent_id: entitlement.agent_id,
        local_tools: []
      })));
    });

    assert.deepEqual({
      libraryStatus: library.status,
      libraryError: libraryBody.error?.code,
      helloType: helloResponse.type,
      helloError: (helloResponse.error as { code?: string } | undefined)?.code
    }, {
      libraryStatus: 403,
      libraryError: "entitlement_lookup_failed",
      helloType: "turn.failed",
      helloError: "agent_entitlement_mismatch"
    });
  } finally {
    socket?.close();
    await runtime.close();
  }
});
