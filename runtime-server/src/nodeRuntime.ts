import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage, type AgentTool, type Session } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createFactoryPiAgent } from "./creatorLearning/factoryPi.js";
import {
  type NodeExecutionState,
  type NodeExecutionStateName,
  type NodePersistence
} from "./nodeExecution.js";
import {
  defaultAgentInput,
  type AgentConfig,
  type NodeDefinition,
  type NodeRunResult,
  type NodeScope,
  type NodeRound,
  type NodeActorInput,
  type NodeCriticInput,
  parseNodeScope
} from "./node.js";
import { type NodeSessionRef, type NodeSessionMetadata } from "./nodeSession.js";
import {
  NodeOssStore,
  createNodeStorageTools,
  nodeObjectReference,
  type NodeInput,
  type NodeStorage
} from "./nodeStorage.js";

export type NodeAgentFactory = (options: {
  sessionId: string;
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  responseFormat?: unknown;
}) => Agent;

export type NodeRuntimeOptions = {
  /** Required control-plane persistence. There is deliberately no disk fallback. */
  persistence?: NodePersistence;
  storage?: NodeStorage;
  maxRounds?: number;
  maxAgentTurns?: number;
  /** A process identity. Each execution claim gets a unique suffix. */
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  agentFactory?: NodeAgentFactory;
};

export class NodeRuntimeError extends Error {
  constructor(
    readonly code:
      | "invalid_scope"
      | "invalid_input"
      | "agent_failed"
      | "invalid_agent_output"
      | "max_rounds"
      | "max_agent_turns"
      | "duplicate_tool"
      | "storage_unavailable"
      | "persistence_unavailable"
      | "persistence_failed"
      | "execution_state_conflict",
    message: string
  ) {
    super(message);
    this.name = "NodeRuntimeError";
  }
}

type LiveAgent = {
  agent: Agent;
  session: Session<NodeSessionMetadata>;
  sessionId: string;
  hasSubmittedOutput: () => boolean;
  submittedOutput: () => unknown;
  flushPersistence: () => Promise<void>;
  unsubscribe: () => void;
};

type ActorCheckpoint = {
  phase: "actor";
  round: number;
  previousCandidate?: string;
  feedback?: string;
};

type CriticCheckpoint = {
  phase: "critic";
  round: number;
  candidateReference: string;
};

type ExecutionCheckpoint =
  | ActorCheckpoint
  | CriticCheckpoint
  | { phase: "completed"; round: number };

// Runtime-owned slots contain OSS paths only. They are deliberately not part
// of a Node's business input schema.
const NODE_CANDIDATE_SLOT = "node_candidate";
const NODE_PREVIOUS_CANDIDATE_SLOT = "node_previous_candidate";
const NODE_FEEDBACK_SLOT = "node_feedback";

export class NodeRuntime {
  private readonly persistence?: NodePersistence;
  private readonly storage?: NodeStorage;
  private readonly maxRounds: number;
  private readonly maxAgentTurns: number;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly agentFactory: NodeAgentFactory;

  constructor(options: NodeRuntimeOptions = {}) {
    this.persistence = options.persistence;
    this.storage = options.storage;
    this.maxRounds = positiveInteger(options.maxRounds ?? 8, "maxRounds");
    this.maxAgentTurns = positiveInteger(options.maxAgentTurns ?? 16, "maxAgentTurns");
    this.workerId = nonEmpty(options.workerId ?? `node-worker-${randomUUID()}`, "workerId");
    this.leaseMs = duration(options.leaseMs ?? 120_000, "leaseMs");
    this.heartbeatMs = duration(options.heartbeatMs ?? Math.max(1_000, Math.floor(this.leaseMs / 3)), "heartbeatMs");
    if (this.heartbeatMs >= this.leaseMs) throw new TypeError("heartbeatMs must be smaller than leaseMs");
    this.agentFactory = options.agentFactory ?? defaultAgentFactory;
  }

