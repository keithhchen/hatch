import assert from "node:assert/strict";
import { InMemoryModelRoleResolver } from "../modelRoles.js";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FactoryAgentsService } from "./service.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";

const PRODUCT = "22222222-2222-4222-8222-222222222222";

test("A factory session message sent under one Idempotency-Key starts one turn, even when retried after the turn ended", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-idempotency-test-"));
  const service = new FactoryAgentsService(root, {}, new InMemoryModelRoleResolver(), new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  const server = http.createServer((req, res) => { void service.handle({ creatorId: "creator-a", productId: PRODUCT }, "test-secret", req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const call = (route: string, method = "GET", data?: unknown, key?: string) => fetch(`http://127.0.0.1:${address.port}/v1/creator/products/${PRODUCT}/factory-agents/${route}`,
    { method, headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  const session = async (id: string) => await (await call(`sessions/${id}`)).json() as { status: string; turn: number; messageKeys?: unknown };
  const settled = async (id: string) => { for (let i = 0; i < 100; i++) { if ((await session(id)).status !== "running") return; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error("run did not end"); };
  try {
    const { id } = await (await call("sessions", "POST", { role: "research" })).json() as { id: string };
    const send = (content: string, key?: string) => call(`sessions/${id}/message`, "POST", { content }, key);
    assert.equal((await send("hello", "key-1")).status, 202);
    await settled(id);
    assert.equal((await session(id)).turn, 1);
    const replay = await send("hello", "key-1");
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), { accepted: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    const after = await session(id);
    assert.equal(after.turn, 1, "the retry started no second turn");
    assert.equal(after.messageKeys, undefined, "the keys are not part of the public session");
    const reused = await send("something else", "key-1");
    assert.equal(reused.status, 422);
    assert.equal((await reused.json() as { error: { code: string } }).error.code, "idempotency_key_reused");
    assert.equal((await send("hello", "key-2")).status, 202);
    await settled(id);
    assert.equal((await session(id)).turn, 2, "a new key is a new send");
    assert.equal((await send("no header")).status, 202);
    await settled(id);
    assert.equal((await session(id)).turn, 3, "no header, unchanged behaviour");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
