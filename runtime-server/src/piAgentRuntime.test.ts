import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { toolEventBase, type RunContext } from "./agentRuntime.js";
import { RuntimeAssetStore } from "./assetStore.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import { TASK_START_MESSAGE_CONTENT, type ConversationMessage, type OutboundMessage, type RunStart } from "./protocol.js";
import { discoverSkills, renderSkillsSection } from "./skills.js";
import { persistToolMessage } from "./toolMessage.js";

test("committed user and tool images reach repeated provider requests without asset reads", async (t) => {
  const originalProfile = process.env.HATCH_LLM_PROFILE;
  const originalKey = process.env.LLM_API_KEY;
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
  process.env.LLM_API_KEY = "test-only";
  t.after(() => {
    if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE;
    else process.env.HATCH_LLM_PROFILE = originalProfile;
    if (originalKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalKey;
  });
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).messages);
    return new Response('data: {"id":"test","object":"chat.completion.chunk","created":1,"model":"kimi-k2.6","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } });
  });
  let reads = 0;
  const image = { type: "image" as const, data: "c3RhYmxlLWltYWdl", mimeType: "image/png" };
  const toolImage = { type: "image" as const, data: "cmVuZGVyZWQtcGFnZQ==", mimeType: "image/png" };
  const input = { type: "client.message", run_id: "fixed-image", conversation_id: "fixed-image",
    message: { role: "user", content: "continue" } } as RunStart;
  const context = {
    state: { status: "running" },
    messages: [{ role: "user", content: "earlier image", model_images: [image],
      attachments: [{ kind: "asset", asset_id: "unavailable", media_type: "image/png", display_name: "image.png" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "read-page", type: "function",
        function: { name: "file_read", arguments: '{"path":"rendered/page.png"}' } }] },
      persistToolMessage({ role: "toolResult", toolCallId: "read-page", toolName: "file_read",
        timestamp: 1, isError: false, content: [{ type: "text", text: "Rendered page" }, toolImage] }),
      { ...input.message, model_images: [image] }],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    clientTools: [], assetStore: { readBase64: async () => { reads++; throw new Error("asset unavailable"); } }
  } as unknown as RunContext;
  for (let run = 0; run < 2; run++) {
    const events = [];
    for await (const event of new PiAgentRuntime({ toolDefinitions: [] }).run(input, context)) events.push(event);
    assert.ok(events.some((event) => event.type === "turn.completed"));
  }
  assert.equal(reads, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.match(JSON.stringify(requests[0]), /data:image\/png;base64,c3RhYmxlLWltYWdl/);
  assert.match(JSON.stringify(requests[0]), /data:image\/png;base64,cmVuZGVyZWQtcGFnZQ==/,
    "a persisted image-tool result must reach the provider as image content, not only a filename");
});

