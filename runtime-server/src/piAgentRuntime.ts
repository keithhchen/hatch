import {
  Agent,
  convertToLlm,
  type AgentEvent,
  type AgentMessage,
  type AgentTool
} from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationMessage, OutboundMessage, RunStart } from "./protocol.js";
import type { ActivatedSkill } from "./store.js";
import {
  auditProposedDeliveryTool,
  activeSkillResourceRoots,
  buildRuntimeContextMessages,
  buildRuntimeSystemPrompt,
  type PiModelMessage,
  chatToolsForRun,
  createWorkspacePathPolicy,
  ensureNotCancelled,
  errorMessage,
  executeChatTool,
  implicitSkillInvocationFromTool,
  mergeRuntimeActiveSkill,
  modelVisibleToolResult,
  produceAuditedFinal,
  requestedOutputPath,
  runtimeSkillActivationFromToolResult,
  skillInvocationEvent,
  toolEventBase,
  workspaceDiffEvent,
  type AgentRuntime,
  type RunContext,
  type WorkspacePathPolicy
} from "./agentRuntime.js";
import { KIMI_MODEL } from "./kimiProvider.js";
import { SUMMARY_PREFIX, SUMMARY_SUFFIX } from "./compaction.js";
import { createKimiModel, createKimiStreamFn } from "./piModel.js";
import { runPiAgentPrompt, type PiAgentPromptRunner } from "./piPrompt.js";

export type PiToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

type QueueItem<T> =
  | { kind: "value"; value: T }
  | { kind: "done" }
  | { kind: "error"; error: Error };

class AsyncQueue<T> {
  private readonly values: QueueItem<T>[] = [];
  private readonly waiters: Array<(item: QueueItem<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ kind: "value", value });
    else this.values.push({ kind: "value", value });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.flush({ kind: "done" });
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.flush({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) });
  }

  async next(): Promise<QueueItem<T>> {
    const queued = this.values.shift();
    if (queued) return queued;
    if (this.closed) return { kind: "done" };
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private flush(item: QueueItem<T>): void {
    while (this.waiters.length > 0) this.waiters.shift()?.(item);
  }
}

type ToolEventState = {
  event: Extract<OutboundMessage, { type: "tool_call.delta" }>;
  arguments: Record<string, unknown>;
  invalid?: boolean;
};

/**
 * Hatch's production Agent runtime. Pi owns the in-memory transcript and the
 * actual tool loop; Hatch owns persistence, redaction, local-tool routing, and
 * the client projection.
 */
