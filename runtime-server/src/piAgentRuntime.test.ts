import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import type { RunContext } from "./agentRuntime.js";
import { RuntimeAssetStore } from "./assetStore.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import { TASK_START_MESSAGE_CONTENT, type RunStart } from "./protocol.js";
import { discoverSkills, renderSkillsSection } from "./skills.js";

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

test("Pi runtime projects an uploaded DOCX asset into the Kimi prompt", async () => {
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
    assert.match(uploadedText, /Uploaded document text/);
    assert.match(uploadedText, /hatch_asset_text/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE;
    else process.env.HATCH_LLM_PROFILE = originalProfile;
    if (originalApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalApiKey;
    await rm(root, { recursive: true, force: true });
  }
});

function minimalDocx(text: string): Buffer {
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
  return Buffer.from(zipSync({
    "[Content_Types].xml": strToU8("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>"),
    "_rels/.rels": strToU8("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"),
    "word/document.xml": strToU8(documentXml)
  }));
}
