import assert from "node:assert/strict";
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
  let service = new FactoryAgentsService(root, {}, definitions);
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
    assert.equal((await lockedCreate.json() as { error: { code: string } }).error.code, "agent_dependencies_not_ready");
    const a = await (await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "research" })).json() as { id: string; product: { creatorId: string; productId: string } };
    const b = await (await call("creator-a", PRODUCT_B, "sessions", "POST", { role: "research" })).json() as { id: string };
    assert.deepEqual(a.product, { creatorId: "creator-a", productId: PRODUCT_A });
    assert.equal((await call("creator-a", PRODUCT_A, `sessions/${a.id}/files`, "POST", { path: "output/RESEARCH.md", base64: Buffer.from("Product A evidence").toString("base64") })).status, 201);
    const voice = await (await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "voice" })).json() as { id: string; product: { productId: string } };
    assert.equal(voice.product.productId, PRODUCT_A);
    assert.equal((await call("creator-a", PRODUCT_A, `sessions/${voice.id}/files`, "POST", { path: "output/CREATOR_PERSONA.md", base64: Buffer.from("Creator interview evidence").toString("base64") })).status, 201);
    const generation = await (await call("creator-a", PRODUCT_A, "sessions", "POST", { role: "generation" })).json() as { id: string; product: { productId: string } };
    assert.equal(generation.product.productId, PRODUCT_A);
    const navigation = await (await call("creator-a", PRODUCT_A, "sessions")).json() as { agents: Array<{ role: string; state: string; availability: unknown }> };
    assert.equal(navigation.agents.find(agent => agent.role === "generation")?.state, "ready");
    assert.ok(navigation.agents.every(agent => agent.availability));
    assert.ok(navigation.agents.every(agent => !("systemPrompt" in agent) && !("tools" in agent)));
    const changedDefinitions = await initialAgentDefinitions();
    changedDefinitions.find(definition => definition.role === "research")!.dependencies = { required: ["voice"], normal: [] };
    changedDefinitions.find(definition => definition.role === "voice")!.dependencies = { required: [], normal: [] };
    definitions.replace(changedDefinitions);
    const lockedMessage = await call("creator-a", PRODUCT_B, `sessions/${b.id}/message`, "POST", { content: "must be rejected before Runtime" });
    assert.equal(lockedMessage.status, 409);
    assert.deepEqual((await lockedMessage.json() as { error: { code: string; details: { role: string; missingRequired: string[]; normalCandidates: string[] } } }).error, {
      code: "agent_dependencies_not_ready",
      message: "This Agent's dependencies are not ready.",
      details: { role: "research", missingRequired: ["voice"], normalCandidates: [], normalSatisfied: true }
    });
    const changedNavigation = await (await call("creator-a", PRODUCT_B, "sessions")).json() as { agents: Array<{ role: string; state: string }> };
    assert.equal(changedNavigation.agents.find(agent => agent.role === "research")?.state, "locked");
    definitions.replace(await initialAgentDefinitions());
    assert.notEqual((await call("creator-a", PRODUCT_B, `sessions/${a.id}`)).status, 200);
    assert.notEqual((await call("creator-a", PRODUCT_B, `sessions/${b.id}/transfer`, "POST", { fromSessionId: a.id, files: [{ path: "output/RESEARCH.md" }] })).status, 200);
    const productBListing = await (await call("creator-a", PRODUCT_B, "sessions")).text();
    assert.ok(!productBListing.includes(a.id)); assert.ok(!productBListing.includes("Product A evidence"));
    await service.close(); service = new FactoryAgentsService(root, {}, definitions);
    const saved = await (await call("creator-a", PRODUCT_A, `sessions/${a.id}/files?path=output/RESEARCH.md`)).json() as { content: string };
    assert.equal(saved.content, "Product A evidence");
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