export class PiAgentRuntime implements AgentRuntime {
  async *run(input: RunStart, ctx: RunContext): AsyncIterable<OutboundMessage> {
    const model = createKimiModel();
    const streamFn = createKimiStreamFn();
    const queue = new AsyncQueue<OutboundMessage>();
    const workspacePathPolicy = createWorkspacePathPolicy(input.message.content);
    const visibleSkills = ctx.sessionSkills.visibleRecords;
    let activeSkills = [...(ctx.activatedSkills ?? [])];
    let resourceRoots = activeSkillResourceRoots(visibleSkills, activeSkills);
    const toolEvents = new Map<string, ToolEventState>();
    const seenImplicitInvocations = new Set<string>();
    let terminalError: Error | undefined;
    let finalAssistant: AssistantMessage | undefined;
    let compacting = false;
    let hasExecutedTool = false;
    const requestedFilePath = requestedOutputPath(input.message.content);
    const deliveryWorkflow = ctx.deliveryWorkflow;
    const deliveryReviewer = deliveryWorkflow ? await createDeliveryReviewer() : undefined;
    const transcriptMessages: ConversationMessage[] = [];
    const completedArtifactPaths: string[] = [];

    const contextMessages = buildRuntimeContextMessages(
      ctx.sessionSkills.projectInstructions,
      ctx.sessionSkills.rendered.section,
      activeSkills,
      ctx.workspaceRoot
    ).map((message) => piUserMessage(message.content ?? ""));
    const storedMessages = ctx.messages.slice(0, -1).map(toPiMessage);
    const toolDefinitions = chatToolsForRun(
      ctx.clientTools,
      ctx.allowSkillRun !== false,
      ctx.allowedExternalTools,
      ctx.knowledgeAvailable,
      ctx.externalToolDefinitions
    );
    const tools = toolDefinitions.map((definition) => this.createTool(
      input,
      ctx,
      definition,
      () => activeSkills,
      () => resourceRoots,
      workspacePathPolicy
    ));

    const agent = new Agent({
      streamFn,
      // Pi's default Agent projection only accepts the three provider
      // message roles. Use Pi's harness projector so its native
      // compactionSummary message remains model-visible with Pi's standard
      // summary delimiters.
      convertToLlm,
      initialState: {
        systemPrompt: buildRuntimeSystemPrompt(ctx.agentSystemPrompt, ctx.deliveryWorkflow),
        model,
        thinkingLevel: "high",
        messages: [...contextMessages, ...storedMessages],
        tools
      },
      beforeToolCall: deliveryReviewer && deliveryWorkflow
        ? async ({ toolCall, args }, signal) => {
          const rejection = await auditProposedDeliveryTool({
            runner: deliveryReviewer,
            workflow: deliveryWorkflow,
            toolName: toolCall.name,
            arguments: args as Record<string, unknown>,
            messages: auditMessagesForRun(ctx, transcriptMessages, undefined),
            systemPrompt: buildRuntimeSystemPrompt(ctx.agentSystemPrompt, deliveryWorkflow),
            auditContext: ctx.deliveryAuditContext,
            signal
          });
          return rejection
            ? { block: true, reason: JSON.stringify(rejection) }
            : undefined;
        }
        : undefined,
      afterToolCall: async ({ result }) => {
        // Pi deliberately turns thrown tool errors into a plain-text error
        // result. Hatch needs a structured, recoverable result so the next
        // model request can distinguish a failed tool from ordinary output
        // and decide whether to retry or change approach.
        if (isHatchToolFailure(result.details)) return { isError: true };
        return undefined;
      },
      transformContext: async (messages) => {
        // Pi owns the live transcript. Runtime only invokes the product's
        // compaction adapter when the normal context projection says it is
        // needed; it never replaces a tool call/result pair with an ad-hoc
        // evidence user message.
        if (!ctx.compactMessagesIfNeeded || !hasExecutedTool || compacting) return messages;
        const runtimeMessages = messages
          .filter(isModelMessage)
          .map(toRuntimeCompactionMessage);
        compacting = true;
        try {
        const replacement = await ctx.compactMessagesIfNeeded(runtimeMessages, "mid_turn");
          if (!replacement) return messages;
          return [
            ...contextMessages,
            ...replacement.map(toPiMessage)
          ];
        } catch {
          // A compaction failure should not destroy an otherwise usable live
          // turn. The normal provider request will surface a context error if
          // the context is genuinely too large.
          return messages;
        } finally {
          compacting = false;
        }
      }
    });

    agent.subscribe(async (event) => {
      await this.handleEvent({
        event,
        agent,
        input,
        ctx,
        queue,
        toolEvents,
        workspacePathPolicy,
        getActiveSkills: () => activeSkills,
        setActiveSkills: (next) => {
          activeSkills = next;
          resourceRoots = activeSkillResourceRoots(visibleSkills, activeSkills);
        },
        getResourceRoots: () => resourceRoots,
        setHasExecutedTool: () => { hasExecutedTool = true; },
        deliveryWorkflow,
        transcriptMessages,
        completedArtifactPaths,
        seenImplicitInvocations,
        setFinalAssistant: (message) => { finalAssistant = message; },
        setTerminalError: (error) => { terminalError ??= error; }
      });
    });

    // Pass an explicit Pi UserMessage so the current user turn stays a plain
    // text payload in the OpenAI-compatible request (and in the persistence
    // projection), instead of Agent.prompt(string)'s text-block form.
    const promptPromise = agent.prompt(piUserMessage(input.message.content))
      .catch((error) => {
        terminalError = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => queue.close());

    try {
      while (true) {
        const item = await queue.next();
        if (item.kind === "done") break;
        if (item.kind === "error") throw item.error;
        yield item.value;
      }
      await promptPromise;
      if (terminalError) throw terminalError;
      if (!finalAssistant) throw new Error("Pi Agent ended without a final assistant message");
      const draftContent = assistantText(finalAssistant);
      if (!draftContent.trim()) throw new Error("Pi Agent returned an empty final response");
      const auditedContent = deliveryWorkflow && deliveryReviewer
        ? await produceAuditedFinal({
          runner: deliveryReviewer,
          workflow: deliveryWorkflow,
          draft: draftContent,
          messages: auditMessagesForRun(ctx, transcriptMessages, finalAssistant),
          systemPrompt: buildRuntimeSystemPrompt(ctx.agentSystemPrompt, deliveryWorkflow),
          auditContext: ctx.deliveryAuditContext,
          signal: ctx.abortSignal
        })
        : draftContent;
      let finalContent = auditedContent;
      const artifact = await this.persistRequestedArtifact({
        input,
        ctx,
        requestedFilePath,
        completedArtifactPaths,
        activeSkills,
        resourceRoots,
        workspacePathPolicy,
        finalContent
      });
      for (const event of artifact.events) yield event;
      if (artifact.error) throw artifact.error;
      const savedPath = artifact.path;
      if (savedPath) finalContent = `${finalContent}\n\nCompleted and saved the result to ${savedPath}.`;
      if (deliveryWorkflow) {
        // Delivery drafts are intentionally not streamed before the audit.
        // The unified outbound Guard decides whether the accepted draft can be
        // emitted and persisted as the terminal assistant message.
        yield {
          type: "assistant.delta",
          run_id: input.run_id,
          delta: { kind: "text", content: finalContent }
        };
      } else if (savedPath) {
        // Ordinary Pi turns already streamed their final text. Emit only the
        // runtime-owned delivery suffix to avoid duplicating the answer.
        yield {
          type: "assistant.delta",
          run_id: input.run_id,
          delta: { kind: "text", content: `\n\nCompleted and saved the result to ${savedPath}.` }
        };
      }
      yield {
        type: "turn.completed",
        run_id: input.run_id,
        finish_reason: "stop"
      };
    } finally {
      agent.abort();
    }
  }

  private async persistRequestedArtifact(options: {
    input: RunStart;
    ctx: RunContext;
    requestedFilePath?: string;
    completedArtifactPaths: string[];
    activeSkills: ActivatedSkill[];
    resourceRoots: string[];
    workspacePathPolicy: WorkspacePathPolicy;
    finalContent: string;
  }): Promise<{
    path?: string;
    events: OutboundMessage[];
    error?: Error;
  }> {
    const {
      input,
      ctx,
      requestedFilePath,
      completedArtifactPaths,
      activeSkills,
      resourceRoots,
      workspacePathPolicy,
      finalContent
    } = options;
    if (!requestedFilePath || completedArtifactPaths.includes(requestedFilePath)) {
      return { events: [] };
    }

    const toolCallId = `${input.run_id}_delivery`;
    const argumentsValue = { path: requestedFilePath, content: finalContent };
    const eventBase = toolEventBase(
      input,
      toolCallId,
      "file_write",
      argumentsValue,
      resourceRoots,
      activeSkills,
      ctx.sessionSkills.rendered.aliases,
      ctx
    );
    const events: OutboundMessage[] = [
      {
        type: "assistant.delta",
        run_id: input.run_id,
        delta: { kind: "status", content: "Saving the completed work to your Workspace." }
      },
      { ...eventBase, status: "requested" }
    ];
    try {
      const result = await executeChatTool(
        input,
        ctx,
        toolCallId,
        "file_write",
        argumentsValue,
        resourceRoots,
        activeSkills,
        ctx.sessionSkills.rendered.aliases,
        workspacePathPolicy
      );
      const visibleResult = modelVisibleToolResult(eventBase.name, result);
      events.push({ ...eventBase, status: "completed", result: visibleResult });
      const diffEvent = workspaceDiffEvent(input.run_id, toolCallId, eventBase.name, result);
      if (diffEvent) events.push(diffEvent);
      completedArtifactPaths.push(requestedFilePath);
      return { path: requestedFilePath, events };
    } catch (error) {
      events.push({
        ...eventBase,
        status: "failed",
        error: { code: "tool_failed", message: errorMessage(error) }
      });
      return { events, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private createTool(
    input: RunStart,
    ctx: RunContext,
    definition: PiToolDefinition,
    getActiveSkills: () => ActivatedSkill[],
    getResourceRoots: () => string[],
    workspacePathPolicy: WorkspacePathPolicy
  ): AgentTool<any> {
    return {
      name: definition.function.name,
      label: definition.function.name,
      description: definition.function.description,
      parameters: Type.Unsafe(definition.function.parameters),
      execute: async (toolCallId, args, signal) => {
        ensureNotCancelled(ctx);
        if (signal?.aborted) throw new Error("Tool execution aborted");
        let result: Record<string, unknown>;
        try {
          result = await executeChatTool(
            input,
            ctx,
            toolCallId,
            definition.function.name,
            args as Record<string, unknown>,
            getResourceRoots(),
            getActiveSkills(),
            ctx.sessionSkills.rendered.aliases,
            workspacePathPolicy
          );
        } catch (error) {
          result = {
            status: "error",
            error: { code: "tool_failed", message: errorMessage(error) }
          };
        }
        ensureNotCancelled(ctx);
        const visibleResult = boundToolResult(modelVisibleToolResult(definition.function.name, result));
        return {
          content: [{ type: "text", text: JSON.stringify(visibleResult) }],
          details: visibleResult
        };
      }
    };
  }

  private async handleEvent(options: {
    event: AgentEvent;
    agent: Agent;
    input: RunStart;
    ctx: RunContext;
    queue: AsyncQueue<OutboundMessage>;
    toolEvents: Map<string, ToolEventState>;
    workspacePathPolicy: WorkspacePathPolicy;
    getActiveSkills: () => ActivatedSkill[];
    setActiveSkills: (skills: ActivatedSkill[]) => void;
    getResourceRoots: () => string[];
    setHasExecutedTool: () => void;
    deliveryWorkflow?: RunContext["deliveryWorkflow"];
    transcriptMessages: ConversationMessage[];
    completedArtifactPaths: string[];
    seenImplicitInvocations: Set<string>;
    setFinalAssistant: (message: AssistantMessage) => void;
    setTerminalError: (error: Error) => void;
  }): Promise<void> {
    const {
      event,
      agent,
      input,
      ctx,
      queue,
      toolEvents,
      workspacePathPolicy,
      getActiveSkills,
      setActiveSkills,
      getResourceRoots,
      setHasExecutedTool,
      deliveryWorkflow,
      transcriptMessages,
      completedArtifactPaths,
      seenImplicitInvocations,
      setFinalAssistant,
      setTerminalError
    } = options;

    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta" && !deliveryWorkflow) {
        queue.push({
          type: "assistant.delta",
          run_id: input.run_id,
          delta: { kind: "text", content: event.assistantMessageEvent.delta }
        });
      } else if (event.assistantMessageEvent.type === "thinking_start") {
        queue.push({
          type: "assistant.delta",
          run_id: input.run_id,
          delta: { kind: "status", content: "Thinking through the task." }
        });
      }
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const assistant = event.message as AssistantMessage;
        const converted = fromPiMessage(assistant);
        transcriptMessages.push(converted);
        const hasToolCall = assistant.content.some((block) => block.type === "toolCall");
        const hasText = assistant.content.some((block) => block.type === "text" && block.text.trim().length > 0);
        if (hasToolCall) {
          // Assistant text is guarded at the unified outbound boundary. Keep
          // only the tool-call structure in durable model history so a later
          // blocked text segment cannot race Pi's message_end persistence.
          await ctx.persistModelMessage?.({ ...converted, content: null });
        }
        if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
          setTerminalError(new Error(assistant.errorMessage ?? `Pi Agent stopped: ${assistant.stopReason}`));
        } else if (assistant.stopReason === "stop" && !hasToolCall) {
          if (hasText) setFinalAssistant(assistant);
          else setTerminalError(new Error("Pi Agent returned an empty final response"));
        }
      } else if (event.message.role === "toolResult") {
        const converted = fromPiMessage(event.message as ToolResultMessage);
        transcriptMessages.push(converted);
        await ctx.persistModelMessage?.(converted);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const args = (event.args ?? {}) as Record<string, unknown>;
      let eventBase: Extract<OutboundMessage, { type: "tool_call.delta" }>;
      let invalid = false;
      try {
        eventBase = toolEventBase(
          input,
          event.toolCallId,
          event.toolName,
          args,
          getResourceRoots(),
          getActiveSkills(),
          ctx.sessionSkills.rendered.aliases,
          ctx
        );
      } catch (error) {
        invalid = true;
        eventBase = {
          type: "tool_call.delta",
          run_id: input.run_id,
          tool_call_id: event.toolCallId,
          name: event.toolName || "unknown_tool",
          locality: "server",
          approval: "none",
          arguments: args,
          status: "requested",
          ...(ctx.toolScope ? { scope: ctx.toolScope } : {}),
          error: { code: "invalid_tool_call", message: errorMessage(error) }
        };
      }
      const visibleEventBase = deliveryWorkflow
        ? redactDeliveryWriteArguments(eventBase)
        : eventBase;
      toolEvents.set(event.toolCallId, { event: visibleEventBase, arguments: args, invalid });
      queue.push({ ...visibleEventBase, status: "requested" });
      queue.push({
        type: "assistant.delta",
        run_id: input.run_id,
        delta: { kind: "status", content: `Calling tool ${event.toolName}.` }
      });
      const invocation = await implicitSkillInvocationFromTool(
        event.toolName,
        args,
        ctx.sessionSkills.records,
        ctx.workspaceRoot
      );
      if (invocation) {
        const key = `${invocation.skill.scope}:${invocation.skill.path}:${invocation.skill.name}`;
        if (!seenImplicitInvocations.has(key)) {
          seenImplicitInvocations.add(key);
          queue.push(skillInvocationEvent(input.run_id, event.toolCallId, event.toolName, args, invocation));
        }
      }
      return;
    }

    if (event.type === "tool_execution_end") {
      setHasExecutedTool();
      const state = toolEvents.get(event.toolCallId);
      const rawEventBase = state?.event ?? toolEventBase(
        input,
        event.toolCallId,
        event.toolName,
        (event.result?.details ?? {}) as Record<string, unknown>,
        getResourceRoots(),
        getActiveSkills(),
        ctx.sessionSkills.rendered.aliases,
        ctx
      );
      const eventBase = deliveryWorkflow
        ? redactDeliveryWriteArguments(rawEventBase)
        : rawEventBase;
      const rawDetails = event.result?.details;
      const details = rawDetails && typeof rawDetails === "object"
        ? rawDetails as Record<string, unknown>
        : { result: rawDetails };
      const visibleResult = boundToolResult(modelVisibleToolResult(event.toolName, details));
      if (event.isError) {
        queue.push({
          ...eventBase,
          status: "failed",
          error: {
            code: state?.invalid ? "invalid_tool_call" : "tool_failed",
            message: state?.invalid ? "The model requested an unavailable tool." : JSON.stringify(visibleResult)
          }
        });
        if (state?.invalid) {
          setTerminalError(new Error(`Unknown Pi tool: ${event.toolName}`));
          agent.abort();
        }
      } else {
        queue.push({ ...eventBase, status: "completed", result: visibleResult });
        if (
          (eventBase.name === "fs.write" || eventBase.name === "file_write")
          && typeof eventBase.arguments?.path === "string"
        ) {
          completedArtifactPaths.push(eventBase.arguments.path);
        }
        const diffEvent = workspaceDiffEvent(input.run_id, event.toolCallId, eventBase.name, details);
        if (diffEvent) queue.push(diffEvent);
        const activation = runtimeSkillActivationFromToolResult(event.toolName, visibleResult);
        if (activation) setActiveSkills(mergeRuntimeActiveSkill(getActiveSkills(), activation));
      }
      queue.push({
        type: "assistant.delta",
        run_id: input.run_id,
        delta: {
          kind: "status",
          content: event.isError ? `Tool ${event.toolName} failed.` : `Tool ${event.toolName} completed.`
        }
      });
      return;
    }

    if (event.type === "agent_end") {
      const last = [...event.messages].reverse().find((message) => message.role === "assistant") as AssistantMessage | undefined;
      if (last && !last.errorMessage && last.stopReason !== "error" && last.stopReason !== "aborted"
        && last.content.some((block) => block.type === "text" && block.text.trim().length > 0)
        && !last.content.some((block) => block.type === "toolCall")) {
        setFinalAssistant(last);
      } else if (last) {
        setTerminalError(new Error(last.errorMessage ?? "Pi Agent ended without a final assistant response"));
      }
      return;
    }

    if (event.type === "turn_end" && ctx.state.status === "cancelled") {
      agent.abort();
    }
  }
}

function createDeliveryReviewer(): PiAgentPromptRunner {
  return runPiAgentPrompt;
}

function auditMessagesForRun(
  ctx: RunContext,
  transcriptMessages: ConversationMessage[],
  finalAssistant: AssistantMessage | undefined
): PiModelMessage[] {
  const transcript = finalAssistant && transcriptMessages.length > 0
    ? transcriptMessages.slice(0, -1)
    : transcriptMessages;
  return [
    { role: "system", content: buildRuntimeSystemPrompt(ctx.agentSystemPrompt, ctx.deliveryWorkflow) },
    ...buildRuntimeContextMessages(
      ctx.sessionSkills.projectInstructions,
      ctx.sessionSkills.rendered.section,
      ctx.activatedSkills ?? [],
      ctx.workspaceRoot
    ),
    ...ctx.messages.map(toAuditMessage),
    ...transcript.map(toAuditMessage)
  ];
}

function toAuditMessage(message: ConversationMessage): PiModelMessage {
  if (message.role === "compactionSummary") {
    return {
      role: "user",
      content: `${SUMMARY_PREFIX}${message.content ?? ""}${SUMMARY_SUFFIX}`
    };
  }
  if (message.role !== "assistant") {
    return { role: "user", content: "" };
  }
  return {
    role: message.role,
    content: message.content ?? null,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {})
  };
}

