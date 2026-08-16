import assert from "node:assert/strict";
import test from "node:test";
import { KIMI_MODEL as PROVIDER_KIMI_MODEL } from "./kimiProvider.js";
import {
  FACTORY_LLM_MODEL,
  FACTORY_LLM_CONTEXT_WINDOW,
  FACTORY_LLM_MAX_COMPLETION_TOKENS,
  FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS,
  FACTORY_PROVIDER_CONFIGURATION_MESSAGE,
  FACTORY_PROVIDER_QUOTA_MESSAGE,
  FACTORY_PROVIDER_TRANSIENT_MESSAGE,
  createFactoryLlmModel,
  createFactoryLlmPromptRunner
} from "./creatorLearning/factoryLlm.js";
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

test("Factory Evidence/Eval/Corpus prompt gateway uses dedicated Kimi K2.6 high-reasoning profile", async (t) => {
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
  assert.equal(body.reasoning_effort, "high");
  // Kimi K2.6 only accepts the provider-compatible automatic choice while
  // thinking is enabled; the host submission FSM still requires a complete
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
  assert.equal("thinking" in body, false);
  assert.equal("temperature" in body, false);
  assert.equal("top_p" in body, false);
  assert.match(JSON.stringify(body.messages), /FACTORY_LLM_SYSTEM_MARKER/);
  assert.match(JSON.stringify(body.messages), /FACTORY_LLM_PROMPT_MARKER/);

  const factoryModel = createFactoryLlmModel({ env: { OPENAI_BASE_URL: process.env.OPENAI_BASE_URL } });
  assert.equal(factoryModel.id, FACTORY_LLM_MODEL);
  assert.equal(factoryModel.contextWindow, FACTORY_LLM_CONTEXT_WINDOW);
  assert.equal(factoryModel.maxTokens, FACTORY_LLM_MAX_COMPLETION_TOKENS);
  assert.equal(factoryModel.reasoning, true);
  assert.equal(factoryModel.compat?.supportsReasoningEffort, true);
  assert.equal(factoryModel.compat?.supportsStrictMode, true);
  assert.equal(factoryModel.compat?.maxTokensField, "max_completion_tokens");
  assert.equal(factoryModel.compat?.thinkingFormat, "openai");
  assert.deepEqual(PI_FACTORY_MODEL, { provider: "moonshot", model: FACTORY_LLM_MODEL });

  assert.equal(KIMI_MODEL, "kimi-k2.6");
  assert.equal(PROVIDER_KIMI_MODEL, "kimi-k2.6");
  assert.equal(
    createKimiModel({ env: { OPENAI_BASE_URL: "https://api.moonshot.ai/v1" } }).id,
    "kimi-k2.6"
  );
});

test("Factory Kimi K2.6 rejects a length-truncated response even when it contains text", async () => {
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

test("Factory Kimi K2.6 has a hard wall-clock deadline in addition to HTTP idle timeout", async () => {
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
    new RegExp(FACTORY_PROVIDER_TRANSIENT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  );
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.code, "provider_error");
  assert.ok(FACTORY_LLM_WALL_CLOCK_TIMEOUT_MS > 0);
});

test("Factory Kimi K2.6 classifies quota exhaustion and never rethrows provider account JSON", async () => {
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
      assert.ok(error instanceof Error);
      assert.equal(error.message, FACTORY_PROVIDER_QUOTA_MESSAGE);
      assert.equal(error.message.includes(organizationId), false);
      assert.equal(error.message.includes(keyId), false);
      assert.equal(error.message.includes("exceeded_current_quota_error"), false);
      assert.equal(error.message.includes("{"), false);
      return true;
    }
  );
  assert.equal(telemetry.length, 1);
  assert.equal(telemetry[0]!.code, "provider_quota");
});

test("Factory Kimi K2.6 sanitizes transient and configuration provider errors while preserving retry guidance", async () => {
  const cases = [
    {
      status: 503,
      body: { error: { message: "upstream temporarily unavailable for org-secret", type: "server_error" } },
      expected: FACTORY_PROVIDER_TRANSIENT_MESSAGE
    },
    {
      status: 401,
      body: { error: { message: "invalid credential ak-secret-key-id", type: "authentication_error" } },
      expected: FACTORY_PROVIDER_CONFIGURATION_MESSAGE
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
        assert.ok(error instanceof Error);
        assert.equal(error.message, row.expected);
        assert.match(error.message, /retry this stage/i);
        assert.equal(error.message.includes("org-secret"), false);
        assert.equal(error.message.includes("ak-secret-key-id"), false);
        assert.equal(error.message.includes("{"), false);
        return true;
      }
    );
    assert.equal(telemetry.length, 1);
    assert.equal(telemetry[0]!.code, "provider_error");
  }
});
