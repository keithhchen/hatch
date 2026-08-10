import test from "node:test";
import assert from "node:assert/strict";
import { ServerToolExecutor } from "./serverTools.js";
import type { KnowledgeProvider } from "./agentCorpus.js";
import type { RuntimeCreatorTool } from "./creatorTools.js";

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

test("Runtime-owned network tools honor run cancellation and a hard timeout", async () => {
  delete process.env.HATCH_WEB_SEARCH_PROVIDER;
  delete process.env.HATCH_WEB_SEARCH_API_KEY;
  process.env.HATCH_WEB_SEARCH_URL = "https://search.invalid/query";
  globalThis.fetch = (async (_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    assert.ok(signal);
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  })) as typeof fetch;

  const controller = new AbortController();
  const cancelled = new ServerToolExecutor(10_000).execute(
    "hatch.web_search",
    { query: "cancel me", limit: 1 },
    controller.signal
  );
  const reason = new Error("owning run cancelled");
  controller.abort(reason);
  await assert.rejects(cancelled, (error) => error === reason);

  const started = Date.now();
  const keepAlive = setTimeout(() => undefined, 500);
  try {
    await assert.rejects(
      new ServerToolExecutor(20).execute("hatch.web_search", { query: "time out", limit: 1 }),
      (error: Error) => /timeout/i.test(error.name) || /timeout/i.test(error.message)
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(Date.now() - started < 500);
});

test("Knowledge and Creator tools receive the bounded owning-run signal", async () => {
  let knowledgeSignal: AbortSignal | undefined;
  const knowledge: KnowledgeProvider = {
    search: async (request) => {
      knowledgeSignal = request.signal;
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      });
    }
  };
  const knowledgeTools = new ServerToolExecutor(20);
  knowledgeTools.setKnowledgeScope({
    provider: knowledge,
    creatorId: "creator",
    agentId: "agent",
    corpusDigest: `sha256:${"1".repeat(64)}`
  });
  const keepAlive = setTimeout(() => undefined, 500);
  try {
    await assert.rejects(
      knowledgeTools.execute("hatch.file_search", { query: "bounded", limit: 1 }),
      (error: Error) => /timeout/i.test(error.name) || /timeout/i.test(error.message)
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(knowledgeSignal?.aborted, true);

  let creatorSignal: AbortSignal | undefined;
  const creatorTools = new ServerToolExecutor(10_000);
  creatorTools.setResolvedCreatorTools([{
    id: "creator.lookup",
    execute: async (_arguments: Record<string, unknown>, signal?: AbortSignal) => {
      creatorSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
  } as unknown as RuntimeCreatorTool]);
  const controller = new AbortController();
  const pending = creatorTools.executeCreatorTool({ id: "creator.lookup" }, {}, controller.signal);
  controller.abort(new Error("creator run cancelled"));
  await assert.rejects(pending, /creator run cancelled/);
  assert.equal(creatorSignal?.aborted, true);
});

test("Creator tool results are rejected before a multi-megabyte value reaches the model", async () => {
  const tools = new ServerToolExecutor();
  tools.setResolvedCreatorTools([{
    id: "creator.oversized",
    execute: async () => ({ content: "x".repeat(4 * 1024 * 1024) })
  } as unknown as RuntimeCreatorTool]);
  await assert.rejects(
    tools.executeCreatorTool({ id: "creator.oversized" }, {}),
    /Tool result exceeds/
  );
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
