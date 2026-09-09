import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { WebSocketServer } from "ws";
import { hatchTool } from "./hatchTool.js";
import { WorkbenchStore } from "./store.js";
import { PROTOCOL_VERSION } from "../protocol.js";

// Explicit transport test fixture, not evidence of a real Runtime/model execution.
for (const account of ["buyer", "creator"] as const) test(`HTool uses the shared Runtime as ${account}, isolates private files and saves original assets`, async () => {
  const token = `test-${account}-token`;
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-transport-unit-"));
  let created = 0; let messages = 0; let mismatch = false;
  const hellos: Array<Record<string, unknown>> = [];
  const creatorId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const version = `sha256:${"a".repeat(64)}`;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const scope = new URL(req.url!, "http://localhost").searchParams;
    assert.equal(scope.get("product_id"), account === "creator" ? productId : null);
    assert.equal(scope.has("entitlement_id"), account === "buyer");
    if (req.method === "POST") { for await (const _chunk of req) {} created++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ conversation: { id: "conv_test" } })); }
    else if (req.url?.includes("/assets/")) { res.setHeader("content-type", "text/markdown"); res.end("# Actual asset fixture\r\nOriginal bytes.\r\n"); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ messages: [] })); }
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket, request) => { assert.equal(request.url, "/v1/runtime"); socket.on("message", data => {
    const message = JSON.parse(String(data));
    if (message.type === "client.hello") {
      hellos.push(message);
      socket.send(JSON.stringify({ type: "session.ready", accepted_protocol_version: PROTOCOL_VERSION, creator_id: creatorId, product_id: mismatch ? "wrong-product" : productId, corpus_digest: version }));
    }
    if (message.type === "client.message") {
      messages++;
      socket.send(JSON.stringify({ type: "assistant.delta", run_id: message.run_id, delta: { kind: "text", content: `# Fixture response ${messages}\n` } }));
      socket.send(JSON.stringify({ type: "turn.completed", run_id: message.run_id, finish_reason: "stop" }));
      socket.send(JSON.stringify({ type: "turn.state", run_id: message.run_id, status: "completed" }));
    }
  }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const store = new WorkbenchStore(root); const s = await store.create("evaluator");
    const target = { runtimeUrl: `${base}/v1/runtime`, creatorId, productId, ...(account === "buyer" ? { entitlementId: "33333333-3333-4333-8333-333333333333" } : {}) };
    await store.update(s.id, session => { session.target = target; });
    await store.put(s.id, "input/RUBRIC.md", Buffer.from("Private grading criteria"), { actor: "user" });
    const tool = hatchTool(store, s.id, () => {}, { HATCH_FACTORY_RUNTIME_URL: `${base}/v1/runtime`, ...(account === "buyer" ? { HATCH_FACTORY_AUTH_TOKEN: token } : { HATCH_FACTORY_CREATOR_TOKEN: token }) });
    await assert.rejects(tool.execute("leak", { operation: "start", message: "Task", material_paths: ["input/RUBRIC.md"] }), /public client/);
    assert.equal(created, 0);
    await tool.execute("first", { operation: "start", message: "Customer task" });
    await tool.execute("second", { operation: "continue", message: "Customer answer" });
    assert.equal(created, 1); assert.equal(messages, 2);
    assert.ok(hellos.every(h => account === "creator" ? h.product_id === productId && h.entitlement_id === undefined : h.entitlement_id === target.entitlementId));
    assert.ok(hellos.every(h => Array.isArray(h.local_tools) && h.local_tools.length === 0 && h.auth_token === token));
    assert.equal((await store.read(s.id, "output/RESULT.md")).bytes.toString(), "# Fixture response 2\n");
    const records = (await store.get(s.id)).files;
    assert.equal(records.filter(f => /results\/[^/]+\.md$/.test(f.path) && !f.path.endsWith("-trace.md")).length, 2);
    await tool.execute("asset", { operation: "read_asset", asset_id: "asset_test" });
    assert.equal((await store.read(s.id, "output/RESULT.md")).bytes.toString(), "# Actual asset fixture\r\nOriginal bytes.\r\n");
    mismatch = true;
    await assert.rejects(tool.execute("wrong-version", { operation: "continue", message: "Must not execute" }), /different Agent/);
    assert.equal(messages, 2); assert.equal((await store.get(s.id)).hatch?.pending, false);
    assert.equal((await store.read(s.id, "output/RESULT.md")).bytes.toString(), "# Actual asset fixture\r\nOriginal bytes.\r\n");
  } finally {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("stopping evaluation aborts an outstanding shared-client HTTP request", { timeout: 5000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-http-abort-"));
  const controller = new AbortController();
  const server = http.createServer(() => controller.abort(new Error("User stopped evaluation")));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const runtimeUrl = `http://127.0.0.1:${address.port}/v1/runtime`;
    const store = new WorkbenchStore(root); const s = await store.create("evaluator");
    await store.update(s.id, state => { state.target = { runtimeUrl, creatorId: "11111111-1111-4111-8111-111111111111", productId: "22222222-2222-4222-8222-222222222222" }; });
    const tool = hatchTool(store, s.id, () => {}, { HATCH_FACTORY_RUNTIME_URL: runtimeUrl, HATCH_FACTORY_CREATOR_TOKEN: "unit-test-token" });
    await assert.rejects(tool.execute("cancel", { operation: "start", message: "Test request" }, controller.signal));
    assert.equal((await store.get(s.id)).hatch, undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
