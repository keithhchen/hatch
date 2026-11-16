import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { RecordingAnalytics, throwingAnalytics } from "../analytics/recording.js";
import type { ProductAnalytics } from "../analytics/port.js";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { InMemoryModelRoleResolver } from "../modelRoles.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";
import { userMessage } from "./imageRefs.js";
import { WorkbenchRuntime } from "./runtime.js";
import { WorkbenchStore, type Role } from "./store.js";

/** Real store and runtime; only the model is scripted: it answers, or fails. */
async function run(role: Role, analytics: ProductAnalytics, fail = false, writes = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-analytics-"));
  let turn = 0;
  const store = new WorkbenchStore(root, { creatorId: "creator-1", productId: "product-1" }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  const runtime = new WorkbenchRuntime(store, {
    models: new InMemoryModelRoleResolver({ roles: { factory: "deepseek-v4-flash" } }), role: "factory", sweepMs: 0, analytics,
    agentFactory: factory => new Agent({ ...factory.agentOptions, initialState: { ...factory.initialState, model: createFactoryLlmModel({ profile: factory.profile, env: factory.env }) }, streamFn: () => {
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k3.1-pro", timestamp: Date.now(),
        content: writes && turn++ === 0 ? [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "output/SYSTEM.md", content: "x" } }] : [{ type: "text", text: "done" }], stopReason: writes && turn === 1 ? "toolUse" : fail ? "error" : "stop", ...(fail ? { errorMessage: "model down" } : {}),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason as "stop", message }); stream.end(message); }, 10);
      return stream;
    } })
  });
  const session = await store.create(role);
  await runtime.send(session.id, userMessage("go", [], { kind: "expert", itemId: "go", text: "go" }));
  for (let i = 0; i < 400 && runtime.isRunning(session.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const status = (await store.get(session.id)).status;
  await runtime.close();
  await rm(root, { recursive: true, force: true });
  return status;
}

test("a build tells analytics it started and that it completed, with its Product and Expert", async () => {
  const recorder = new RecordingAnalytics();
  assert.equal(await run("generation", recorder, false, true), "completed");
  assert.deepEqual(recorder.names(), ["build_started", "build_completed"]);
  assert.ok(recorder.captured.every(entry => entry.distinctId === "creator-1" && entry.props.agent_id === "product-1"));
  assert.equal(typeof recorder.captured[1]!.props.duration_s, "number");
});

test("a build that fails says why; other steps announce no build", async () => {
  const failed = new RecordingAnalytics();
  assert.equal(await run("generation", failed, true, true), "failed");
  assert.deepEqual(failed.names(), ["build_started", "build_failed"]);
  assert.equal(typeof failed.captured[1]!.props.reason, "string");
  const interview = new RecordingAnalytics();
  await run("voice", interview);
  assert.deepEqual(interview.names(), []);
});

test("a Builder turn that only talks is not a build", async () => {
  const talking = new RecordingAnalytics();
  assert.equal(await run("generation", talking), "completed");
  assert.deepEqual(talking.names(), []);
  const failedTalk = new RecordingAnalytics();
  assert.equal(await run("generation", failedTalk, true), "failed");
  assert.deepEqual(failedTalk.names(), []);
});

test("a throwing analytics does not touch the run", async () => {
  assert.equal(await run("generation", throwingAnalytics), "completed");
});
