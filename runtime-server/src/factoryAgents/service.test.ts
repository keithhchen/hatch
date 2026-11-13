import assert from "node:assert/strict";
import { InMemoryModelRoleResolver } from "../modelRoles.js";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FactoryAgentsService } from "./service.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";

const PRODUCT_A = "22222222-2222-4222-8222-222222222222";
const PRODUCT_B = "33333333-3333-4333-8333-333333333333";

test("Factory workspaces are partitioned by authenticated Creator and existing Product", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-product-test-"));
  // Authentication and Product ownership are deliberately supplied by this unit transport.
  // Registry verifies both before mounting the handler in production.
  const definitions = new MemoryAgentDefinitionRepository(await initialAgentDefinitions());
  let service = new FactoryAgentsService(root, {}, new InMemoryModelRoleResolver(), definitions);
  const server = http.createServer((req, res) => {
    const creatorId = String(req.headers["x-test-creator"]);
    const productId = String(req.headers["x-test-product"]);
    void service.handle({ creatorId, productId }, "test-secret", req, res);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const call = (creatorId: string, productId: string, route: string, method = "GET", data?: unknown) => fetch(
    `http://127.0.0.1:${address.port}/v1/creator/products/${productId}/factory-agents/${route}`,
    { method, headers: { "x-test-creator": creatorId, "x-test-product": productId, "content-type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) }
  );
  try {
    const lockedCreate = await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "generation" });
    assert.equal(lockedCreate.status, 409);
    assert.equal((await lockedCreate.json() as { error: { code: string } }).error.code, "build_not_ready");
    const a = await (await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "research" })).json() as { id: string; product: { creatorId: string; productId: string } };
    const b = await (await call("creator-a", PRODUCT_B, "sessions", "POST", { role: "research" })).json() as { id: string };
    assert.deepEqual(a.product, { creatorId: "creator-a", productId: PRODUCT_A });
    assert.equal((await call("creator-a", PRODUCT_A, `sessions/${a.id}/files`, "POST", { path: "output/RESEARCH.md", base64: Buffer.from("Product A evidence").toString("base64") })).status, 201);
    const voice = await (await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "voice" })).json() as { id: string; product: { productId: string } };
    assert.equal(voice.product.productId, PRODUCT_A);
    assert.equal((await call("creator-a", PRODUCT_A, `sessions/${voice.id}/files`, "POST", { path: "output/CREATOR_PERSONA.md", base64: Buffer.from("Creator interview evidence").toString("base64") })).status, 201);
    const generation = await (await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "generation" })).json() as { id: string; product: { productId: string } };
    assert.equal(generation.product.productId, PRODUCT_A);
    const navigation = await (await call("creator-a", PRODUCT_A, "sessions")).json() as { agents: Array<{ role: string; state: string; }> };
    assert.equal(navigation.agents.find(agent => agent.role === "generation")?.state, "ready");
    assert.ok(navigation.agents.every(agent => !("systemPrompt" in agent) && !("tools" in agent)));
    const blockedBuild = await call("creator-a", PRODUCT_B, "sessions", "POST", { role: "generation" });
    assert.equal(blockedBuild.status, 409, "Product B has neither uploads nor interview output");
    const changedNavigation = await (await call("creator-a", PRODUCT_B, "sessions")).json() as { agents: Array<{ role: string; state: string }> };
    assert.deepEqual(changedNavigation.agents.filter(agent => agent.state === "locked").map(agent => agent.role), ["generation"]);
    assert.notEqual((await call("creator-a", PRODUCT_B, `sessions/${a.id}`)).status, 200);
    const otherCreator = await (await call("creator-b", PRODUCT_A, "sessions", "POST", { role: "research" })).json() as { id: string };
    const productBListing = await (await call("creator-a", PRODUCT_B, "sessions")).text();
    assert.ok(!productBListing.includes(a.id)); assert.ok(!productBListing.includes("Product A evidence"));
    await service.close(); service = new FactoryAgentsService(root, {}, new InMemoryModelRoleResolver(), definitions);
    const saved = await (await call("creator-a", PRODUCT_A, `sessions/${a.id}/files?path=output/RESEARCH.md`)).json() as { content: string };
    assert.equal(saved.content, "Product A evidence");
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
