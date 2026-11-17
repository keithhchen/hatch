import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import type { AgentCorpus, AgentCorpusResolver } from "./agentCorpus.js";
import type { Library } from "./chat/library.js";
import { GuestTokens } from "./guestToken.js";
import { createRuntimeServer } from "./index.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { RuntimeStore } from "./store.js";

const PRODUCT_ID = "33333333-3333-4333-8333-333333333333";
const CREATOR_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const STRANGER_ID = "44444444-4444-4444-8444-444444444444";
const guests = new GuestTokens("shared-secret");
const guestId = "A".repeat(22);
const guestToken = guests.issue(guestId);

const listen = async (server: http.Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};

async function startRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-open-access-"));
  const saved: string[] = [];
  const library: Library = { save: async (account, product) => { saved.push(`${account}:${product}`); return true; } };
  const corpus = { agent_id: PRODUCT_ID, creator: { id: CREATOR_ID, name: "Maya" }, product: { id: PRODUCT_ID, name: "Resume Review", boundaries: [], presentation: {} }, tools: [] } as unknown as AgentCorpus;
  const resolved = () => ({ root: "", digest: `sha256:${"a".repeat(64)}`, corpus });
  const accounts = { "acct-token": ACCOUNT_ID, "creator-token": CREATOR_ID, "stranger-token": STRANGER_ID } as Record<string, string>;
  const runtime = createRuntimeServer({
    conversationStore: new RuntimeStore(path.join(root, "runtime")),
    authIdentityResolver: { resolveIdentity: async (token) => token && accounts[token] ? { sub: accounts[token]! } : undefined },
    entitlementResolver: { list: async () => [] },
    agentCorpusResolver: { resolve: async () => resolved(), resolveByProduct: async () => resolved(), list: async () => [] } as unknown as AgentCorpusResolver,
    guestTokens: guests,
    library,
    createRuntime: () => ({ async *run(input) {
      yield { type: "assistant.delta" as const, run_id: input.run_id, delta: { kind: "text" as const, content: "hello" } };
      yield { type: "turn.completed" as const, run_id: input.run_id, finish_reason: "stop" as const };
    } })
  });
  return { runtime, saved, base: await listen(runtime.server) };
}

const call = (base: string, route: string, token: string, init: { method?: string; body?: unknown } = {}) => fetch(`${base}${route}`, {
  method: init.method ?? "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) })
});

