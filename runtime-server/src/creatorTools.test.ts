import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { creatorModelToolName, RegistryCreatorToolControlPlane, resolveCreatorTools, type CreatorToolControlPlane } from "./creatorTools.js";
import type { AgentCorpus } from "./agentCorpus.js";

const corpus = {
  tools: [
    { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
    {
      id: "creator.market-analysis",
      kind: "http_function",
      connection_ref: "market-data-api",
      operation: "get_market_snapshot",
      description: "Get a current market snapshot.",
      input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false }
    }
  ]
} as unknown as AgentCorpus;

test("Creator tools resolve through Control Plane without leaking connection data into Corpus", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const controlPlane: CreatorToolControlPlane = {
    async resolve(request) {
      assert.equal(request.tenantId, "tenant-1");
      assert.equal(request.agentId, "agent-1");
      assert.equal(request.tool.kind, "http_function");
      if (request.tool.kind !== "http_function") throw new Error("unexpected MCP tool");
      assert.equal(request.tool.connection_ref, "market-data-api");
      return [{
        id: request.tool.id,
        modelName: creatorModelToolName(request.tool.id),
        kind: "http",
        connectionRef: request.tool.connection_ref,
        function: { name: request.tool.operation, description: request.tool.description ?? "", parameters: request.tool.input_schema ?? {} },
        execute: async (arguments_) => {
          calls.push(arguments_);
          return { price: 42 };
        }
      }];
    }
  };

  const tools = await resolveCreatorTools(controlPlane, "tenant-1", "agent-1", corpus);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.id, "creator.market-analysis");
  assert.equal(tools[0]?.modelName, "creator_market_analysis");
  assert.deepEqual(await tools[0]!.execute({ ticker: "HATCH" }), { price: 42 });
  assert.deepEqual(calls, [{ ticker: "HATCH" }]);
});

test("Creator tools fail closed when a Corpus requires a missing Control Plane", async () => {
  await assert.rejects(
    () => resolveCreatorTools(undefined, "tenant-1", "agent-1", corpus),
    /Control Plane/
  );
});

test("Creator HTTP tools support GET query parameters and server-side API-key headers", async (t) => {
  const target = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      method: request.method,
      q: url.searchParams.get("q"),
      authorization: request.headers["x-api-key"] ?? null
    }));
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  t.after(() => target.close());

  const registry = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      id: "seth-alpha-lite-search", tenant_id: "seth", kind: "http", secret_ref: "secret:seth-alpha-lite",
      config: {
        url: `http://127.0.0.1:${(target.address() as { port: number }).port}/api/agent/search`,
        method: "GET",
        auth: { header: "X-API-Key", prefix: "" }
      }, status: "active"
    }));
  });
  await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
  t.after(() => registry.close());

  const controlPlane = new RegistryCreatorToolControlPlane({
    registryUrl: `http://127.0.0.1:${(registry.address() as { port: number }).port}`,
    serviceToken: "internal-test",
    secretResolver: { async resolve(secretRef) {
      assert.equal(secretRef, "secret:seth-alpha-lite");
      return "test-seth-key";
    } }
  });
  const sethCorpus = {
    tools: [{
      id: "creator.seth.search-company",
      kind: "http_function",
      connection_ref: "seth-alpha-lite-search",
      operation: "search_company",
      input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }
    }]
  } as unknown as AgentCorpus;
  const [tool] = await resolveCreatorTools(controlPlane, "seth", "alpha-lite", sethCorpus);
  assert.deepEqual(await tool!.execute({ q: "NVIDIA" }), {
    method: "GET", q: "NVIDIA", authorization: "test-seth-key"
  });
});

test("Creator MCP tools use Streamable HTTP initialization, session headers, and SSE responses", async (t) => {
  const calls: Array<{ method: string; session?: string; protocol?: string }> = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/v1/runtime/")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        id: "creator-mcp", tenant_id: "tenant-1", kind: "mcp", secret_ref: null,
        config: { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` }, status: "active"
      }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string; params?: Record<string, unknown> };
    calls.push({ method: body.method, session: request.headers["mcp-session-id"] as string | undefined, protocol: request.headers["mcp-protocol-version"] as string | undefined });
    const result = body.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "test", version: "1" } }
      : body.method === "tools/list"
        ? { tools: [{ name: "lookup", description: "Lookup a record.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }] }
        : { content: [{ type: "text", text: `record:${String(body.params?.arguments && (body.params.arguments as Record<string, unknown>).id)}` }] };
    response.statusCode = body.method === "notifications/initialized" ? 202 : 200;
    if (body.method === "initialize") response.setHeader("MCP-Session-Id", "test-session-123");
    if (body.method === "notifications/initialized") {
      response.end();
      return;
    }
    response.setHeader("content-type", "text/event-stream");
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "test", result })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const controlPlane = new RegistryCreatorToolControlPlane({
    registryUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    serviceToken: "internal-test",
  });
  const mcpCorpus = {
    tools: [
      { id: "hatch.web_search", kind: "hatch_builtin", capability: "web_search" },
      { id: "creator.market-data", kind: "mcp_tool", connection_ref: "creator-mcp", tool_name: "lookup" }
    ]
  } as unknown as AgentCorpus;
  const tools = await resolveCreatorTools(controlPlane, "tenant-1", "agent-1", mcpCorpus);
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.id, "creator.market-data");
  assert.deepEqual(await tools[0]!.execute({ id: "AAPL" }), { content: [{ type: "text", text: "record:AAPL" }] });
  assert.deepEqual(calls.map((call) => call.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  assert.equal(calls[1]?.session, "test-session-123");
  assert.equal(calls[2]?.protocol, "2025-11-25");
  assert.equal(calls[3]?.session, "test-session-123");
});
