import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createFactoryPiAgent } from "./creatorLearning/factoryPi.js";
import {
  defaultAgentInput,
  type AgentConfig,
  type CriticVerdict,
  type NodeDefinition,
  type NodeRunResult,
  type NodeScope,
  type NodeRound,
  type NodeActorInput,
  type NodeCriticInput,
  parseNodeScope
} from "./node.js";
import {
  PostgresNodeStore,
  type NodeExecutionRef,
  type NodeExecutionState,
  type NodeExecutionStore,
  type NodeSessionRef,
  type NodeSessionStore
} from "./nodeSession.js";
import { NodeOssStore, createNodeStorageTools, type NodeInput, type NodeStorage } from "./nodeStorage.js";

export type NodeAgentFactory = (options: {
  sessionId: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  responseFormat: unknown;
}) => Agent;

export type NodeRuntimeOptions = {
  sessionStore?: NodeSessionStore;
  executionStore?: NodeExecutionStore;
  storage?: NodeStorage;
  maxRounds?: number;
  maxAgentTurns?: number;
  agentFactory?: NodeAgentFactory;
};

export class NodeRuntimeError extends Error {
  constructor(
    readonly code: "invalid_scope" | "invalid_input" | "agent_failed" | "invalid_agent_output" | "max_rounds" | "max_agent_turns" | "duplicate_tool" | "storage_unavailable",
    message: string
  ) {
    super(message);
    this.name = "NodeRuntimeError";
  }
}

type LiveAgent = {
  agent: Agent;
  sessionId: string;
  sessionRef: NodeSessionRef;
  hasSubmittedOutput: () => boolean;
  submittedOutput: () => unknown;
  flushPersistence: () => Promise<void>;
  unsubscribe: () => void;
};

export class NodeRuntime {
  private readonly sessionStore: NodeSessionStore;
  private readonly executionStore: NodeExecutionStore;
  private readonly storage?: NodeStorage;
  private readonly maxRounds: number;
  private readonly maxAgentTurns: number;
  private readonly agentFactory: NodeAgentFactory;

  constructor(options: NodeRuntimeOptions = {}) {
    let defaultPersistence: PostgresNodeStore | undefined;
    const getDefaultPersistence = (): PostgresNodeStore => {
      defaultPersistence ??= new PostgresNodeStore();
      return defaultPersistence;
    };
    this.sessionStore = options.sessionStore ?? getDefaultPersistence();
    this.executionStore = options.executionStore ?? getDefaultPersistence();
    this.storage = options.storage;
    this.maxRounds = positiveInteger(options.maxRounds ?? 8, "maxRounds");
    this.maxAgentTurns = positiveInteger(options.maxAgentTurns ?? 16, "maxAgentTurns");
    this.agentFactory = options.agentFactory ?? defaultAgentFactory;
  }