test("a guest chats three times, is asked to sign in on the fourth, and keeps everything when they do", async () => {
  const { runtime, saved, base } = await startRuntime();
  try {
    const query = `product_id=${PRODUCT_ID}`;
    const agent = await (await call(base, `/v1/products/${PRODUCT_ID}/agent`, guestToken)).json() as { creator_agent: { product: { name: string }; creator: { id: string } } };
    assert.deepEqual([agent.creator_agent.product.name, agent.creator_agent.creator.id], ["Resume Review", CREATOR_ID]);

    const created = await call(base, `/v1/conversations?${query}`, guestToken, { method: "POST", body: { client_request_id: "k" } });
    assert.equal(created.status, 201);
    const conversation = (await created.json() as { conversation: { id: string } }).conversation.id;
    const send = (token: string, n: number) => call(base, `/v1/conversations/${conversation}/messages?${query}&wait=5`, token, { method: "POST", body: { client_message_id: `m${n}`, content: "hi" } });
    for (const n of [1, 2, 3]) assert.equal((await send(guestToken, n)).status, 200, `message ${n}`);
    const refused = await send(guestToken, 4);
    assert.equal(refused.status, 403);
    assert.equal((await refused.json() as { error: { code: string } }).error.code, "login_required");
    assert.deepEqual(saved, [], "a guest has no library");

    // Files need an account: a visitor's would be stranded when they sign in.
    const upload = await fetch(`${base}/v1/conversations/${conversation}/assets?${query}&name=a.png`, { method: "POST", headers: { authorization: `Bearer ${guestToken}`, "content-type": "image/png" }, body: Buffer.from("x") });
    assert.ok([403, 501].includes(upload.status), `upload as guest: ${upload.status}`);

    // Only the owner of the conversation, by token, sees it.
    const otherGuest = guests.issue("B".repeat(22));
    assert.equal((await call(base, `/v1/conversations/${conversation}/snapshot?${query}`, otherGuest)).status, 404);

    // The creator sees a visitor, counted, with no identifier.
    const audience = await (await call(base, "/v1/creator/audience", "creator-token")).json() as { audience: Array<Record<string, unknown>> };
    assert.deepEqual(audience.audience.map(({ first_at, last_at, ...row }) => row), [{ product_id: PRODUCT_ID, kind: "guest", conversations: 1, messages: 3 }]);
    assert.equal((await call(base, "/v1/creator/audience", guestToken)).status, 401);

    // Signing in: the guest's conversations become the account's, once; a forged or foreign token moves nothing.
    assert.equal((await call(base, "/v1/guest/carry-over", "acct-token", { method: "POST", body: { guest_token: `hatch_guest.${guestId}.forged` } })).status, 400);
    assert.equal((await call(base, "/v1/guest/carry-over", guestToken, { method: "POST", body: { guest_token: guestToken } })).status, 401, "a guest cannot carry itself over");
    const carried = await call(base, "/v1/guest/carry-over", "acct-token", { method: "POST", body: { guest_token: guestToken } });
    assert.deepEqual(await carried.json(), { moved: 1 });
    assert.deepEqual(await (await call(base, "/v1/guest/carry-over", "acct-token", { method: "POST", body: { guest_token: guestToken } })).json(), { moved: 0 }, "repeating moves nothing more");
    assert.deepEqual(saved, [`${ACCOUNT_ID}:${PRODUCT_ID}`]);

    const mine = await (await call(base, `/v1/conversations?${query}`, "acct-token")).json() as { conversations: Array<{ id: string }> };
    assert.deepEqual(mine.conversations.map((entry) => entry.id), [conversation], "the conversation keeps its id");
    assert.equal((await call(base, `/v1/conversations/${conversation}/snapshot?${query}`, guestToken)).status, 404, "the guest no longer has it");
    assert.equal((await call(base, `/v1/conversations/${conversation}/snapshot?${query}`, "stranger-token")).status, 404);

    // As an account the conversation continues without limit, and chatting saves the Agent.
    assert.equal((await send("acct-token", 4)).status, 200);
    assert.equal((await send("acct-token", 5)).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(saved.filter((entry) => entry === `${ACCOUNT_ID}:${PRODUCT_ID}`).length >= 2, "each Run saves the Agent again, so a removed one comes back");

    const after = await (await call(base, "/v1/creator/audience", "creator-token")).json() as { audience: Array<Record<string, unknown>> };
    assert.deepEqual(after.audience.map(({ first_at, last_at, ...row }) => row), [{ product_id: PRODUCT_ID, kind: "account", account_id: ACCOUNT_ID, conversations: 1, messages: 5 }]);
  } finally {
    await runtime.close();
  }
});

test("a guest opens a live Agent over the WebSocket by product_id, and a forged guest token is refused", async () => {
  const { runtime, base } = await startRuntime();
  try {
    const query = `product_id=${PRODUCT_ID}`;
    const created = await call(base, `/v1/conversations?${query}`, guestToken, { method: "POST", body: {} });
    const conversation = (await created.json() as { conversation: { id: string } }).conversation.id;
    const hello = (token: string) => new Promise<{ type: string; error?: { code: string } }>((resolve, reject) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/runtime`);
      socket.once("error", reject);
      socket.once("message", (data) => { socket.close(); resolve(JSON.parse(String(data))); });
      socket.once("open", () => socket.send(JSON.stringify({ type: "client.hello", protocol_version: PROTOCOL_VERSION, conversation_id: conversation, product_id: PRODUCT_ID, auth_token: token, local_tools: [] })));
    });
    assert.equal((await hello(guestToken)).type, "session.ready");
    const forged = await hello(`hatch_guest.${guestId}.forged`);
    assert.deepEqual([forged.type, forged.error?.code], ["session.error", "authentication_required"]);
  } finally {
    await runtime.close();
  }
});
