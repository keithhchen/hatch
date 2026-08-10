import assert from "node:assert/strict";
import test from "node:test";
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