  async run<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>,
    scope: NodeScope,
    rawInput: unknown,
    signal?: AbortSignal
  ): Promise<NodeRunResult<Candidate, Feedback>> {
    signal?.throwIfAborted();
    let checkedScope: NodeScope;
    try {
      checkedScope = parseNodeScope(scope);
    } catch (error) {
      throw new NodeRuntimeError("invalid_scope", `Node ${node.name} received an invalid scope: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (checkedScope.nodeName !== node.name) {
      throw new NodeRuntimeError("invalid_scope", `Node ${node.name} cannot run with scope.nodeName=${checkedScope.nodeName}`);
    }
    if (!this.storage) {
      throw new NodeRuntimeError("storage_unavailable", `Node ${node.name} requires OSS storage for candidate and output artifacts`);
    }
    const nodeStore = new NodeOssStore(this.storage);
    const input = parseInput(node.inputSchema, rawInput, node.name);
    const executionRef: NodeExecutionRef = { scope: checkedScope };
    const existingExecution = await this.executionStore.load(executionRef);
    if (existingExecution?.status === "completed") {
      if (!existingExecution.outputRef) {
        throw new NodeRuntimeError("agent_failed", `Completed Node ${node.name} has no output reference`);
      }
      return {
        status: "completed",
        output: await nodeStore.readJson(checkedScope, existingExecution.outputRef) as Candidate,
        outputRef: existingExecution.outputRef,
        rounds: [],
        actorSessionIds: [],
        criticSessionIds: []
      };
    }
    // Register the full logical tool surface before the first Agent is
    // created. Values are filled by Runtime as the loop advances; Agents only
    // ever choose a slot name, never an OSS key.
    const actorToolInput: NodeInput = {
      ...(input as unknown as NodeInput),
      previous_candidate: undefined
    };
    const criticToolInput: NodeInput = {
      ...(input as unknown as NodeInput),
      candidate: undefined
    };
    let persistentActor: LiveAgent | undefined;
    let persistentCritic: LiveAgent | undefined;
    const actorSessionIds: string[] = [];
    const criticSessionIds: string[] = [];
    let previousCandidateRef: string | undefined;
    let feedback: Feedback | undefined;
    let resumeCandidateRef: string | undefined;
    let resumeCandidate: unknown;
    let nextRound = 1;
    const resumedPhase = existingExecution
      ? existingExecution.phase
        ?? (existingExecution.candidateRef && existingExecution.decision !== "revise" ? "critic" : "actor")
      : "actor";

    if (existingExecution) {
      const details = checkpointDetails(existingExecution.details);
      if (resumedPhase === "critic" && existingExecution.candidateRef) {
        nextRound = Math.max(1, existingExecution.round);
        resumeCandidateRef = existingExecution.candidateRef;
        resumeCandidate = await nodeStore.readJson(checkedScope, resumeCandidateRef);
        criticToolInput.candidate = resumeCandidateRef;
      } else {
        nextRound = Math.max(1, existingExecution.phase === "actor"
          ? existingExecution.round
          : existingExecution.round + 1);
        previousCandidateRef = details.previousCandidateRef
          ?? (existingExecution.decision === "revise" ? existingExecution.candidateRef : undefined);
        feedback = details.feedback as Feedback | undefined;
        if (previousCandidateRef) actorToolInput.previous_candidate = previousCandidateRef;
      }
    }

    let lastCheckpoint: NodeExecutionState = {
      status: "running",
      round: nextRound,
      phase: resumedPhase,
      ...(resumeCandidateRef === undefined ? {} : { candidateRef: resumeCandidateRef }),
      ...(feedback === undefined ? {} : { details: { previousCandidateRef, feedback } })
    };
    const saveCheckpoint = async (state: NodeExecutionState): Promise<void> => {
      lastCheckpoint = state;
      await this.executionStore.save(executionRef, state);
    };

    try {
      await saveCheckpoint(lastCheckpoint);
      if (node.actor.sessionPolicy === "persistent") {
        persistentActor = await this.createAgent(
          node.actor,
          sessionId(checkedScope, "actor", node.actor.sessionPolicy),
          checkedScope,
          actorToolInput,
          signal
        );
        actorSessionIds.push(persistentActor.sessionId);
      }
      if (node.critic.sessionPolicy === "persistent") {
        persistentCritic = await this.createAgent(
          node.critic,
          sessionId(checkedScope, "critic", node.critic.sessionPolicy),
          checkedScope,
          criticToolInput,
          signal
        );
        criticSessionIds.push(persistentCritic.sessionId);
      }
      const rounds: NodeRound<Candidate, Feedback>[] = [];
      for (let round = nextRound; round <= this.maxRounds; round += 1) {
        signal?.throwIfAborted();
        let candidate: Candidate;
        let candidateRef: string;
        if (resumeCandidateRef !== undefined) {
          candidate = resumeCandidate as Candidate;
          candidateRef = resumeCandidateRef;
          resumeCandidateRef = undefined;
          resumeCandidate = undefined;
        } else {
          await saveCheckpoint({
            status: "running",
            round,
            phase: "actor",
            ...(previousCandidateRef === undefined ? {} : { candidateRef: previousCandidateRef }),
            ...(feedback === undefined ? {} : { details: { previousCandidateRef, feedback } })
          });
          const existingCandidate = await nodeStore.readCandidate(checkedScope, round);
          if (existingCandidate) {
            candidate = existingCandidate.value as Candidate;
            candidateRef = existingCandidate.key;
          } else {
            const actorInput: NodeActorInput<Input, Candidate, Feedback> = {
              input,
              round,
              ...(previousCandidateRef === undefined ? {} : { previousCandidateRef }),
              ...(feedback === undefined ? {} : { feedback })
            };
            const actor = persistentActor ?? await this.createAgent(
              node.actor,
              sessionId(checkedScope, "actor", node.actor.sessionPolicy, round),
              checkedScope,
              actorToolInput,
              signal
            );
            if (node.actor.sessionPolicy === "spawn") actorSessionIds.push(actor.sessionId);
            try {
              candidate = await this.runAgent(actor, node.actor, actorInput, "actor", round, signal);
            } finally {
              if (node.actor.sessionPolicy === "spawn") disposeAgent(actor);
            }
            const candidateObject = await nodeStore.writeCandidate(checkedScope, round, candidate);
            candidateRef = candidateObject.key;
          }
        }
        criticToolInput.candidate = candidateRef;
        const criticInput: NodeCriticInput<Input, Candidate> = { input, round, candidateRef };
        await saveCheckpoint({
          status: "running",
          round,
          phase: "critic",
          candidateRef,
          ...(feedback === undefined ? {} : { details: { previousCandidateRef, feedback } })
        });
        const critic = persistentCritic ?? await this.createAgent(
          node.critic,
          sessionId(checkedScope, "critic", node.critic.sessionPolicy, round),
          checkedScope,
          criticToolInput,
          signal
        );
        if (node.critic.sessionPolicy === "spawn") criticSessionIds.push(critic.sessionId);
        let verdict: CriticVerdict<Feedback>;
        try {
          verdict = await this.runAgent(critic, node.critic, criticInput, "critic", round, signal);
        } finally {
          if (node.critic.sessionPolicy === "spawn") disposeAgent(critic);
        }
        const currentRound: NodeRound<Candidate, Feedback> = { round, candidate, verdict };
        rounds.push(currentRound);

        if (verdict.decision === "done") {
          const outputObject = await nodeStore.writeOutput(checkedScope, candidate);
          await this.executionStore.save(executionRef, {
            status: "completed",
            round,
            candidateRef,
            outputRef: outputObject.key,
            decision: "done"
          });
          return {
            status: "completed",
            output: candidate,
            outputRef: outputObject.key,
            rounds,
            actorSessionIds,
            criticSessionIds
          };
        }
        previousCandidateRef = candidateRef;
        actorToolInput.previous_candidate = candidateRef;
        feedback = verdict.feedback as Feedback;
        await saveCheckpoint({
          status: "running",
          round: round + 1,
          phase: "actor",
          candidateRef,
          decision: "revise",
          details: { previousCandidateRef: candidateRef, feedback: verdict.feedback }
        });
      }
      throw new NodeRuntimeError("max_rounds", `Node ${node.name} exceeded ${this.maxRounds} rounds`);
    } catch (error) {
      await this.executionStore.save(executionRef, {
        ...lastCheckpoint,
        status: "failed",
        details: {
          ...checkpointDetails(lastCheckpoint.details),
          error: error instanceof Error ? error.message : String(error)
        }
      }).catch(() => undefined);
      throw error;
    } finally {
      if (persistentActor) disposeAgent(persistentActor);
      if (persistentCritic) disposeAgent(persistentCritic);
    }
  }

  private async createAgent<Input, Output>(
    config: AgentConfig<Input, Output>,
    sessionIdValue: string,
    scope: NodeScope,
    input: NodeInput,
    signal?: AbortSignal
  ): Promise<LiveAgent> {
    signal?.throwIfAborted();
    if (!config.systemPrompt.trim()) throw new Error(`Node agent ${sessionIdValue} requires a system prompt`);
    if (config.storageAccess !== "none" && !this.storage) {
      throw new NodeRuntimeError("storage_unavailable", `Node agent ${sessionIdValue} requires OSS storage`);
    }
    const responseFormat = structuredResponseFormat(config.outputSchemaName, config.outputSchema);
    const systemPrompt = systemPromptWithOutputContract(config.systemPrompt, responseFormat);
    const sessionRef: NodeSessionRef = { scope, sessionId: sessionIdValue };
    const messages = await this.sessionStore.open(sessionRef, systemPrompt);
    const storageTools = this.storage && config.storageAccess !== "none"
      ? createNodeStorageTools(this.storage, scope, input, config.storageAccess)
      : [];
    let outputSubmitted = false;
    let outputValue: unknown;
    const outputTool: AgentTool = {
      name: "submit_output",
      label: "submit_output",
      description: "Submit the complete Node result as one JSON object matching the output contract. This is the only accepted output channel. Do not print the result as prose.",
      parameters: zodSchemaAsToolSchema(responseFormat),
      executionMode: "sequential",
      execute: async (_toolCallId, args, toolSignal) => {
        toolSignal?.throwIfAborted();
        outputValue = args;
        outputSubmitted = true;
        return {
          content: [{ type: "text", text: "Output accepted. Stop now." }],
          details: { accepted: true },
          terminate: true
        };
      }
    };
    const customTools = [...(config.tools ?? [])];
    const allTools = [...storageTools, outputTool, ...customTools];
    const names = new Set<string>();
    for (const tool of allTools) {
      if (names.has(tool.name)) throw new NodeRuntimeError("duplicate_tool", `Tool ${tool.name} is registered more than once`);
      names.add(tool.name);
    }
    const agent = this.agentFactory({
      sessionId: sessionIdValue,
      systemPrompt,
      messages,
      tools: allTools,
      responseFormat
    });
    const abortAgent = () => agent.abort();
    signal?.addEventListener("abort", abortAgent, { once: true });
    let pendingPersistence = Promise.resolve();
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "message_end") {
        pendingPersistence = pendingPersistence.then(() => this.sessionStore.appendMessage(sessionRef, event.message));
        await pendingPersistence;
      }
    });
    return {
      agent,
      sessionId: sessionIdValue,
      sessionRef,
      hasSubmittedOutput: () => outputSubmitted,
      submittedOutput: () => outputValue,
      flushPersistence: () => pendingPersistence,
      unsubscribe: () => {
        unsubscribe();
        signal?.removeEventListener("abort", abortAgent);
      }
    };
  }

  private async runAgent<Input, Output>(
    live: LiveAgent,
    config: AgentConfig<Input, Output>,
    input: Input,
    label: "actor" | "critic",
    round: number,
    signal?: AbortSignal
  ): Promise<Output> {
    signal?.throwIfAborted();
    const before = live.agent.state.messages.length;
    let turnCount = 0;
    let exceeded = false;
    const guard = live.agent.subscribe((event) => {
      if (event.type !== "turn_start") return;
      turnCount += 1;
      if (turnCount > this.maxAgentTurns) {
        exceeded = true;
        live.agent.abort();
      }
    });
    const prompt = (config.renderInput ?? defaultAgentInput)(input);
    try {
      await live.agent.prompt(prompt);
      await live.flushPersistence();
      signal?.throwIfAborted();
    } finally {
      guard();
    }
    if (exceeded) {
      throw new NodeRuntimeError("max_agent_turns", `${label} exceeded ${this.maxAgentTurns} Pi turns in Node round ${round}`);
    }
    if (live.hasSubmittedOutput()) {
      return live.submittedOutput() as Output;
    }
    const messages = live.agent.state.messages.slice(before);
    const assistant = [...messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === "assistant");
    if (!assistant) throw new NodeRuntimeError("agent_failed", `${label} ended without an assistant message`);
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new NodeRuntimeError("agent_failed", `${label} failed: ${assistant.errorMessage ?? assistant.stopReason}`);
    }
    if (assistant.content.some((block) => block.type === "toolCall")) {
      throw new NodeRuntimeError("agent_failed", `${label} ended with a tool call instead of structured output`);
    }
    const text = assistantText(assistant);
    if (!text.trim()) throw new NodeRuntimeError("agent_failed", `${label} returned empty structured output`);
    return parseOutput(config.outputSchema, text, label);
  }
}

function defaultAgentFactory(options: Parameters<NodeAgentFactory>[0]): Agent {
  return createFactoryPiAgent({
    initialState: {
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      tools: options.tools
    },
    agentOptions: {
      sessionId: options.sessionId,
      toolExecution: "sequential"
    }
  });
}

function systemPromptWithOutputContract(
  systemPrompt: string,
  responseFormat: Record<string, unknown>
): string {
  const schema = responseFormat.json_schema;
  return `${systemPrompt.trim()}\n\n# Output contract\nThe only accepted final output is a call to the submit_output tool with one complete JSON object matching this JSON Schema. Do not print the result as prose or Markdown.\n${JSON.stringify(schema, null, 2)}`;
}

function structuredResponseFormat(name: string, schema: z.ZodTypeAny): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: safeSchemaName(name),
      strict: true,
      schema: z.toJSONSchema(schema, { target: "openAi" })
    }
  };
}

