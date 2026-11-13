import assert from "node:assert/strict";
import test from "node:test";
import { KIMI_MODEL as PROVIDER_KIMI_MODEL } from "./kimiProvider.js";
import {
  FACTORY_LLM_MODEL,
  FACTORY_LLM_CONTEXT_WINDOW,
  FACTORY_LLM_MAX_COMPLETION_TOKENS,
  FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS,
  createFactoryLlmModel,
  createFactoryLlmPromptRunner
} from "./creatorLearning/factoryLlm.js";
import { UpstreamError } from "./errors/upstream.js";
import type { FactoryPromptFailureTelemetry } from "./creatorLearning/types.js";
import { PI_FACTORY_MODEL, runFactoryPromptWithPi } from "./creatorLearning/piGateway.js";
import { KIMI_MODEL, createKimiModel } from "./piModel.js";

function streamResponse(text: string, finishReason: "stop" | "length" = "stop"): Response {
  const chunks = [
    {
      id: "chatcmpl-factory-k3",
      object: "chat.completion.chunk",
      created: 1,
      model: FACTORY_LLM_MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]
    },
    {
      id: "chatcmpl-factory-k3",
      object: "chat.completion.chunk",
      created: 1,
      model: FACTORY_LLM_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    }
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function toolStreamResponse(
  toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
): Response {
  const chunks = [
    {
      id: "chatcmpl-factory-k3-tools",
      object: "chat.completion.chunk",
      created: 1,
      model: FACTORY_LLM_MODEL,
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: toolCalls.map((call, index) => ({
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) }
          }))
        },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl-factory-k3-tools",
      object: "chat.completion.chunk",
      created: 1,
      model: FACTORY_LLM_MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 }
    }
  ];
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

test("Factory Evidence/Eval/Corpus prompt gateway uses dedicated Kimi K3.1 low-reasoning-effort profile", async (t) => {
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

  process.env.LLM_API_KEY = "factory-k3-test-key";
  process.env.OPENAI_BASE_URL = "https://api.moonshot.ai/v1";
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const responses = [
    toolStreamResponse([
      {
        id: "submit-evidence",
        name: "submit_evidence_section",
        arguments: { section: "Product evidence", markdown: "FACTORY_LLM_RESULT" }
      },
      { id: "finalize-evidence", name: "finalize_evidence", arguments: {} }
    ])
  ];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      init: init ?? {}
    });
    return responses.shift() ?? streamResponse("unexpected extra turn");
  };

  const output = await runFactoryPromptWithPi({
    purpose: "evidence.extract",
    systemPrompt: "FACTORY_LLM_SYSTEM_MARKER",
    prompt: "FACTORY_LLM_PROMPT_MARKER",
    outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] }
  });

  assert.match(output, /## Product evidence\n\nFACTORY_LLM_RESULT/);
  assert.equal(calls.length, 1);
  const request = calls[0]!;
  assert.equal(request.url, "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer factory-k3-test-key");

  const body = JSON.parse(String(request.init.body)) as Record<string, unknown>;
  assert.equal(body.model, FACTORY_LLM_MODEL);
  assert.equal("thinking" in body, false);
  assert.equal(body.reasoning_effort, "low");
  // Kimi K3.1 only accepts the provider-compatible automatic choice while
  // it reasons; the host submission FSM still requires a complete
  // tool batch and finalizer before accepting output.
  assert.equal(body.tool_choice, "auto");
  // Pi reserves the prompt/context tokens before sending the request, so the
  // provider budget is bounded by (and may be slightly below) the profile cap.
  const sentMaxCompletionTokens = body.max_completion_tokens;
  assert.equal(typeof sentMaxCompletionTokens, "number");
  assert.ok((sentMaxCompletionTokens as number) > 0);
  assert.ok((sentMaxCompletionTokens as number) <= FACTORY_LLM_MAX_COMPLETION_TOKENS);
  assert.equal(
    (body.tools as Array<{ function: { strict?: boolean } }>).every((tool) => tool.function.strict === true),
    true
  );
  assert.equal("max_tokens" in body, false);
  assert.equal("temperature" in body, false);
  assert.equal("top_p" in body, false);
  assert.match(JSON.stringify(body.messages), /FACTORY_LLM_SYSTEM_MARKER/);
  assert.match(JSON.stringify(body.messages), /FACTORY_LLM_PROMPT_MARKER/);

  const factoryModel = createFactoryLlmModel({ env: { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } });
  assert.equal(factoryModel.id, FACTORY_LLM_MODEL);
  assert.equal(factoryModel.contextWindow, FACTORY_LLM_CONTEXT_WINDOW);
  assert.equal(factoryModel.maxTokens, FACTORY_LLM_MAX_COMPLETION_TOKENS);
  assert.equal(factoryModel.reasoning, true);
  assert.equal(factoryModel.compat?.supportsReasoningEffort, false);
  assert.equal(factoryModel.compat?.supportsStrictMode, true);
  assert.equal(factoryModel.compat?.maxTokensField, "max_completion_tokens");
  assert.equal(factoryModel.compat?.thinkingFormat, "deepseek");
  assert.deepEqual(PI_FACTORY_MODEL, { provider: "moonshot", model: FACTORY_LLM_MODEL });

  assert.equal(KIMI_MODEL, "kimi-k3.1-pro");
  assert.equal(PROVIDER_KIMI_MODEL, "kimi-k3.1-pro");
  assert.equal(
    createKimiModel({ env: { OPENAI_BASE_URL: "https://api.moonshot.ai/v1" } }).id,
    "kimi-k3.1-pro"
  );
});