  async run<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>,
    scope: NodeScope,
    rawInput: unknown,
    signal?: AbortSignal
  ): Promise<NodeRunResult<Candidate, Feedback>> {
    signal?.throwIfAborted();
    const checkedScope = this.checkedScope(node, scope);
    const persistence = this.requirePersistence(node);
    const storage = this.requireStorage(node);
    await this.initializePersistence(node, persistence);

    const existing = await this.loadExecution(checkedScope);
    let input: Input;
    let inputRef: string;
    if (existing) {
      inputRef = existing.inputRef;
      input = await this.readExecutionArtifact(checkedScope, inputRef, node.inputSchema, "persisted Node input");
    } else {
      input = parseInput(node.inputSchema, rawInput, node.name);
      inputRef = nodeObjectReference(checkedScope, "input.json");
      await new NodeOssStore(storage).writeInput(checkedScope, input);
    }

    const ensured = await this.ensureExecution(checkedScope, inputRef);
    if (ensured.state === "completed") {
      return this.readCompletedResult(node, checkedScope, ensured);
    }
    // The owner is a unique claim token, not just a process label. This fences
    // two concurrent calls made by the same worker process as well.
    const leaseOwner = `${this.workerId}:${randomUUID()}`;
    const claimed = await this.claimExecution(checkedScope, leaseOwner);
    if (!claimed) {
      const current = await this.loadExecution(checkedScope);
      if (current?.state === "completed") return this.readCompletedResult(node, checkedScope, current);
      throw new NodeRuntimeError(
        "execution_state_conflict",
        `Node ${node.name} is already owned by another worker or its lease is still active`
      );
    }
    if (claimed.inputRef !== inputRef) {
      throw new NodeRuntimeError("execution_state_conflict", "Node execution input changed while claiming its lease");
    }

    const runtimeInput: NodeInput = { ...(input as unknown as NodeInput) };
    let currentCheckpoint = checkpointFromExecution(claimed);
    if (currentCheckpoint.round > this.maxRounds) {
      throw new NodeRuntimeError("max_rounds", `Node ${node.name} exceeded ${this.maxRounds} rounds`);
    }

    const liveAgents = new Map<string, LiveAgent>();
    let actorSessionId = sessionId(checkedScope, "actor", node.actor, currentCheckpoint.round);
    let criticSessionId = sessionId(checkedScope, "critic", node.critic, currentCheckpoint.round);
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      void persistence.executions.heartbeat(checkedScope, leaseOwner, this.leaseMs).catch((error: unknown) => {
        leaseLost = true;
        for (const live of liveAgents.values()) live.agent.abort();
        void error;
      });
    }, this.heartbeatMs);

    const assertLease = (): void => {
      if (leaseLost) throw new NodeRuntimeError("execution_state_conflict", "Node execution lease was lost");
    };

    try {
      const rounds: NodeRound<Candidate, Feedback>[] = [];
      for (let round = currentCheckpoint.round; round <= this.maxRounds; round += 1) {
        signal?.throwIfAborted();
        assertLease();

        let candidate: Candidate;
        let candidateReference: string;
        if (currentCheckpoint.phase === "critic" && currentCheckpoint.round === round) {
          candidateReference = currentCheckpoint.candidateReference;
          candidate = await this.readExecutionArtifact(
            checkedScope,
            candidateReference,
            node.actor.outputSchema,
            "persisted candidate"
          );
        } else {
          const actorCheckpoint = currentCheckpoint.phase === "actor" && currentCheckpoint.round === round
            ? currentCheckpoint
            : { phase: "actor" as const, round };
          setRuntimeReference(runtimeInput, NODE_PREVIOUS_CANDIDATE_SLOT, actorCheckpoint.previousCandidate);
          setRuntimeReference(runtimeInput, NODE_FEEDBACK_SLOT, actorCheckpoint.feedback);
          delete runtimeInput[NODE_CANDIDATE_SLOT];
          await this.saveExecution(checkedScope, {
            state: "actor",
            round,
            inputRef,
            ...(actorCheckpoint.previousCandidate ? { candidateRef: actorCheckpoint.previousCandidate } : {}),
            ...(actorCheckpoint.feedback ? { feedbackRef: actorCheckpoint.feedback } : {})
          }, leaseOwner);

          const actor = await this.getAgent(
            liveAgents,
            node.actor,
            "actor",
            round,
            checkedScope,
            runtimeInput,
            signal
          );
          actorSessionId = actor.sessionId;
          const actorInput: NodeActorInput<Input> = {
            input,
            round,
            ...(actorCheckpoint.previousCandidate === undefined ? {} : { previousCandidate: actorCheckpoint.previousCandidate }),
            ...(actorCheckpoint.feedback === undefined ? {} : { feedback: actorCheckpoint.feedback })
          };
          candidate = await this.runAgent(actor, node.actor, actorInput, "actor", round, signal);
          assertLease();
          if (node.actor.sessionPolicy === "spawn") this.closeAgent(liveAgents, agentKey(node.actor, "actor", round));

          candidateReference = await this.writeExecutionArtifact(
            checkedScope,
            `rounds/${round}/candidate-${randomUUID()}.json`,
            candidate
          );
          currentCheckpoint = { phase: "critic", round, candidateReference };
          await this.saveExecution(checkedScope, {
            state: "critic",
            round,
            inputRef,
            candidateRef: candidateReference
          }, leaseOwner);
        }

        setRuntimeReference(runtimeInput, NODE_CANDIDATE_SLOT, candidateReference);
        delete runtimeInput[NODE_PREVIOUS_CANDIDATE_SLOT];
        delete runtimeInput[NODE_FEEDBACK_SLOT];
        const criticInput: NodeCriticInput<Input> = { input, round, candidate: candidateReference };
        const critic = await this.getAgent(
          liveAgents,
          node.critic,
          "critic",
          round,
          checkedScope,
          runtimeInput,
          signal
        );
        criticSessionId = critic.sessionId;
        const verdict = await this.runAgent(critic, node.critic, criticInput, "critic", round, signal);
        assertLease();
        if (node.critic.sessionPolicy === "spawn") this.closeAgent(liveAgents, agentKey(node.critic, "critic", round));
        if (verdict.decision === "revise" && verdict.feedback === undefined) {
          throw new NodeRuntimeError("invalid_agent_output", "critic chose revise without feedback");
        }
        rounds.push({ round, candidate, verdict });

        if (verdict.decision === "done") {
          const outputReference = await this.writeExecutionArtifact(
            checkedScope,
            `outputs/${randomUUID()}.json`,
            candidate
          );
          await this.saveExecution(checkedScope, {
            state: "completed",
            round,
            inputRef,
            candidateRef: candidateReference,
            outputRef: outputReference
          }, leaseOwner);
          return {
            status: "completed",
            output: candidate,
            rounds,
            actorSessionId,
            criticSessionId
          };
        }
        const feedbackReference = await this.writeExecutionArtifact(
          checkedScope,
          `rounds/${round}/feedback-${randomUUID()}.json`,
          verdict.feedback as Feedback
        );
        currentCheckpoint = {
          phase: "actor",
          round: round + 1,
          previousCandidate: candidateReference,
          feedback: feedbackReference
        };
        await this.saveExecution(checkedScope, {
          state: "actor",
          round: round + 1,
          inputRef,
          candidateRef: candidateReference,
          feedbackRef: feedbackReference
        }, leaseOwner);
      }
      throw new NodeRuntimeError("max_rounds", `Node ${node.name} exceeded ${this.maxRounds} rounds`);
    } catch (error) {
      if (!leaseLost) {
        const failed = checkpointReferences(currentCheckpoint);
        await this.saveExecution(checkedScope, {
          state: "failed",
          round: currentCheckpoint.round,
          inputRef,
          ...failed,
          errorMessage: error instanceof Error ? error.message : String(error)
        }, leaseOwner).catch(() => undefined);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      for (const live of liveAgents.values()) this.disposeAgent(live);
      liveAgents.clear();
    }
  }

  private checkedScope<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>,
    scope: NodeScope
  ): NodeScope {
    try {
      const checked = parseNodeScope(scope);
      if (checked.nodeName !== node.name) {
        throw new Error(`scope.nodeName=${checked.nodeName}`);
      }
      return checked;
    } catch (error) {
      throw new NodeRuntimeError(
        "invalid_scope",
        `Node ${node.name} received an invalid scope: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private requirePersistence<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>
  ): NodePersistence {
    if (!this.persistence) {
      throw new NodeRuntimeError(
        "persistence_unavailable",
        `Node ${node.name} requires Postgres persistence; the Factory runtime has no disk fallback`
      );
    }
    return this.persistence;
  }

  private requireStorage<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>
  ): NodeStorage {
    if (!this.storage) throw new NodeRuntimeError("storage_unavailable", `Node ${node.name} requires OSS for its artifacts`);
    return this.storage;
  }

  private async initializePersistence<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>,
    persistence: NodePersistence
  ): Promise<void> {
    try {
      await persistence.initialize?.();
    } catch (error) {
      throw new NodeRuntimeError(
        "persistence_failed",
        `Node ${node.name} could not initialize persistence: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async ensureExecution(scope: NodeScope, inputRef: string): Promise<NodeExecutionState> {
    try {
      return await this.persistence!.executions.ensure(scope, inputRef);
    } catch (error) {
      throw new NodeRuntimeError(
        "persistence_failed",
        `Could not create or verify Node execution state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async loadExecution(scope: NodeScope): Promise<NodeExecutionState | undefined> {
    try {
      return await this.persistence!.executions.load(scope);
    } catch (error) {
      throw new NodeRuntimeError(
        "persistence_failed",
        `Could not load Node execution state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async claimExecution(scope: NodeScope, leaseOwner: string): Promise<NodeExecutionState | undefined> {
    try {
      return await this.persistence!.executions.claim(scope, leaseOwner, this.leaseMs);
    } catch (error) {
      throw new NodeRuntimeError(
        "persistence_failed",
        `Could not claim Node execution: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async saveExecution(scope: NodeScope, state: NodeExecutionState, leaseOwner: string): Promise<void> {
    try {
      await this.persistence!.executions.save(scope, state, leaseOwner);
    } catch (error) {
      throw new NodeRuntimeError(
        "persistence_failed",
        `Could not save Node execution state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async readCompletedResult<Input, Candidate, Feedback>(
    node: NodeDefinition<Input, Candidate, Feedback>,
    scope: NodeScope,
    state: NodeExecutionState
  ): Promise<NodeRunResult<Candidate, Feedback>> {
    if (!state.outputRef) throw new NodeRuntimeError("execution_state_conflict", "Completed Node execution has no output_ref");
    const output = await this.readExecutionArtifact(scope, state.outputRef, node.actor.outputSchema, "completed Node output");
    return {
      status: "completed",
      output,
      rounds: [],
      actorSessionId: sessionId(scope, "actor", node.actor, state.round),
      criticSessionId: sessionId(scope, "critic", node.critic, state.round)
    };
  }

  private async writeExecutionArtifact(scope: NodeScope, name: string, value: unknown): Promise<string> {
    if (!this.storage) throw new NodeRuntimeError("storage_unavailable", "Node execution artifacts require OSS storage");
    await new NodeOssStore(this.storage).writeImmutable(scope, name, value);
    return nodeObjectReference(scope, name);
  }

  private async readExecutionArtifact<Output>(
    scope: NodeScope,
    reference: string,
    schema: z.ZodType<Output>,
    label: string
  ): Promise<Output> {
    if (!this.storage) throw new NodeRuntimeError("storage_unavailable", "Node execution artifacts require OSS storage");
    try {
      const content = await new NodeOssStore(this.storage).readReference(scope, reference);
      return parseOutput(schema, content, label);
    } catch (error) {
      if (error instanceof NodeRuntimeError) throw error;
      throw new NodeRuntimeError(
        "persistence_failed",
        `Could not read ${label} at ${reference}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async getAgent<Input, Output>(
    liveAgents: Map<string, LiveAgent>,
    config: AgentConfig<Input, Output>,
    role: "actor" | "critic",
    round: number,
    scope: NodeScope,
    input: NodeInput,
    signal?: AbortSignal
  ): Promise<LiveAgent> {
    const key = agentKey(config, role, round);
    const existing = liveAgents.get(key);
    if (existing) return existing;
    const live = await this.createAgent(
      config,
      sessionId(scope, role, config, round),
      scope,
      input,
      signal
    );
    liveAgents.set(key, live);
    return live;
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
    const sessionRef: NodeSessionRef = { scope, sessionId: sessionIdValue };
    const responseFormat = structuredResponseFormat(config.outputSchemaName, config.outputSchema);
    const storageTools = this.storage && config.storageAccess !== "none"
      ? createNodeStorageTools(this.storage, input)
      : [];
    const customTools = [...(config.tools ?? [])];
    // Kimi's provider-native response_format is the cleanest contract for a
    // plain Agent call, but a tool-enabled Agent must be allowed to complete
    // the read -> structured result sequence. In that case Pi's submit tool is
    // the final structured handoff and Runtime validates it with the same Zod
    // schema. Nodes without tools still use PR #66's native contract.
    const useSubmitOutput = storageTools.length > 0 || customTools.length > 0;
    const systemPrompt = systemPromptWithOutputContract(config.systemPrompt, responseFormat, useSubmitOutput);
    const session = await this.persistence?.sessions.open(sessionRef, systemPrompt);
    if (!session) throw new NodeRuntimeError("persistence_unavailable", `Node agent ${sessionIdValue} has no Pi session store`);
    const messages = (await session.buildContext()).messages;
    let outputSubmitted = false;
    let outputValue: unknown;
    const outputTool: AgentTool = {
      name: "submit_output",
      label: "submit_output",
      description: "Submit the complete Node result as one JSON object matching the output contract. This is the only accepted final output channel. Stop after it is accepted.",
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
    const allTools = useSubmitOutput
      ? [...storageTools, outputTool, ...customTools]
      : [...storageTools, ...customTools];
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
      responseFormat: useSubmitOutput ? undefined : responseFormat
    });
    const abortAgent = () => agent.abort();
    signal?.addEventListener("abort", abortAgent, { once: true });
    let pendingPersistence = Promise.resolve();
    const unsubscribe = agent.subscribe(async (event) => {
      if (event.type === "message_end") {
        pendingPersistence = pendingPersistence.then(async () => {
          await session.appendMessage(event.message);
        });
        await pendingPersistence;
      }
    });
    return {
      agent,
      session,
      sessionId: sessionIdValue,
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
    if (exceeded) throw new NodeRuntimeError("max_agent_turns", `${label} exceeded ${this.maxAgentTurns} Pi turns in Node round ${round}`);
    if (live.hasSubmittedOutput()) {
      return parseOutput(config.outputSchema, JSON.stringify(live.submittedOutput()), label);
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
      throw new NodeRuntimeError("agent_failed", `${label} ended with an unhandled tool call instead of structured output`);
    }
    const text = assistantText(assistant);
    if (!text.trim()) throw new NodeRuntimeError("agent_failed", `${label} returned empty structured output`);
    return parseOutput(config.outputSchema, text, label);
  }

  private closeAgent(liveAgents: Map<string, LiveAgent>, key: string): void {
    const live = liveAgents.get(key);
    if (!live) return;
    this.disposeAgent(live);
    liveAgents.delete(key);
  }

  private disposeAgent(live: LiveAgent): void {
    live.unsubscribe();
    live.agent.abort();
  }
}

function defaultAgentFactory(options: Parameters<NodeAgentFactory>[0]): Agent {
  return createFactoryPiAgent({
    responseFormat: options.responseFormat,
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
  responseFormat: Record<string, unknown>,
  useSubmitOutput: boolean
): string {
  const schema = responseFormat.json_schema;
  const handoff = useSubmitOutput
    ? "The only accepted final output is a call to the submit_output tool with one complete JSON object matching this JSON Schema. Do not print the result as prose or Markdown."
    : "The only accepted final output is one complete JSON object matching this JSON Schema. Do not print prose, Markdown, or a code fence around it.";
  return `${systemPrompt.trim()}\n\n# Output contract\n${handoff}\n${JSON.stringify(schema, null, 2)}`;
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
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new NodeRuntimeError("invalid_agent_output", `${label} output did not match its schema: ${z.prettifyError(result.error)}`);
  }
  return result.data;
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
  role: "actor" | "critic",
  config: { sessionPolicy: "spawn" | "persistent" },
  round: number
): string {
  return config.sessionPolicy === "persistent"
    ? `${scope.executionId}_${role}`
    : `${scope.executionId}_${role}_${round}_${randomUUID()}`;
}

function agentKey(config: { sessionPolicy: "spawn" | "persistent" }, role: "actor" | "critic", round: number): string {
  return config.sessionPolicy === "persistent" ? role : `${role}:${round}`;
}

function checkpointFromExecution(state: NodeExecutionState): ExecutionCheckpoint {
  if (state.state === "critic" && state.candidateRef) {
    return { phase: "critic", round: state.round, candidateReference: state.candidateRef };
  }
  if (state.state === "actor" || state.state === "loading" || state.state === "failed") {
    return {
      phase: "actor",
      round: state.round,
      ...(state.candidateRef ? { previousCandidate: state.candidateRef } : {}),
      ...(state.feedbackRef ? { feedback: state.feedbackRef } : {})
    };
  }
  throw new NodeRuntimeError("execution_state_conflict", `Node execution cannot resume from state ${state.state}`);
}

function checkpointReferences(checkpoint: ExecutionCheckpoint): {
  candidateRef?: string;
  feedbackRef?: string;
} {
  if (checkpoint.phase === "critic") {
    return { candidateRef: checkpoint.candidateReference };
  }
  if (checkpoint.phase === "actor") {
    return {
      ...(checkpoint.previousCandidate ? { candidateRef: checkpoint.previousCandidate } : {}),
      ...(checkpoint.feedback ? { feedbackRef: checkpoint.feedback } : {})
    };
  }
  return {};
}

function setRuntimeReference(input: NodeInput, slot: string, reference: string | undefined): void {
  if (reference === undefined) delete input[slot];
  else input[slot] = reference;
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

function duration(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1_000) throw new TypeError(`${name} must be an integer of at least 1000ms`);
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new TypeError(`${name} must be non-empty`);
  return value.trim();
}
