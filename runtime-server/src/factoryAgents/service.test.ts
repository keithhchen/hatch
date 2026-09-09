import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FactoryAgentsService } from "./service.js";

test("authenticated Creator partitions persist files and reject cross-account access and transfer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-creator-test-"));
  // Authentication is deliberately supplied by this unit transport. Registry authenticates real requests.
  let service = new FactoryAgentsService(root, {});
  const server = http.createServer((req, res) => { void service.handle(String(req.headers["x-test-creator"]), "test-secret", req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const call = (owner: string, route: string, method = "GET", data?: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/creator/factory-agents/${route}`, { method, headers: { "x-test-creator": owner, "content-type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
  try {
    const a = await (await call("creator-a", "sessions", "POST", { role: "research" })).json() as { id: string };
    const b = await (await call("creator-b", "sessions", "POST", { role: "generation" })).json() as { id: string };
    assert.equal((await call("creator-a", `sessions/${a.id}/files`, "POST", { path: "output/RESEARCH.md", base64: Buffer.from("Private evidence").toString("base64") })).status, 201);
    assert.notEqual((await call("creator-b", `sessions/${a.id}`)).status, 200);
    assert.notEqual((await call("creator-b", `sessions/${b.id}/transfer`, "POST", { fromSessionId: a.id, files: [{ path: "output/RESEARCH.md" }] })).status, 200);
    const listing = await (await call("creator-b", "sessions")).text();
    assert.ok(!listing.includes(a.id)); assert.ok(!listing.includes("test-secret"));
    assert.equal((await call("creator-a", "login", "POST", {})).status, 404);
    await service.close(); service = new FactoryAgentsService(root, {});
    const saved = await (await call("creator-a", `sessions/${a.id}/files?path=output/RESEARCH.md`)).json() as { content: string };
    assert.equal(saved.content, "Private evidence");
  } finally { await service.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
