import assert from "node:assert/strict";
import test from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { persistToolMessage, restoreToolMessage } from "./toolMessage.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeStore } from "./store.js";
import { runtimeMessagesTranscript } from "./compaction.js";

test("canonical image tool record survives file-store reopening without rereading an asset", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-tool-history-"));
  try {
    const message = persistToolMessage({ role: "toolResult", toolCallId: "image-call", toolName: "file_read",
      isError: false, timestamp: 1, content: [{ type: "text", text: "page one" },
        { type: "image", data: "cGFnZQ==", mimeType: "image/png" }] });
    await new RuntimeStore(directory).append({ type: "conversation.model_message",
      conversation_id: "conversation", run_id: "run", message });
    const recovered = await new RuntimeStore(directory).readConversation("conversation");
    assert.deepEqual(recovered, [message]);
    assert.deepEqual(restoreToolMessage(recovered[0]!).content, message.tool_content);
    const transcript = runtimeMessagesTranscript(recovered);
    assert.ok(transcript.includes("page one"));
    assert.ok(!transcript.includes("cGFnZQ=="), "binary must not be rendered into a text transcript");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("tool history preserves ordered image/text blocks and errors without a second text copy", () => {
  const original: ToolResultMessage = {
    role: "toolResult", toolCallId: "call", toolName: "file_read", timestamp: 123, isError: true,
    content: [{ type: "text", text: "a".repeat(60_000) },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }, { type: "text", text: "after image" }]
  };
  const stored = persistToolMessage(original);
  assert.equal(stored.content, null);
  const reloaded = JSON.parse(JSON.stringify(stored));
  assert.deepEqual(restoreToolMessage(reloaded).content, original.content);
  assert.equal(restoreToolMessage(reloaded).isError, true);
  assert.deepEqual(restoreToolMessage(reloaded), restoreToolMessage(reloaded));
  original.content.length = 0;
  assert.equal(stored.tool_content?.length, 3, "stored blocks must not alias live Pi output");
});

test("old text-only tool history is readable without truncating or reinterpreting it", () => {
  const restored = restoreToolMessage({ content: "legacy result", tool_call_id: "old", tool_name: "shell_exec" });
  assert.deepEqual(restored.content, [{ type: "text", text: "legacy result" }]);
  assert.equal(restored.isError, false);
});