function isModelMessage(message: AgentMessage): boolean {
  return message.role === "user"
    || message.role === "assistant"
    || message.role === "toolResult"
    || message.role === "compactionSummary";
}

function piUserMessage(content: string): AgentMessage {
  return {
    role: "user",
    content,
    timestamp: Date.now()
  };
}

function toPiMessage(message: ConversationMessage): AgentMessage {
  if (message.role === "user") return piUserMessage(message.content ?? "");
  if (message.role === "compactionSummary") {
    return {
      role: "compactionSummary",
      summary: message.content ?? "",
      tokensBefore: message.tokens_before ?? 0,
      timestamp: Date.now()
    };
  }
  if (message.role === "tool") {
    return {
      role: "toolResult",
      toolCallId: message.tool_call_id ?? "unknown-tool-call",
      toolName: message.tool_name ?? toolNameFromCall(message),
      content: [{ type: "text", text: boundText(message.content ?? "") }],
      isError: false,
      details: {},
      timestamp: Date.now()
    } as ToolResultMessage;
  }
  const content: Array<Record<string, unknown>> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const call of message.tool_calls ?? []) {
    let argumentsValue: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(call.function.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) argumentsValue = parsed;
    } catch {
      argumentsValue = {};
    }
    content.push({ type: "toolCall", id: call.id, name: call.function.name, arguments: argumentsValue });
  }
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: createKimiModel().provider,
    model: KIMI_MODEL,
    usage: message.usage ?? emptyUsage(),
    stopReason: message.tool_calls?.length ? "toolUse" : "stop",
    timestamp: Date.now()
  } as unknown as AssistantMessage;
}

