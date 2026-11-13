import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuntimeSystemPrompt, chatToolsForRun, withActivityMessage } from "./agentRuntime.js";

test("activity_message boilerplate is one short rule and one short parameter description", () => {
  const prompt = buildRuntimeSystemPrompt("Expert prompt", undefined, undefined, [], "", true);
  assert.match(prompt, /每次调用工具都写 activity_message/);
  assert.ok(prompt.length < 600, `system prompt grew to ${prompt.length}`);
  const [tool] = chatToolsForRun([]).map(withActivityMessage);
  const parameter = (tool!.function.parameters.properties as Record<string, { description: string }>).activity_message!;
  assert.ok(parameter.description.length < 80);
  assert.ok((tool!.function.parameters.required as string[]).includes("activity_message"));
});

test("a Studio run drops hatch_web_search; other runs keep it", () => {
  const names = (allowed?: string[]) => chatToolsForRun([], allowed).map((tool) => tool.function.name);
  assert.ok(names().includes("hatch_web_search"));
  assert.ok(names([]).includes("hatch_web_search"));
  assert.ok(!names(["studio.search_web"]).includes("hatch_web_search"));
});
