import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { AgentCorpus, AgentCorpusResolver } from "../agentCorpus.js";
import { RegistryEntitlementResolver } from "../entitlements.js";
import { createRuntimeServer } from "../index.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { createRegistryServerFromEnvironment } from "../registryServer.js";
import { RuntimeStore } from "../store.js";

const productId = "33333333-3333-4333-8333-333333333333";
const origin = "https://app.hatch.test";

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

const upgrade = (url: string, headers: Record<string, string> = {}) => new Promise<number>((resolve) => {
  const socket = new WebSocket(url, { headers });
  socket.once("open", () => { socket.close(); resolve(101); });
  socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  socket.once("error", () => undefined);
});

test("a browser session and an API key both authenticate HTTP and WebSocket against the real Registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-chat-auth-"));
  const registry = await createRegistryServerFromEnvironment({
    REGISTRY_HOST: "127.0.0.1", REGISTRY_PORT: "0",
    HATCH_AGENT_CORPUS_ROOT: path.join(root, "corpora"),
    HATCH_REGISTRY_STATE_PATH: path.join(root, "state.json"),
    HATCH_AUTH_SIGNING_SECRET: "test-secret", HATCH_QDRANT_URL: "", DASHSCOPE_API_KEY: ""
  });
  const registryBase = `http://127.0.0.1:${(registry.server.address() as { port: number }).port}`;
  let runtime: Awaited<ReturnType<typeof createRuntimeServer>> | undefined;
  try {
    const post = (route: string, token: string | undefined, body?: unknown) => fetch(`${registryBase}${route}`, {
      method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const signup = await (await post("/v1/auth/signup", undefined, { email: "chat@example.com", password: "password123", display_name: "Chat" })).json() as { session: { token: string }; account: { id: string } };
    const browserToken = signup.session.token;
    const key = await (await post("/v1/auth/api-keys", browserToken, { name: "chat" })).json() as { id: string; token: string };
    const accountId = signup.account?.id ?? (await (await fetch(`${registryBase}/v1/auth/me`, { headers: { authorization: `Bearer ${browserToken}` } })).json() as { id: string }).id;

    // The Registry identifies an API key exactly as it identifies a browser session.
    const identities = new RegistryEntitlementResolver(registryBase);
    assert.equal((await identities.resolveIdentity(key.token))?.sub, accountId);
    assert.equal((await identities.resolveIdentity(browserToken))?.sub, accountId);
    assert.equal(await identities.resolveIdentity("hk_not_a_key"), undefined);

    const resolved = () => ({
      root: "", digest: `sha256:${"b".repeat(64)}`,
      corpus: { agent_id: productId, creator: { id: accountId, name: "Owner" }, product: { id: productId, name: "P", boundaries: [], presentation: {} }, knowledge: { documents: [] }, tools: [] } as unknown as AgentCorpus
    });
    const agentCorpusResolver = {
      resolve: async () => resolved(),
      resolveByProduct: async () => resolved(),
      list: async () => []
    } as unknown as AgentCorpusResolver;
    runtime = createRuntimeServer({
      conversationStore: new RuntimeStore(path.join(root, "runtime")),
      entitlementResolver: identities, authIdentityResolver: identities, agentCorpusResolver,
      allowedOrigins: [origin],
      createRuntime: () => ({ async *run(input) {
        yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "hello owner" } };
        yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
      } })
    });
    const base = await listen(runtime.server);
    const query = `product_id=${productId}`;
    const call = (route: string, token: string, body: unknown) => fetch(`${base}${route}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body)
    });

    for (const [label, token] of [["browser session", browserToken], ["API key", key.token]] as const) {
      const created = await call(`/v1/conversations?${query}`, token, { client_request_id: `auth-${label}` });
      assert.equal(created.status, 201, label);
      const conversation = (await created.json() as { conversation: { id: string } }).conversation.id;
      const answered = await call(`/v1/conversations/${conversation}/messages?${query}&wait=5`, token, { client_message_id: `m-${label}`, content: "hi" });
      assert.equal(answered.status, 200, label);
      assert.equal((await answered.json() as { reply: string }).reply, "hello owner", label);

      // The same token opens the WebSocket: the key goes in the first message, never the URL.
      const socket = new WebSocket(`${base.replace("http", "ws")}/runtime`);
      const ready = new Promise<string>((resolve, reject) => {
        socket.on("message", (data) => { const message = JSON.parse(String(data)); if (message.type === "session.ready" || message.type === "turn.failed") resolve(message.type); });
        socket.once("error", reject);
      });
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
      socket.send(JSON.stringify({ type: "client.hello", protocol_version: PROTOCOL_VERSION, conversation_id: conversation, product_id: productId, auth_token: token, local_tools: [], client: "cli" }));
      assert.equal(await ready, "session.ready", label);
      socket.close();
    }

    assert.equal((await call(`/v1/conversations?${query}`, "hk_not_a_key", {})).status, 403);

    // WebSocket upgrade: a cookie needs an allowed Origin, and no credential may be in the URL.
    const wsUrl = `${base.replace("http", "ws")}/runtime`;
    assert.equal(await upgrade(wsUrl), 101);
    assert.equal(await upgrade(wsUrl, { cookie: "hatch_session=abc", origin }), 101);
    assert.equal(await upgrade(wsUrl, { cookie: "hatch_session=abc", origin: "https://evil.test" }), 403);
    assert.equal(await upgrade(wsUrl, { cookie: "hatch_session=abc" }), 403);
    assert.equal(await upgrade(`${wsUrl}?api_key=${key.token}`), 400);

    // A revoked API key stops working for new messages.
    const created = await (await call(`/v1/conversations?${query}`, key.token, { client_request_id: "revoke" })).json() as { conversation: { id: string } };
    assert.equal((await fetch(`${registryBase}/v1/auth/api-keys/${key.id}`, { method: "DELETE", headers: { authorization: `Bearer ${browserToken}` } })).status, 204);
    assert.equal((await call(`/v1/conversations/${created.conversation.id}/messages?${query}&wait=1`, key.token, { client_message_id: "after-revoke", content: "hi" })).status, 403);
  } finally {
    await runtime?.close();
    await registry.close();
  }
});
