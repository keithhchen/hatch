import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeSystemPrompt, chatToolsForRun } from "./agentRuntime.js";
import { ClientToolCapabilityPolicy, parseInboundMessage, PROTOCOL_VERSION } from "./protocol.js";

test("Desktop inherits hello tools and Web message explicitly declares an empty list", () => {
  const hello = {
    type: "client.hello", protocol_version: PROTOCOL_VERSION,
    conversation_id: "conv_123", auth_token: "valid-token", local_tools: ["file_read"]
  };
  assert.equal(parseInboundMessage(hello).type, "client.hello");
  const message = {
    type: "client.message", conversation_id: "conv_123", run_id: "run_123",
    message: { role: "user", content: "Hello" }
  };
  assert.equal(parseInboundMessage(message).type, "client.message");
  const webMessage = parseInboundMessage({ ...message, local_tools: [] });
  const desktopMessage = parseInboundMessage(message);
  assert.equal(webMessage.type, "client.message");
  assert.equal(desktopMessage.type, "client.message");
  if (webMessage.type !== "client.message" || desktopMessage.type !== "client.message") throw new Error("Unexpected protocol variant");
  const policy = new ClientToolCapabilityPolicy(["file_read"]);
  assert.deepEqual(policy.forRun(webMessage.local_tools), []);
  assert.deepEqual(policy.forRun(desktopMessage.local_tools), ["file_read"]);
});

test("Web turns expose server tools without client workspace tools", () => {
  const webNames = chatToolsForRun([]).map(tool => tool.function.name);
  assert.ok(webNames.includes("Skill"));
  assert.ok(webNames.includes("file_read"));
  assert.ok(!webNames.includes("file_write"));
  assert.ok(!webNames.includes("shell_exec"));
  const desktopNames = chatToolsForRun(["file_read", "file_write", "shell_exec"]).map(tool => tool.function.name);
  assert.ok(desktopNames.includes("file_write"));
  assert.ok(desktopNames.includes("shell_exec"));
  assert.match(buildRuntimeSystemPrompt(undefined, undefined, undefined, []), /no local workspace/);
});