function fromPiMessage(message: AssistantMessage | ToolResultMessage): ConversationMessage {
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: boundText(message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")),
      tool_call_id: message.toolCallId,
      tool_name: message.toolName
    };
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const calls = message.content
    .filter((block): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> => block.type === "toolCall")
    .map((block) => ({
      id: block.id,
      type: "function" as const,
      function: { name: block.name, arguments: JSON.stringify(block.arguments) }
    }));
  return {
    role: "assistant",
    content: text || null,
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
    ...(message.usage.totalTokens > 0 ? { usage: message.usage } : {})
  };
}

function toRuntimeCompactionMessage(message: AgentMessage): {
  role: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  tool_name?: string;
  usage?: AssistantMessage["usage"];
  tokens_before?: number;
} {
  if (message.role === "user") {
    return { role: "user", content: piText(message) };
  }
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: piText(message),
      tool_call_id: message.toolCallId,
      tool_name: message.toolName
    };
  }
  if (message.role === "compactionSummary") {
    return {
      role: "compactionSummary",
      content: message.summary,
      tokens_before: message.tokensBefore
    };
  }
  if (message.role !== "assistant") {
    return { role: "user", content: "" };
  }
  return {
    role: "assistant",
    content: piText(message),
    usage: message.usage,
    tool_calls: Array.isArray((message as { content?: unknown }).content)
      ? (message as { content: unknown[] }).content.filter((block) => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "toolCall")
      : []
  };
}

function piText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object"
      && block !== null
      && (block as { type?: unknown }).type === "text"
      && typeof (block as { text?: unknown }).text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

function assistantText(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function toolNameFromCall(message: ConversationMessage): string {
  return message.tool_calls?.[0]?.function.name ?? "tool";
}

function redactDeliveryWriteArguments(
  event: Extract<OutboundMessage, { type: "tool_call.delta" }>
): Extract<OutboundMessage, { type: "tool_call.delta" }> {
  if (event.name !== "fs.write" && event.name !== "file_write") return event;
  const pathValue = event.arguments && typeof event.arguments.path === "string"
    ? { path: event.arguments.path }
    : {};
  return { ...event, arguments: pathValue };
}

function isHatchToolFailure(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return result.status === "error" && Boolean(result.error);
}

function boundToolResult(result: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(result);
  if (serialized.length <= 50_000) return result;
  return {
    status: "truncated",
    preview: serialized.slice(0, 50_000),
    total_bytes: Buffer.byteLength(serialized, "utf8")
  };
}

function boundText(value: string): string {
  return value.length <= 50_000 ? value : `${value.slice(0, 50_000)}\n[tool output truncated]`;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}