test("task_start keeps its marked history turn while omitting the marker from the provider request", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalProfile = process.env.HATCH_LLM_PROFILE;
  const originalApiKey = process.env.LLM_API_KEY;
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
  process.env.LLM_API_KEY = "task-start-test-key";
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const chunks = [
      {
        id: "chatcmpl-task-start",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.6",
        choices: [{ index: 0, delta: { role: "assistant", content: "Task started." }, finish_reason: null }]
      },
      {
        id: "chatcmpl-task-start",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.6",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof globalThis.fetch;

  try {
    const input = {
      type: "client.message",
      run_id: "run_task_start",
      conversation_id: "conversation_task_start",
      task_start: true,
      message: { role: "user", content: TASK_START_MESSAGE_CONTENT }
    } as RunStart;
    const events = [];
    const runtime = new PiAgentRuntime({ toolDefinitions: [] });
    for await (const event of runtime.run(input, {
      state: { status: "running" },
      // The current marked row is part of the canonical assembled history.
      messages: [{ role: "user", content: TASK_START_MESSAGE_CONTENT, kind: "task_start" }],
      sessionSkills: {
        records: [],
        visibleRecords: [],
        rendered: {
          section: "Available runtime guidance.",
          report: {
            total_count: 1,
            included_count: 1,
            omitted_count: 0,
            truncated_description_chars: 0,
            truncated_description_count: 0
          },
          aliases: {}
        }
      },
      clientTools: []
    } as unknown as RunContext)) {
      events.push(event);
    }

    assert.ok(events.some((event) => event.type === "turn.completed"));
    assert.equal(requests.length, 1);
    const messages = requests[0]?.messages;
    assert.ok(Array.isArray(messages));
    const userMessages = messages.filter((message) => message && typeof message === "object" && message.role === "user");
    assert.ok(userMessages.length > 0);
    assert.ok(userMessages.every((message) => typeof message.content === "string" && message.content.trim().length > 0));
    assert.equal(userMessages.at(-1)?.content, TASK_START_MESSAGE_CONTENT);
    assert.ok(userMessages.every((message) => !("kind" in message)));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE;
    else process.env.HATCH_LLM_PROFILE = originalProfile;
    if (originalApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalApiKey;
  }
});

test("Pi runtime preserves legacy DOCX references without reading or re-parsing asset bytes", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalProfile = process.env.HATCH_LLM_PROFILE;
  const originalApiKey = process.env.LLM_API_KEY;
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-pi-asset-"));
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
  process.env.LLM_API_KEY = "asset-test-key";
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const chunks = [
      {
        id: "chatcmpl-asset",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.6",
        choices: [{ index: 0, delta: { role: "assistant", content: "Document received." }, finish_reason: null }]
      },
      {
        id: "chatcmpl-asset",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.6",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }
    ];
    return new Response(
      `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } }
    );
  }) as typeof globalThis.fetch;

  try {
    const bytes = minimalDocx("Uploaded document text");
    const attachment = {
      kind: "asset" as const,
      attachment_id: "drop_docx_1",
      asset_id: "asset_docx_1",
      display_name: "brief.docx",
      media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      source_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      data_base64: bytes.toString("base64")
    };
    const assetStore = new RuntimeAssetStore(root);
    const reference = await assetStore.put(attachment);
    let documentReads = 0;
    assetStore.read = async () => {
      documentReads += 1;
      throw new Error("History loading must not read document bytes");
    };
    const skillRecords = await discoverSkills();
    const input = {
      type: "client.message",
      run_id: "run_docx_asset",
      conversation_id: "conversation_docx_asset",
      message: { role: "user", content: "Summarize the upload.", attachments: [reference] }
    } as RunStart;
    const events = [];
    for await (const event of new PiAgentRuntime({ toolDefinitions: [] }).run(input, {
      state: { status: "running" },
      messages: [input.message],
      sessionSkills: {
        records: skillRecords,
        visibleRecords: skillRecords,
        rendered: renderSkillsSection(skillRecords)
      },
      clientTools: [],
      assetStore
    } as unknown as RunContext)) {
      events.push(event);
    }

    assert.ok(events.some((event) => event.type === "turn.completed"));
    assert.ok(events.some((event) => event.type === "skill.activated" && event.reason === "attachment"));
    const messages = requests[0]?.messages as Array<Record<string, unknown>>;
    const uploadedMessage = messages.find((message) => message.role === "user" && Array.isArray(message.content));
    assert.ok(uploadedMessage);
    const uploadedText = (uploadedMessage.content as Array<Record<string, unknown>>)
      .filter((part) => part.type === "text")
      .map((part) => String(part.text ?? ""))
      .join("\n");
    assert.match(uploadedText, /brief\.docx/);
    assert.match(uploadedText, /asset_docx_1/);
    assert.doesNotMatch(uploadedText, /Uploaded document text|hatch_asset_text/);
    assert.equal(documentReads, 0);

    const followUp = {
      ...input,
      run_id: "run_docx_followup",
      message: { role: "user", content: "Continue with the saved conversation." }
    } as RunStart;
    for (let replay = 0; replay < 2; replay += 1) {
      const replayEvents = [];
      for await (const event of new PiAgentRuntime({ toolDefinitions: [] }).run(followUp, {
        state: { status: "running" },
        messages: [input.message, followUp.message],
        sessionSkills: {
          records: skillRecords,
          visibleRecords: skillRecords,
          rendered: renderSkillsSection(skillRecords)
        },
        clientTools: [],
        assetStore
      } as unknown as RunContext)) replayEvents.push(event);
      assert.ok(replayEvents.some((event) => event.type === "turn.completed"));
      assert.ok(!replayEvents.some((event) => event.type === "skill.activated"),
        "historical attachments must not implicitly activate today's Skill");
    }
    assert.equal(documentReads, 0);
    assert.deepEqual(requests[1]?.messages, requests[2]?.messages,
      "repeated continuation of the same committed boundary must keep its provider messages");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE;
    else process.env.HATCH_LLM_PROFILE = originalProfile;
    if (originalApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalApiKey;
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["invalid_resource", "execution_error", "unknown_tool"] as const) {
  const toolName = scenario === "unknown_tool" ? "unknown_tool" : "file_read";
  test(`Pi loop ${scenario === "invalid_resource" ? "preserves an invalid Skill resource error and lets the model recover" : scenario === "execution_error" ? "preserves native Pi exception text when result details are empty and recovers" : "aborts a genuinely unregistered tool without another provider turn"}`, async (t) => {
    const originalProfile = process.env.HATCH_LLM_PROFILE;
    const originalKey = process.env.LLM_API_KEY;
    process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
    process.env.LLM_API_KEY = "tool-classification-test-only";
    t.after(() => {
      if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE;
      else process.env.HATCH_LLM_PROFILE = originalProfile;
      if (originalKey === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = originalKey;
    });

    // The provider and failing client broker are test doubles only. Resource
    // resolution, Pi's registry, error handling and model loop are real paths.
    // An absent catalog entry stays unauthorized with or without activation.
    const args = { path: scenario === "execution_error" ? "reference.txt" : "skill://not-in-authorized-catalog/references/missing.md" };
    const toolCallId = `classification-${scenario}`;
    const input = {
      type: "client.message", run_id: toolCallId, conversation_id: toolCallId,
      message: { role: "user", content: "Read the reference; if unavailable, explain the limitation." }
    } as RunStart;
    let clientCalls = 0;
    const persisted: ConversationMessage[] = [];
    const context = {
      state: { status: "running" }, messages: [input.message],
      sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
      clientTools: ["file_read"],
      persistModelMessage: async (message: ConversationMessage) => { persisted.push(message); },
      clientBroker: { execute: async () => {
        clientCalls++;
        throw new Error(scenario === "execution_error" ? "EACCES: reference.txt access denied by test broker" : "Unauthorized Skill URI reached the client");
      } }
    } as unknown as RunContext;
    let resourceError: Error | undefined;
    if (scenario === "execution_error") {
      resourceError = new Error("EACCES: reference.txt access denied by test broker");
      assert.equal(toolEventBase(input, toolCallId, toolName, args, [], [], {}, context).error, undefined,
        "this case must obtain its error from Pi's native result.content, not event-base resolution");
    } else if (scenario === "invalid_resource") {
      assert.throws(() => toolEventBase(input, toolCallId, toolName, args, [], [], {}, context), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /skill/i);
        assert.doesNotMatch(error.message, /unknown (?:Pi )?tool/i);
        resourceError = error;
        return true;
      });
    }

    const requests: Array<{ messages: Array<{ role: string; content: unknown; tool_call_id?: string }>; tools: Array<{ function: { name: string } }> }> = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      assert.ok(requests.length <= 2, "the recovery must finish in the next provider turn");
      const first = requests.length === 1;
      const chunks = [{
        id: toolCallId, object: "chat.completion.chunk", created: 1, model: "kimi-k2.6",
        choices: [{ index: 0, delta: first
          ? { role: "assistant", tool_calls: [{ index: 0, id: toolCallId, type: "function",
            function: { name: toolName, arguments: JSON.stringify(args) } }] }
          : { role: "assistant", content: "The reference is unavailable; I can continue without it." }, finish_reason: null }]
      }, {
        id: toolCallId, object: "chat.completion.chunk", created: 1, model: "kimi-k2.6",
        choices: [{ index: 0, delta: {}, finish_reason: first ? "tool_calls" : "stop" }]
      }];
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } });
    });
    const runtime = new PiAgentRuntime({ toolDefinitions: [{ type: "function", function: {
      name: "file_read", description: "Read an authorized file or Skill resource",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    } }] });
    const events: OutboundMessage[] = [];
    const consume = async () => {
      for await (const event of runtime.run(input, context)) events.push(event);
    };
    if (toolName === "file_read") await consume();
    else await assert.rejects(consume, /^Error: Unknown Pi tool: unknown_tool$/);

    assert.deepEqual(requests[0]?.tools.map((tool) => tool.function.name), ["file_read"],
      "file_read must really be registered, while unknown_tool must not be");
    const requested = events.find((event) => event.type === "tool_call.delta" && event.status === "requested");
    const failed = events.find((event) => event.type === "tool_call.delta" && event.status === "failed");
    assert.ok(requested?.type === "tool_call.delta");
    assert.ok(failed?.type === "tool_call.delta");
    assert.equal(failed.tool_call_id, toolCallId);
    assert.equal(failed.name, toolName);
    assert.deepEqual(failed.arguments, args);
    assert.ok(!events.some((event) => event.type === "tool_call.delta"
      && event.tool_call_id === toolCallId && event.status === "completed"),
    "a failed tool must never be presented as completed");
    assert.equal(clientCalls, scenario === "execution_error" ? 1 : 0,
      "only the ordinary file request may reach the test client broker");
    const persistedFailure = persisted.find((message) => message.role === "tool" && message.tool_call_id === toolCallId);
    assert.ok(persistedFailure, "Pi must persist the failed tool result");
    assert.equal(persistedFailure.tool_is_error, true, "Pi's native toolResult must be marked isError, not a successful result containing an error object");
    if (toolName === "file_read") {
      assert.ok(resourceError);
      if (scenario === "invalid_resource") {
        assert.deepEqual(requested.error, { code: "invalid_tool_call", message: resourceError.message });
        assert.deepEqual(failed.error, requested.error, "failed must retain the original resource error, not replace it with a generic tool failure");
      } else {
        assert.equal(requested.error, undefined);
        assert.deepEqual(failed.error, { code: "tool_failed", message: resourceError.message },
          "native Pi exception text must not be replaced with empty result details");
      }
      assert.equal(requests.length, 2);
      const result = requests[1]!.messages.find((message) => message.role === "tool" && message.tool_call_id === toolCallId);
      assert.ok(result, "the next model request must contain the failed tool result");
      assert.ok(JSON.stringify(result.content).includes(resourceError.message), "the model must receive the actual resource error to recover");
      assert.ok(events.some((event) => event.type === "assistant.delta" && event.delta.kind === "text"
        && event.delta.content.includes("continue without it")));
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    } else {
      assert.equal(requests.length, 1, "a truly unknown tool must abort before another model request");
      assert.ok(!events.some((event) => event.type === "turn.completed"));
    }
  });
}

function minimalDocx(text: string): Buffer {
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),
    "_rels/.rels": strToU8("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"),
    "word/document.xml": strToU8(documentXml)
  }));
}