function zodSchemaAsToolSchema(responseFormat: Record<string, unknown>): ReturnType<typeof Type.Unsafe> {
  const jsonSchema = responseFormat.json_schema;
  if (!jsonSchema || typeof jsonSchema !== "object" || Array.isArray(jsonSchema)) {
    throw new Error("Node output schema did not produce a JSON schema");
  }
  const schema = (jsonSchema as Record<string, unknown>).schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Node output schema did not produce an object schema");
  }
  return Type.Unsafe(schema);
}

function parseInput<Input>(schema: z.ZodType<Input>, rawInput: unknown, nodeId: string): Input {
  const result = schema.safeParse(rawInput);
  if (!result.success) {
    throw new NodeRuntimeError("invalid_input", `Node ${nodeId} received invalid input: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

function parseOutput<Output>(schema: z.ZodType<Output>, text: string, label: string): Output {
  let value: unknown;
  try {
    value = JSON.parse(stripCodeFence(text));
  } catch (error) {
    throw new NodeRuntimeError("invalid_agent_output", `${label} did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The schema is used by the submit_output handoff. Runtime does not turn it
  // into a business-quality gate; Critic is the quality loop.
  void schema;
  return value as Output;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function stripCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function sessionId(
  scope: NodeScope,
  name: "actor" | "critic",
  policy: "spawn" | "persistent",
  round?: number
): string {
  if (policy === "persistent") return `${scope.executionId}_${name}`;
  if (round === undefined) throw new Error(`Spawned ${name} session requires a round`);
  return `${scope.executionId}_${name}_${round}_${randomUUID()}`;
}

function disposeAgent(agent: LiveAgent): void {
  agent.unsubscribe();
  agent.agent.abort();
}

function checkpointDetails(value: unknown): {
  previousCandidateRef?: string;
  feedback?: unknown;
  error?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const details = value as Record<string, unknown>;
  return {
    ...(typeof details.previousCandidateRef === "string" ? { previousCandidateRef: details.previousCandidateRef } : {}),
    ...(Object.prototype.hasOwnProperty.call(details, "feedback") ? { feedback: details.feedback } : {}),
    ...(typeof details.error === "string" ? { error: details.error } : {})
  };
}

function safeSchemaName(value: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9_-]+$/.test(normalized)) throw new Error(`Invalid structured output schema name: ${value}`);
  return normalized;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}
