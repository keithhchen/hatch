import assert from "node:assert/strict";
import test from "node:test";
import {
  KIMI_DEFAULT_BASE_URL,
  KIMI_MODEL,
  createKimiAgent,
  createKimiAgentOptions,
  createKimiModel,
  createKimiStreamFn,
  createPiAgent,
  createPiModel,
  normalizeKimiBaseUrl
} from "./piModel.js";

function streamResponse(text = "pong"): Response {
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: KIMI_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    }
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("Kimi model is fixed to the official Moonshot profile", () => {
  assert.equal(normalizeKimiBaseUrl("https://api.moonshot.cn/v1/"), KIMI_DEFAULT_BASE_URL);
  assert.equal(normalizeKimiBaseUrl("https://api.moonshot.ai"), "https://api.moonshot.ai/v1");

  const model = createKimiModel({ env: { OPENAI_BASE_URL: "https://api.moonshot.cn/v1/" } });
  assert.equal(model.id, KIMI_MODEL);
  assert.equal(model.api, "openai-completions");
  assert.equal(model.provider, "moonshotai-cn");
  assert.equal(model.baseUrl, KIMI_DEFAULT_BASE_URL);
  assert.equal(model.reasoning, true);
  assert.deepEqual(model.compat, {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: "max_tokens",
    supportsStrictMode: false,
    thinkingFormat: "deepseek"
  });
});

test("AgentOptions resolves LLM_API_KEY and enables Kimi thinking", () => {
  const options = createKimiAgentOptions({
    env: { LLM_API_KEY: "  kimi-test-key  " },
    timeoutMs: 12_345
  });

  assert.equal(options.getApiKey?.("moonshotai-cn"), "kimi-test-key");
  assert.equal(options.initialState?.model?.id, KIMI_MODEL);
  assert.equal(options.initialState?.thinkingLevel, "high");
  assert.equal(typeof options.streamFn, "function");
});

test("Pi AI request uses Moonshot endpoint, key, model, and enabled thinking", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} });
    return streamResponse();
  };

  const agent = createKimiAgent({
    env: { LLM_API_KEY: "kimi-test-key" },
    fetch,
    timeoutMs: 8_000
  });
  await agent.prompt("Say pong");

  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.url, `${KIMI_DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer kimi-test-key");
  assert.ok(request.init.signal instanceof AbortSignal);

  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, KIMI_MODEL);
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "enabled" });
  // No Hatch delivery/turn cap is injected. Pi derives this from the Kimi
  // model profile and clamps it against the actual request context.
  assert.equal(typeof body.max_tokens, "number");
  assert.ok(Number(body.max_tokens) > 100_000);
  assert.equal(agent.state.messages.at(-1)?.role, "assistant");
});

test("finish_reason completes a non-closing SSE response without dropping abort support", async () => {
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  const fetch: typeof globalThis.fetch = async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { role: "assistant", content: "finished" }, finish_reason: "stop" }]
        })}\n\n`));
      },
      cancel() {
        upstreamCancelled = true;
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

  const agent = createKimiAgent({ env: { LLM_API_KEY: "kimi-test-key" }, fetch, timeoutMs: 10_000 });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      agent.prompt("Return the finished response"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Pi adapter waited for SSE close")), 500);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    agent.abort();
  }

  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.equal(final?.stopReason, "stop");
  assert.equal(upstreamCancelled, true);
});

test("stream timeout bounds an SSE body that never reaches a finish reason", async () => {
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  const fetch: typeof globalThis.fetch = async () => new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          choices: [{ index: 0, delta: { role: "assistant", content: "thinking" }, finish_reason: null }]
        })}\n\n`));
      },
      cancel() {
        upstreamCancelled = true;
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );

  const agent = createKimiAgent({ env: { LLM_API_KEY: "kimi-test-key" }, fetch, timeoutMs: 30 });
  const started = Date.now();
  await agent.prompt("Return a bounded response");

  const final = agent.state.messages.at(-1);
  assert.ok(Date.now() - started < 500, "stream timeout should be bounded");
  assert.equal(final?.role, "assistant");
  assert.equal(final?.stopReason, "error");
  assert.match(final?.errorMessage ?? "", /idle timeout after 30ms/);
  assert.equal(upstreamCancelled, true);
});

test("Agent.abort reaches the pi-ai request and preserves the aborted result", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    resolveStarted();
    await new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("Pi AI did not receive an abort signal"));
        return;
      }
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true }
      );
    });
    throw new Error("unreachable");
  };

  const agent = createKimiAgent({ env: { LLM_API_KEY: "kimi-test-key" }, fetch, timeoutMs: 10_000 });
  const run = agent.prompt("This request will be stopped");
  await started;
  agent.abort();
  await run;

  const final = agent.state.messages.at(-1);
  assert.equal(final?.role, "assistant");
  assert.equal(final?.stopReason, "aborted");
});

test("non-Moonshot endpoints and missing LLM_API_KEY fail closed", () => {
  assert.throws(
    () => createKimiModel({ baseUrl: "https://api.openai.com/v1" }),
    /official Moonshot/
  );
  assert.throws(
    () => createKimiStreamFn({ env: {} }),
    /Missing LLM_API_KEY/
  );
});

test("active DeepSeek profile uses its own model, endpoint, and credential", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} });
    return streamResponse("deepseek pong");
  };
  const env = {
    HATCH_LLM_PROFILE: "deepseek-v4-flash",
    DEEPSEEK_API_KEY: "deepseek-test-key",
    LLM_API_KEY: "unused-kimi-key"
  };

  const model = createPiModel({ env });
  assert.equal(model.id, "deepseek-v4-flash");
  assert.equal(model.provider, "deepseek");
  assert.equal(model.baseUrl, "https://api.deepseek.com");

  const agent = createPiAgent({ env, fetch, timeoutMs: 8_000 });
  await agent.prompt("Say pong");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.deepseek.com/chat/completions");
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer deepseek-test-key");
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("Kimi no-thinking profile sends the official disabled payload without temperature", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} });
    return streamResponse("fast pong");
  };
  const env = {
    HATCH_LLM_PROFILE: "kimi-k2.6-no-thinking",
    LLM_API_KEY: "kimi-test-key"
  };

  const model = createPiModel({ env });
  assert.equal(model.id, KIMI_MODEL);
  assert.equal(model.reasoning, false);
  const agent = createPiAgent({ env, fetch, timeoutMs: 8_000 });
  await agent.prompt("Say pong");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${KIMI_DEFAULT_BASE_URL}/chat/completions`);
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.model, KIMI_MODEL);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.temperature, undefined);
  assert.equal(body.reasoning_effort, undefined);
});

test("active profile rejects unknown names and missing provider credentials", () => {
  assert.throws(() => createPiModel({ env: { HATCH_LLM_PROFILE: "unknown" } }), /Unknown (?:Runtime )?HATCH_LLM_PROFILE/);
  assert.throws(
    () => createPiAgent({ env: { HATCH_LLM_PROFILE: "deepseek-v4-flash" } }),
    /Missing DEEPSEEK_API_KEY/
  );
});
