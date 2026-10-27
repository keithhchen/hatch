import assert from "node:assert/strict";
import test from "node:test";
import { buildRuntimeSystemPrompt, chatToolsForRun, runtimeReplyReminder } from "./agentRuntime.js";
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

test("Clients send their browser time zone and the reply reminder uses it", () => {
  const base = {
    type: "client.message", conversation_id: "conv_123", run_id: "run_123",
    message: { role: "user", content: "Hello" }
  };
  const parsed = parseInboundMessage({ ...base, time_zone: "Asia/Tokyo" });
  assert.equal(parsed.type === "client.message" ? parsed.time_zone : undefined, "Asia/Tokyo");
  assert.throws(() => parseInboundMessage({ ...base, time_zone: "Mars/Olympus" }));

  const now = new Date("2026-10-27T07:40:00Z");
  assert.match(runtimeReplyReminder(now, "Asia/Tokyo"), /当前时间：2026-10-27 16:40 星期二（Asia\/Tokyo，GMT\+09:00）/);
  assert.match(runtimeReplyReminder(now), /当前时间：2026-10-27 07:40 星期二（UTC，GMT）/);
});
