import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Agent, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { corpusNode, type CorpusInput, type CorpusOutput } from "./creatorLearning/corpusNode.js";
import { LocalArtifactObjectStore } from "./creatorLearning/objectStore.js";
import { NodeRuntime, type NodeAgentFactory } from "./nodeRuntime.js";
import type { NodeScope } from "./node.js";
import type { NodeExecutionRef, NodeExecutionState, NodeExecutionStore, NodeSessionRef, NodeSessionStore } from "./nodeSession.js";

test("NodeRuntime applies a host quality gate before Critic review", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-node-quality-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const executionStore = new MemoryExecutionStore();
  const runtime = new NodeRuntime({
    storage: { objectStore: new LocalArtifactObjectStore(root) },
    executionStore,
    sessionStore: new MemorySessionStore(),
    maxRounds: 3,
    agentFactory: scriptedAgentFactory([shortCorpus(), denseCorpus()], [{ decision: "done" }])
  });
  const scope: NodeScope = {
    productId: "product-one",
    nodeName: "corpus",
    executionId: "corpus-quality-gate"
  };

  const result = await runtime.run(corpusNode, scope, input);

  assert.equal(result.rounds.length, 2);
  assert.equal(result.rounds[0]?.verdict.decision, "revise");
  assert.match(String(result.rounds[0]?.verdict.feedback), /too short/);
  assert.equal(result.rounds[1]?.verdict.decision, "done");
  assert.equal(result.output.system_instructions, result.rounds[1]?.candidate.system_instructions);
  assert.equal(executionStore.require(scope).status, "completed");
  assert.equal(executionStore.require(scope).round, 2);
});

const input: CorpusInput = {
  files: ["creator-products/creator-one/product-one/files/file_source/projection.md"],
  about_you: "product-one/about-you/about_you_1/creator-answers.json",
  product: "creator-products/creator-one/product-one/product.json"
};

function shortCorpus(): CorpusOutput {
  return {
    system_instructions: "Do the work.",
    skills: [{
      id: "thin-skill",
      title: "Thin skill",
      when_to_use: "Use always.",
      instruction: "Make a good decision.",
      references: [{ id: "note", kind: "method", content: "Short note." }]
    }],
    knowledge: [],
    tools: []
  };
}

function denseCorpus(): CorpusOutput {
  return {
    system_instructions: paragraph("system", 1300),
    skills: Array.from({ length: 6 }, (_, index) => ({
      id: `skill-${index + 1}`,
      title: `Skill ${index + 1}`,
      when_to_use: paragraph(`when ${index + 1}`, 140),
      instruction: paragraph(`instruction ${index + 1}`, 700),
      references: [
        { id: `method-${index + 1}`, kind: "method" as const, content: paragraph(`method ${index + 1}`, 180) },
        { id: `example-${index + 1}`, kind: "example" as const, content: paragraph(`example ${index + 1}`, 180) }
      ]
    })),
    knowledge: [{ source: input.files[0]!, title: "Source file" }],
    tools: []
  };
}

function scriptedAgentFactory(actorOutputs: CorpusOutput[], criticOutputs: Array<{ decision: "done" }>): NodeAgentFactory {
  return ({ sessionId, tools }) => {
    const outputs = sessionId.includes("_critic") ? criticOutputs : actorOutputs;
    return new ScriptedAgent(outputs, tools) as unknown as Agent;
  };
}

class ScriptedAgent {
  readonly state = { messages: [] as AgentMessage[] };
  private readonly listeners = new Set<(event: unknown) => void | Promise<void>>();

  constructor(
    private readonly outputs: unknown[],
    private readonly tools: AgentTool[]
  ) {}

  subscribe(listener: (event: unknown) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(): Promise<void> {
    await this.emit({ type: "turn_start" });
    const output = this.outputs.shift();
    assert.ok(output, "scripted agent has an output");
    const finalizer = this.tools.find((tool) => tool.name === "submit_output");
    assert.ok(finalizer, "submit_output tool is registered");
    await finalizer.execute("submit-scripted-output", output, new AbortController().signal);
    const message = { role: "assistant", content: [], timestamp: new Date().toISOString() } as unknown as AgentMessage;
    this.state.messages.push(message);
    await this.emit({ type: "message_end", message });
  }

  abort(): void {}

  private async emit(event: unknown): Promise<void> {
    for (const listener of this.listeners) await listener(event);
  }
}

class MemorySessionStore implements NodeSessionStore {
  async open(_ref: NodeSessionRef, _systemPrompt: string): Promise<AgentMessage[]> {
    return [];
  }

  async appendMessage(_ref: NodeSessionRef, _message: AgentMessage): Promise<void> {}
}

class MemoryExecutionStore implements NodeExecutionStore {
  private readonly states = new Map<string, NodeExecutionState>();

  async load(ref: NodeExecutionRef): Promise<NodeExecutionState | undefined> {
    return this.states.get(key(ref.scope));
  }

  async save(ref: NodeExecutionRef, state: NodeExecutionState): Promise<void> {
    this.states.set(key(ref.scope), state);
  }

  require(scope: NodeScope): NodeExecutionState {
    const state = this.states.get(key(scope));
    assert.ok(state, "execution state was saved");
    return state;
  }
}

function key(scope: NodeScope): string {
  return `${scope.productId}:${scope.nodeName}:${scope.executionId}`;
}

function paragraph(seed: string, minimumChars: number): string {
  const sentence = `${seed} keeps trigger, intake, decision criteria, output shape, quality bar, exception handling, and refusal boundaries explicit. `;
  return sentence.repeat(Math.ceil(minimumChars / sentence.length)).slice(0, minimumChars);
}
