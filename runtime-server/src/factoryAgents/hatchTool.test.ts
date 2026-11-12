import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { hatchTool } from "./hatchTool.js";
import { WorkbenchStore } from "./store.js";

// Explicit transport test fixture, not evidence of a real Runtime/model execution.
test("HTool talks HTTP to the shared Runtime for its host Product, isolates private files and saves original assets", async () => {
  const token = "test-creator-token";
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-transport-unit-"));
  let created = 0; let cancelled = 0; let reject = false;
  const sent: Array<{ id: string; content: string }> = [];
  const runs = new Map<string, string>();
  const creatorId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const requestUrl = new URL(req.url!, "http://localhost");
    assert.equal(requestUrl.searchParams.get("product_id"), productId);
    assert.equal(requestUrl.searchParams.has("entitlement_id"), false);
    let body: Record<string, any> = {};
    if (req.method === "POST") { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && requestUrl.pathname === "/v1/conversations") { created++; res.end(JSON.stringify({ conversation: { id: "conv_test" } })); }
    else if (requestUrl.pathname === "/v1/conversations/conv_test/messages") {
      if (reject) { res.statusCode = 409; res.end(JSON.stringify({ error: { code: "busy", message: "Conversation busy" } })); return; }
      assert.equal(requestUrl.searchParams.get("wait"), "60");
      if (!runs.has(body.client_message_id)) { runs.set(body.client_message_id, `run_${runs.size + 1}`); sent.push({ id: body.client_message_id, content: body.content }); }
      res.end(JSON.stringify({ run: { id: runs.get(body.client_message_id), status: "completed" }, outcome: "accepted", reply: `# Fixture response ${sent.length}\n` }));
    }
    else if (requestUrl.pathname.endsWith("/cancel")) { cancelled++; res.end("{}"); }
    else if (requestUrl.pathname.includes("/assets/")) { res.setHeader("content-type", "text/markdown"); res.end("# Actual asset fixture\r\nOriginal bytes.\r\n"); }
    else res.end(JSON.stringify({ conversation: { id: "conv_test" }, messages: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const store = new WorkbenchStore(root); const s = await store.create("evaluator");
    const target = { creatorId, productId };
    await store.put(s.id, "input/RUBRIC.md", Buffer.from("Private grading criteria"), { actor: "user" });
    const tool = hatchTool(store, s.id, () => {}, target, { HATCH_FACTORY_RUNTIME_URL: `${base}/v1/runtime`, HATCH_FACTORY_CREATOR_TOKEN: token });
    target.productId = "99999999-9999-4999-8999-999999999999";
    assert.ok(!JSON.stringify(tool.parameters).includes("productId") && !JSON.stringify(tool.parameters).includes("product_id"));
    await assert.rejects(tool.execute("leak", { operation: "start", message: "Task", material_paths: ["input/RUBRIC.md"] }), /public client/);
    assert.equal(created, 0);
    await tool.execute("first", { operation: "start", message: "Customer task" });
    await tool.execute("second", { operation: "continue", message: "Customer answer" });
    await tool.execute("read", { operation: "read" });
    await tool.execute("cancel", { operation: "cancel" });
    assert.equal(created, 1); assert.equal(cancelled, 1);
    assert.deepEqual(sent, [{ id: `factory-${s.id}-first`, content: "Customer task" }, { id: `factory-${s.id}-second`, content: "Customer answer" }]);
    assert.equal((await store.read(s.id, "output/RESULT.md")).bytes.toString(), "# Fixture response 2\n");
    const records = (await store.get(s.id)).files;
    assert.equal(records.filter(f => /results\/[^/]+\.md$/.test(f.path) && !f.path.endsWith("-trace.md")).length, 2);
    for (const record of records.filter(f => f.path.endsWith("-trace.md"))) {
      const trace = (await store.read(s.id, record.path)).bytes.toString();
      assert.ok(!trace.includes(token) && !trace.includes("Private grading criteria"));
    }
    // A retried tool call carries the same message ID, so the Runtime replays the Run rather than duplicating it.
    await store.update(s.id, x => { x.hatch!.pending = false; });
    await tool.execute("second", { operation: "continue", message: "Customer answer" });
    assert.equal(sent.length, 2);
    await tool.execute("asset", { operation: "read_asset", asset_id: "asset_test" });
    assert.equal((await store.read(s.id, "output/RESULT.md")).bytes.toString(), "# Actual asset fixture\r\nOriginal bytes.\r\n");
    reject = true;
    await assert.rejects(tool.execute("refused", { operation: "continue", message: "Must not execute" }), /busy/);
    assert.equal((await store.get(s.id)).hatch?.pending, false);
  } finally {
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
    const scope = { creatorId: "11111111-1111-4111-8111-111111111111", productId: "22222222-2222-4222-8222-222222222222" };
    const tool = hatchTool(store, s.id, () => {}, scope, { HATCH_FACTORY_RUNTIME_URL: runtimeUrl, HATCH_FACTORY_CREATOR_TOKEN: "unit-test-token" });
    await assert.rejects(tool.execute("cancel", { operation: "start", message: "Test request" }, controller.signal));
    assert.equal((await store.get(s.id)).hatch, undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
