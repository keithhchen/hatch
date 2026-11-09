import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { MemoryAgentDefinitionRepository, agentEntries, assertAgentAvailable, initialAgentDefinitions } from "../factoryAgents/definitions.js";
import { WorkbenchRuntime } from "../factoryAgents/runtime.js";
import { WorkbenchStore, type Role } from "../factoryAgents/store.js";
import type { SendInput } from "./conversation.js";
import { awaitTurn } from "./awaitTurn.js";
import { WorkerDirectory, type WorkerWorkspace } from "./workerConversation.js";

const input = (text: string): SendInput => ({ id: randomUUID(), text, attachments: [], client: { client: "cli" } });

// Real store, real runtime and real projector; only the model is scripted.
test("a worker conversation runs a real turn: stable ids, final reply, no internals, 409 while locked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-conversation-"));
  const definitions = new MemoryAgentDefinitionRepository(await initialAgentDefinitions());
  const store = new WorkbenchStore(root, { creatorId: "c1", productId: "p1" }, definitions);
  let calls = 0;
  const runtime = new WorkbenchRuntime(store, { env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash" }, agentFactory: options => new Agent({ ...options.agentOptions, initialState: { ...options.initialState, model: createFactoryLlmModel({ env: options.env }) }, streamFn: () => {
    const call = ++calls;
    const action = call % 2 === 1 ? { name: "list", arguments: { directory: "input" } } : undefined;
    const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(),
      content: action ? [{ type: "text", text: "Looking around." }, { type: "toolCall", id: `call-${call}`, ...action }] : [{ type: "text", text: `Reply ${call}` }],
      stopReason: action ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: action ? "toolUse" : "stop", message }); stream.end(message); return stream;
  } }) });
  const workspace: WorkerWorkspace = {
    store, runtime,
    entries: async () => agentEntries(await definitions.list(), await store.list()),
    assertRoleAvailable: async (role: Role) => assertAgentAvailable(agentEntries(await definitions.list(), await store.list()), role),
  };
  const directory = new WorkerDirectory(workspace);
  try {
    assert.deepEqual((await directory.list()).map(w => [w.id, w.availability]), [["research", "available"], ["interview", "available"], ["builder", "locked"], ["cases", "locked"], ["evaluator", "locked"]]);
    await assert.rejects(directory.conversation("builder")!.send(input("build")), /builder cannot start yet/);
    assert.equal((await store.list()).length, 0);

    const research = directory.conversation("research")!;
    const sent = await research.send(input("Look into Alice"));
    assert.equal(sent.queued, false);
    const outcome = await awaitTurn(research, { sentId: sent.message.id, timeoutMs: 10_000, pollMs: 20 });
    assert.equal(outcome.reply?.text, "Reply 2");
    const { messages } = await research.messages();
    assert.deepEqual(messages.map(m => [m.role, m.text]), [["user", "Look into Alice"], ["assistant", "Reply 2"]]);
    assert.equal(messages[0]!.id, sent.message.id, "the id returned at send time is the id in history");
    assert.ok(!JSON.stringify(messages).includes("Looking around"), "intermediate remarks and tool calls stay out");

    const second = await research.send(input("Shorter please"));
    assert.equal(second.conversationId, sent.conversationId, "one conversation per worker");
    await awaitTurn(research, { sentId: second.message.id, after: messages.at(-1)!.id, timeoutMs: 10_000, pollMs: 20 });
    const later = await research.messages(messages.at(-1)!.id);
    assert.deepEqual(later.messages.map(m => [m.role, m.text]), [["user", "Shorter please"], ["assistant", "Reply 4"]]);
    assert.equal((await store.list()).length, 1);
    assert.equal((await directory.list())[0]!.conversation_id, sent.conversationId);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