test("Factory can use an explicitly selected DeepSeek profile without Kimi payload fields", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const runner = createFactoryLlmPromptRunner({
    env: {
      HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash",
      DEEPSEEK_API_KEY: "factory-deepseek-test-key"
    },
    fetch: async (input, init) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init: init ?? {} });
      return toolStreamResponse([
        {
          id: "submit-evidence",
          name: "submit_evidence_section",
          arguments: { section: "Product evidence", markdown: "DEEPSEEK_FACTORY_RESULT" }
        },
        { id: "finalize-evidence", name: "finalize_evidence", arguments: {} }
      ]);
    }
  });

  const output = await runner({
    purpose: "evidence.extract",
    systemPrompt: "system",
    prompt: "prompt",
    outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] }
  });

  assert.match(output, /DEEPSEEK_FACTORY_RESULT/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.deepseek.com/chat/completions");
  const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
  assert.equal(body.model, "deepseek-v4-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.tool_choice, "required");
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.max_tokens !== undefined, true);
  assert.equal(new Headers(calls[0]!.init.headers).get("authorization"), "Bearer factory-deepseek-test-key");
  const deepseekModel = createFactoryLlmModel({ env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash", DEEPSEEK_API_KEY: "test" } });
  assert.equal(deepseekModel.id, "deepseek-v4-flash");
  assert.equal(deepseekModel.provider, "deepseek");
  assert.equal(deepseekModel.baseUrl, "https://api.deepseek.com");
});

test("Factory Kimi K3.1 rejects a length-truncated response even when it contains text", async () => {
  const runner = createFactoryLlmPromptRunner({
    apiKey: "factory-k3-length-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    fetch: async () => streamResponse("PARTIAL_OUTPUT_MUST_NOT_BE_ACCEPTED", "length")
  });

  await assert.rejects(
    () => runner({
      purpose: "evidence.extract",
      systemPrompt: "system",
      prompt: "prompt",
      outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] }
    }),
    /did not complete: length/
  );
});

test("Factory Kimi K3.1 has a hard wall-clock deadline in addition to HTTP idle timeout", async () => {
  const controller = new AbortController();
  const telemetry: FactoryPromptFailureTelemetry[] = [];
  const runner = createFactoryLlmPromptRunner({
    apiKey: "factory-k3-wall-clock-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    maxRetries: 0,
    wallClockTimeoutMs: 25,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      const abort = () => reject(new DOMException("Request aborted", "AbortError"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    })
  });

  await assert.rejects(
    () => runner({
      purpose: "evidence.extract",
      systemPrompt: "system",
      prompt: "prompt",
      outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] },
      signal: controller.signal,
      reportFailureTelemetry: (item) => telemetry.push(item)
    }),
    (error: unknown) => error instanceof UpstreamError && error.kind === "transient"
  );
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.code, "provider_error");
  assert.ok(FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS > 0);
});

test("Factory Kimi K3.1 classifies quota exhaustion and never rethrows provider account JSON", async () => {
  const organizationId = "org-fefa47391cab4497943886467d066f97";
  const keyId = "ak-fbauirzdz8n111dq1iu1";
  const telemetry: FactoryPromptFailureTelemetry[] = [];
  const runner = createFactoryLlmPromptRunner({
    apiKey: "factory-k3-quota-test-key",
    baseUrl: "https://api.moonshot.ai/v1",
    maxRetries: 0,
    fetch: async () => new Response(JSON.stringify({
      error: {
        message: `Your account ${organizationId} <${keyId}> is suspended due to insufficient balance`,
        type: "exceeded_current_quota_error"
      }
    }), {
      status: 429,
      headers: { "content-type": "application/json" }
    })
  });

  await assert.rejects(
    () => runner({
      purpose: "evidence.extract",
      systemPrompt: "system",
      prompt: "prompt",
      outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] },
      reportFailureTelemetry: (row) => telemetry.push(row)
    }),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.kind, "quota");
      assert.equal(error.message.includes(organizationId), false);
      assert.equal(error.message.includes(keyId), false);
      return true;
    }
  );
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.code, "provider_quota");
});

test("Factory Kimi K3.1 sanitizes transient and configuration provider errors while preserving retry guidance", async () => {
  const cases = [
    {
      status: 503,
      body: { error: { message: "upstream temporarily unavailable for org-secret", type: "server_error" } },
      expected: "transient"
    },
    {
      status: 401,
      body: { error: { message: "invalid credential ak-secret-key-id", type: "authentication_error" } },
      expected: "configuration"
    }
  ];

  for (const row of cases) {
    const telemetry: FactoryPromptFailureTelemetry[] = [];
    const runner = createFactoryLlmPromptRunner({
      apiKey: "factory-k3-provider-error-test-key",
      baseUrl: "https://api.moonshot.ai/v1",
      maxRetries: 0,
      fetch: async () => new Response(JSON.stringify(row.body), {
        status: row.status,
        headers: { "content-type": "application/json" }
      })
    });
    await assert.rejects(
      () => runner({
        purpose: "evidence.extract",
        systemPrompt: "system",
        prompt: "prompt",
        outputContract: { kind: "evidence_ledger", requiredSections: ["Product evidence"] },
        reportFailureTelemetry: (item) => telemetry.push(item)
      }),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamError);
        assert.equal(error.kind, row.expected);
        assert.equal(error.message.includes("org-secret"), false);
        assert.equal(error.message.includes("ak-secret-key-id"), false);
        return true;
      }
    );
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.code, "provider_error");
  }
});

test("Factory provider classification does not mask private harness response errors", () => {
  assert.equal(
    UpstreamError.of(new Error("Factory Hatch harness rejected the Runtime response: turn failed during candidate execution")).kind,
    "unknown"
  );
});
