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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
