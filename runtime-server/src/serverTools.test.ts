import test from "node:test";
import assert from "node:assert/strict";
import { ServerToolExecutor } from "./serverTools.js";

const originalFetch = globalThis.fetch;
const originalProvider = process.env.HATCH_WEB_SEARCH_PROVIDER;
const originalUrl = process.env.HATCH_WEB_SEARCH_URL;
const originalKey = process.env.HATCH_WEB_SEARCH_API_KEY;

test.after(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("HATCH_WEB_SEARCH_PROVIDER", originalProvider);
  restoreEnv("HATCH_WEB_SEARCH_URL", originalUrl);
  restoreEnv("HATCH_WEB_SEARCH_API_KEY", originalKey);
});

test("Bocha web search uses the CWebSearch request contract and normalizes results", async () => {
  process.env.HATCH_WEB_SEARCH_PROVIDER = "bocha";
  process.env.HATCH_WEB_SEARCH_URL = "https://api.bocha.cn/v1/web-search";
  process.env.HATCH_WEB_SEARCH_API_KEY = "bocha-test-key";

  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return new Response(JSON.stringify({
      code: 200,
      data: {
        webPages: {
          value: [{
            name: "Hatch",
            url: "https://hatch.example",
            snippet: "A creator product platform.",
            summary: "A concise summary",
            siteName: "Hatch"
          }]
        }
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const result = await new ServerToolExecutor().execute("hatch.web_search", { query: "Hatch", limit: 3 });
  assert.equal(request?.url, "https://api.bocha.cn/v1/web-search");
  assert.equal(new Headers(request?.init.headers).get("authorization"), "Bearer bocha-test-key");
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    query: "Hatch",
    freshness: "noLimit",
    summary: true,
    count: 3
  });
  assert.deepEqual(result, {
    query: "Hatch",
    results: [{
      title: "Hatch",
      url: "https://hatch.example",
      snippet: "A creator product platform.",
      summary: "A concise summary",
      site_name: "Hatch",
      date_published: undefined
    }]
  });
});

test("Bocha web search fails closed when its API key is missing", async () => {
  process.env.HATCH_WEB_SEARCH_PROVIDER = "bocha";
  process.env.HATCH_WEB_SEARCH_URL = "https://api.bocha.cn/v1/web-search";
  delete process.env.HATCH_WEB_SEARCH_API_KEY;
  await assert.rejects(
    () => new ServerToolExecutor().execute("hatch.web_search", { query: "Hatch", limit: 3 }),
    /HATCH_WEB_SEARCH_API_KEY/
  );
});

test("Registry-resolved Creator tools execute through their connection closure instead of the environment bridge", async () => {
  const executor = new ServerToolExecutor();
  executor.setCreatorTools([{ id: "creator.market_data", kind: "http_function", connection_ref: "market-api", operation: "get_snapshot" }]);
  const calls: Array<Record<string, unknown>> = [];
  executor.setResolvedCreatorTools([{
    id: "creator.market_data",
    modelName: "creator_market_data",
    kind: "http",
    connectionRef: "market-api",
    function: { name: "get_snapshot", description: "Get a snapshot.", parameters: {} },
    execute: async (arguments_) => {
      calls.push(arguments_);
      return { price: 42 };
    }
  }]);
  const result = await executor.executeCreatorTool({ id: "creator.market_data", kind: "http_function", connection_ref: "market-api", operation: "get_snapshot" }, { ticker: "HATCH" });
  assert.deepEqual(result, { price: 42 });
  assert.deepEqual(calls, [{ ticker: "HATCH" }]);
});

test("Creator tools without a Registry resolution still reject when not declared for the Agent", async () => {
  const executor = new ServerToolExecutor();
  await assert.rejects(
    executor.executeCreatorTool({ id: "creator.unknown", kind: "http_function", connection_ref: "unused", operation: "x" }, {}),
    /not enabled for this Agent/
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
