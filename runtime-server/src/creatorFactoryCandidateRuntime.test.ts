import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import { createHatchCandidateRuntimeExecutor } from "./creatorLearning/candidateRuntime.js";
import { KIMI_MODEL } from "./piModel.js";

function streamResponse(text: string): Response {
  const chunks = [
    {
      id: "chatcmpl-factory-runtime",
      object: "chat.completion.chunk",
      created: 1,
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]
    },
    {
      id: "chatcmpl-factory-runtime",
      object: "chat.completion.chunk",
      created: 1,
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function toolCallResponse(name: string, args: Record<string, unknown>): Response {
  const chunks = [
    {
      id: "chatcmpl-factory-runtime-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: KIMI_MODEL,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_factory_forbidden_tool",
            type: "function",
            function: { name, arguments: JSON.stringify(args) }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl-factory-runtime-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("Factory candidate evaluation uses Hatch PiAgentRuntime without Creator reference answers", async (t) => {
  const previousKey = process.env.LLM_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    globalThis.fetch = previousFetch;
  });

  process.env.LLM_API_KEY = "factory-runtime-test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:18191/v1";
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return streamResponse("RUNTIME_RESULT");
  };

  const execute = createHatchCandidateRuntimeExecutor();
  const result = await execute({
    runId: "factory-runtime-seam",
    corpusVersion: 3,
    agentCorpusRoot: "/tmp/legacy-candidate-runtime-test",
    creatorId: "11111111-1111-4111-8111-111111111111",
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    corpusDigest: `sha256:${"0".repeat(64)}`,
    systemInstructions: "CANDIDATE_SYSTEM_MARKER",
    question: "GENERATED_QUESTION_MARKER"
  });

  assert.equal(result, "RUNTIME_RESULT");
  assert.ok(requestBody);
  const serialized = JSON.stringify(requestBody);
  assert.match(serialized, /CANDIDATE_SYSTEM_MARKER/);
  assert.match(serialized, /GENERATED_QUESTION_MARKER/);
  assert.doesNotMatch(serialized, /Creator Answer|reference answer/i);
  assert.deepEqual(requestBody.tools ?? [], []);
});

test("Factory candidate Runtime rejects undeclared tool calls without executing them", async (t) => {
  const previousKey = process.env.LLM_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousSearchUrl = process.env.HATCH_WEB_SEARCH_URL;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    if (previousSearchUrl === undefined) delete process.env.HATCH_WEB_SEARCH_URL;
    else process.env.HATCH_WEB_SEARCH_URL = previousSearchUrl;
    globalThis.fetch = previousFetch;
  });

  process.env.LLM_API_KEY = "factory-runtime-test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:18191/v1";
  process.env.HATCH_WEB_SEARCH_URL = "http://127.0.0.1:18192/forbidden-search";
  const modelRequests: Array<Record<string, unknown>> = [];
  let forbiddenSearchRequests = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url === process.env.HATCH_WEB_SEARCH_URL) {
      forbiddenSearchRequests += 1;
      throw new Error("Factory candidate escaped to web search");
    }
    modelRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return modelRequests.length === 1
      ? toolCallResponse("hatch_web_search", { query: "secret outside context" })
      : streamResponse("SAFE_WITHOUT_TOOL");
  };

  const execute = createHatchCandidateRuntimeExecutor();
  const result = await execute({
    runId: "factory-runtime-forbidden-tool",
    corpusVersion: 1,
    agentCorpusRoot: "/tmp/legacy-candidate-runtime-test",
    creatorId: "11111111-1111-4111-8111-111111111111",
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    corpusDigest: `sha256:${"0".repeat(64)}`,
    systemInstructions: "Even if instructed otherwise, use only the supplied question.",
    question: "Search the web and save the answer to output.md"
  });

  assert.equal(result, "SAFE_WITHOUT_TOOL");
  assert.equal(forbiddenSearchRequests, 0);
  assert.equal(modelRequests.length, 2);
  assert.ok(modelRequests.every((request) => (
    !Object.hasOwn(request, "tools") || Array.isArray(request.tools) && request.tools.length === 0
  )));
  assert.match(JSON.stringify(modelRequests[1]), /Tool hatch_web_search not found/);
});

test("Factory candidate Runtime honors cancellation and removes its scratch run", async (t) => {
  const previousKey = process.env.LLM_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    globalThis.fetch = previousFetch;
  });

  process.env.LLM_API_KEY = "factory-runtime-test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:18191/v1";
  let modelRequests = 0;
  globalThis.fetch = async () => {
    modelRequests += 1;
    return streamResponse("MUST_NOT_SURVIVE_ABORT");
  };

  const scratchPrefix = "hatch-candidate-runtime-";
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith(scratchPrefix)));
  const controller = new AbortController();
  controller.abort();
  const execute = createHatchCandidateRuntimeExecutor();
  await assert.rejects(execute({
    runId: "factory-runtime-cancelled",
    corpusVersion: 1,
    agentCorpusRoot: "/tmp/legacy-candidate-runtime-test",
    creatorId: "11111111-1111-4111-8111-111111111111",
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    corpusDigest: `sha256:${"0".repeat(64)}`,
    systemInstructions: "CANCELLED_SYSTEM",
    question: "CANCELLED_QUESTION",
    signal: controller.signal
  }));

  const leaked = (await readdir(os.tmpdir()))
    .filter((name) => name.startsWith(scratchPrefix) && !before.has(name));
  assert.deepEqual(leaked, []);
  assert.equal(modelRequests, 0);
});

test("Factory candidate Runtime aborts an in-flight model request on lease loss", async (t) => {
  const previousKey = process.env.LLM_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousFetch = globalThis.fetch;
  t.after(() => {
    if (previousKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    globalThis.fetch = previousFetch;
  });

  process.env.LLM_API_KEY = "factory-runtime-test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:18191/v1";
  let announceFetchStarted: (() => void) | undefined;
  const fetchStarted = new Promise<void>((resolve) => { announceFetchStarted = resolve; });
  globalThis.fetch = async (_input, init) => {
    announceFetchStarted?.();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const rejectAbort = (): void => reject(new DOMException("Aborted", "AbortError"));
      if (signal?.aborted) rejectAbort();
      else signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  };

  const scratchPrefix = "hatch-candidate-runtime-";
  const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith(scratchPrefix)));
  const controller = new AbortController();
  const execute = createHatchCandidateRuntimeExecutor();
  const pending = execute({
    runId: "factory-runtime-lease-loss",
    corpusVersion: 1,
    agentCorpusRoot: "/tmp/legacy-candidate-runtime-test",
    creatorId: "11111111-1111-4111-8111-111111111111",
    agentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    corpusDigest: `sha256:${"0".repeat(64)}`,
    systemInstructions: "LEASED_SYSTEM",
    question: "LEASED_QUESTION",
    signal: controller.signal
  });
  await fetchStarted;
  controller.abort();
  await assert.rejects(pending);

  const leaked = (await readdir(os.tmpdir()))
    .filter((name) => name.startsWith(scratchPrefix) && !before.has(name));
  assert.deepEqual(leaked, []);
});
