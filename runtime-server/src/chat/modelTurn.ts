import { reported } from "../observability/reported.js";
import path from "node:path";
import { ZodError } from "zod";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ClientToolBroker } from "../clientBroker.js";
import type { RuntimeCompactionMessage } from "../compaction.js";
import type { AgentRuntime, RunContext, RuntimeSessionSkills } from "../agentRuntime.js";
import {
  TASK_START_MESSAGE_CONTENT,
  type BoundRunStart,
  type ConversationMessage,
  type OutboundMessage,
  type OutputFinishReason,
  type RunStart
} from "../protocol.js";
import type { RunStateMachine } from "../runState.js";
import { failures } from "../errors/failures.js";
import type { ServerToolExecutor } from "../serverTools.js";
import type { RuntimeStore } from "../store.js";
import type { RunLog } from "./runLog.js";
import type { ConversationRepository } from "../conversationRepository.js";
import { RunFenced } from "../runHold.js";
import type { ToolBridge } from "../toolBridge.js";
import { materializeAgentCorpus, type MaterializedAgentCorpus } from "../agentCorpusMaterialization.js";
import type { AgentCorpus } from "../agentCorpus.js";
import {
  GuardedAssistantOutput,
  OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE,
  type GuardedOutputResult,
  type OutputGuard
} from "../outputGuard.js";
import type { RuntimeAssetStore } from "../assetStore.js";
import { withLangfuseTurn } from "../langfuse.js";
import type { ClientAttributes } from "../surfaces/contract.js";
import { withinImageBudget } from "./imageBudget.js";
import type { Turn } from "./turnExecutor.js";
import { RunHandoff } from "./runSupervisor.js";
import type { TurnCompaction } from "./chatCompaction.js";
import type { UsageSink, UsageSurface } from "../usage/usage.js";

/** What a model turn needs to know about the conversation it serves: who, which Product, and what it may deliver. */
export type TurnBinding = {
  creatorId: string;
  userId: string;
  productId: string;
  corpusDigest: string;
  runtimeDigest?: string;
  agentCorpus?: AgentCorpus;
  agentCorpusRoot?: string;
  /** Where the Run's tokens are counted. Absent is app or channel chat; the Responses API says `responses_api` and its key. */
  usageSurface?: UsageSurface;
  apiKeyId?: string;
};

/** The agent a turn runs as: its instructions and tools. A Product's comes from its Corpus; another host supplies its own. */
export type MaterializedTurnAgent = Omit<MaterializedAgentCorpus, "deliveryAuditContext"> & Partial<Pick<MaterializedAgentCorpus, "deliveryAuditContext">>;

/** What a host adds to a turn beyond its Product binding. */
export type TurnProfile = {
  /** The agent this turn runs as, when it does not come from a Corpus. */
  agent?: MaterializedTurnAgent;
  /** Rebuilt for every model call and never stored: the host's view of things right now. */
  liveState?: RunContext["liveState"];
  /** The agent's prompt is its own whole prompt, not an Expert's instructions. */
  ownPrompt?: boolean;
  /** A Run may end having said nothing. */
  mayStaySilent?: boolean;
  /** Records each model call against whoever pays for the Run. */
  usage?: UsageSink;
  /** Server tools this turn may use beyond the agent's own, by registry name. */
  extraTools?: string[];
  /** Appended to the agent's system prompt. */
  promptSuffix?: string;
  /** Replaces the chat reply reminder on every model call of this Run. */
  turnReminder?: (now: Date) => string;
  /** This Run's tool budget, when it differs from a chat reply's. */
  toolCallLimit?: { max: number; uncounted: string[] };
};

/**
 * Answering again has no new user message: the transcript still ends with the reply an interrupted or failed Run left.
 * The model answers the latest user message afresh, so that reply and its tool calls stay in the history but leave the context.
 */
export function untilLastUser(messages: ConversationMessage[]): ConversationMessage[] {
  const last = messages.map((message) => message.role).lastIndexOf("user");
  return last < 0 ? messages : messages.slice(0, last + 1);
}

export async function runModelTurn(...args: Parameters<typeof runModelTurnInternal>): Promise<void> {
  const [input, , , binding] = args;
  return withLangfuseTurn("user-runtime.turn", input.message.content, () => runModelTurnInternal(...args), {
    productId: binding.productId,
    userId: binding.userId,
    conversationId: input.conversation_id
  });
}

async function runModelTurnInternal(
  input: BoundRunStart,
  persistedUserMessage: ConversationMessage,
  sessionSkills: RuntimeSessionSkills,
  binding: TurnBinding,
  broker: ClientToolBroker,
  serverTools: ServerToolExecutor,
  toolBridge: ToolBridge,
  runtime: AgentRuntime,
  store: RuntimeStore,
  conversationRepository: ConversationRepository,
  assetStore: RuntimeAssetStore,
  state: RunStateMachine,
  runLog: RunLog,
  outputGuard: OutputGuard,
  abortSignal: AbortSignal,
  clientOf: () => ClientAttributes,
  claimSteered: () => Promise<ConversationMessage[]>,
  onSteer: (listener: () => void) => () => void,
  compaction: TurnCompaction,
  profile?: TurnProfile
): Promise<void> {
  try {
    abortSignal.throwIfAborted();
    await state.start();
    const committedInput = untilLastUser(await store.readConversation(input.conversation_id));
    // The wire-level task_start message is intentionally empty, but the
    // Runtime's canonical user turn is not. Keep the same marked message in
    // the durable transcript and pass its non-empty content to the Agent.
    const runtimeInput: RunStart = input.task_start
      ? { ...input, message: { role: "user", content: TASK_START_MESSAGE_CONTENT } }
      : {
        ...input,
        message: {
          role: "user",
          content: persistedUserMessage.content ?? "",
          ...(persistedUserMessage.attachments?.length ? { attachments: persistedUserMessage.attachments } : {})
        }
      };
    // Execution consumes the accepted canonical history, including images.
    // No second append, image materialization, or journal repair is allowed.
    const materializedAgent = profile?.agent ?? (binding.agentCorpusRoot
      ? await materializeAgentCorpus(
        binding.agentCorpusRoot,
        input.message.content,
        input.local_tools,
        binding.runtimeDigest ?? binding.corpusDigest,
        abortSignal
      )
      : undefined);
    const guardedOutput = new GuardedAssistantOutput(outputGuard, input.run_id);
    let approvedAssistantText = "";
    // Text the guard released goes to the log; the Run's other events (steps, skills) were written as they happened.
    const emitReleased = (result: GuardedOutputResult): void => {
      for (const content of result.released) {
        approvedAssistantText += content;
        runLog.text(content);
      }
    };
    const commitTerminal = async (finishReason: OutputFinishReason): Promise<void> => {
      // The reply is written by the Run's ending, in the same transaction as its status: a crash cannot leave a reply on a Run that was not ended.
      if (finishReason === "content_filter") await runLog.append({ type: "reply.blocked", conversation_id: input.conversation_id, run_id: input.run_id });
      await state.complete({
        message: { role: "assistant", content: finishReason === "content_filter" ? OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE : approvedAssistantText },
        finishReason
      });
    };
    const sendFixedAssistant = async (content: string): Promise<void> => {
      const pushed = await guardedOutput.push(content);
      emitReleased(pushed);
      if (pushed.blocked) {
        await commitTerminal("content_filter");
        return;
      }
      const final = await guardedOutput.finish();
      emitReleased(final);
      await commitTerminal(final.blocked ? "content_filter" : "stop");
    };
    if (input.message.content.trim() === "/compact") {
      await compaction.manual(committedInput);
      await sendFixedAssistant("Compaction complete.");
      return;
    }

    const preTurnCompaction = await compaction.ifNeeded(committedInput, "pre_turn");
    let runtimeMessages = committedInput;
    if (preTurnCompaction) {
      runtimeMessages = preTurnCompaction.replacement_history;
    }

    // Older images beyond the byte budget leave the model's view; the path labels in the text stay.
    const messages = withinImageBudget(runtimeMessages);

    // Store/materialization work may race with a disconnect. Never start a
    // provider request after the owning run has already been aborted.
    abortSignal.throwIfAborted();
    const briefSnapshot = (await conversationRepository.getConversation(input.conversation_id))?.briefSnapshot;
    const contextFor = (messages: ConversationMessage[]): RunContext => ({
      productId: binding.productId,
      clientBroker: broker,
      assetStore,
      serverTools,
      state,
      messages,
      sessionSkills,
      activatedSkills: [],
      clientTools: materializedAgent?.localTools ?? input.local_tools,
      allowedExternalTools: profile?.extraTools ? [...materializedAgent?.externalTools ?? [], ...profile.extraTools] : materializedAgent?.externalTools,
      externalToolDefinitions: materializedAgent?.externalToolDefinitions,
      usage: profile?.usage,
      persistModelMessage: async (message) => {
        await runLog.append({
          type: "conversation.model_message",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          message
        });
      },
      compactMessagesIfNeeded: async (runtimeMessages: RuntimeCompactionMessage[], phase) => (await compaction.ifNeeded(runtimeMessages, phase))?.replacement_history,
      toolBridge,
      toolScope: "main",
      agentSystemPrompt: materializedAgent && profile?.promptSuffix ? `${materializedAgent.systemPrompt}\n\n${profile.promptSuffix}` : materializedAgent?.systemPrompt,
      ...(profile?.liveState ? { liveState: profile.liveState } : {}),
      ...(profile?.turnReminder ? { turnReminder: profile.turnReminder } : {}),
      ...(profile?.toolCallLimit ? { toolCallLimit: profile.toolCallLimit } : {}),
      ...(profile?.ownPrompt ? { ownPrompt: true } : {}),
      ...(profile?.mayStaySilent ? { mayStaySilent: true } : {}),
      briefSnapshot,
      deliveryAuditContext: materializedAgent?.deliveryAuditContext,
      abortSignal,
      clientAttributes: clientOf,
      claimSteered,
      onSteer
    });
    // A provider that refuses the request as too large is answered by compacting, a bounded number of times, and continuing.
    const attempts = async function* (): AsyncGenerator<OutboundMessage> {
      let current = runtimeInput;
      let currentMessages = messages;
      for (;;) {
        try {
          yield* runtime.run(current, contextFor(currentMessages));
          return;
        } catch (error) {
          const overflow = isContextOverflow({ stopReason: "error", errorMessage: errorMessage(error) } as AssistantMessage);
          const recovered = overflow ? await compaction.recoverFromOverflow(await store.readConversation(input.conversation_id)) : undefined;
          if (!recovered) throw error;
          currentMessages = untilLastUser(await store.readConversation(input.conversation_id));
          // Where the transcript ends decides how the turn resumes: a user message is prompted, anything else continued.
          current = currentMessages.at(-1)?.role === "user"
            ? runtimeInput
            : { ...runtimeInput, task_start: true, message: { role: "user", content: TASK_START_MESSAGE_CONTENT } };
        }
      }
    };
    for await (const event of attempts()) {
      if (state.status === "cancelled" || state.status === "interrupted") {
        break;
      }
      await persistServerToolCallEvent(event, input, runLog);
      await persistSkillEvent(event, input, runLog);
      if (event.type === "assistant.delta" && event.delta.kind === "text") {
        const result = await guardedOutput.push(event.delta.content);
        emitReleased(result);
        if (result.blocked) {
          await commitTerminal("content_filter");
          return;
        }
        continue;
      }
      if (event.type === "assistant.delta") {
        const { delta } = event;
        if (delta.kind === "thinking_start" || delta.kind === "thinking_delta" || delta.kind === "thinking_end") await runLog.thinking(delta);
        continue;
      }
      if (event.type === "turn.completed") {
        const final = await guardedOutput.finish();
        emitReleased(final);
        const latest = await conversationRepository.getRun(input.conversation_id, input.run_id);
        if (latest && latest.consumedCount < latest.steeredCount && !final.blocked) {
          // A message joined after the last claim: keep this answer, leave the Run open, and
          // the supervisor runs it again from that message.
          // The ending keeps the reply and, because a message is unclaimed, leaves the Run open.
          await state.complete({ message: { role: "assistant", content: approvedAssistantText }, finishReason: "stop" });
          return;
        }
        await commitTerminal(
          final.blocked ? "content_filter" : event.finish_reason
        );
        return;
      }
    }
  } catch (error) {
    if (state.status === "cancelled" || state.status === "interrupted") {
      return;
    }
    // Shutting down is a handoff; another instance continues the Run.
    if (abortSignal.reason instanceof RunHandoff || error instanceof RunFenced) return;
    await recordFailure({ run: input.run_id, conversation: input.conversation_id }, error, state);
  }
}

async function persistSkillEvent(
  event: OutboundMessage,
  input: RunStart,
  runLog: RunLog
): Promise<void> {
  if (event.type === "skill.activated") {
    await runLog.append({
      type: "skill.activated",
      conversation_id: input.conversation_id,
      run_id: input.run_id,
      name: event.name,
      path: event.path,
      scope: event.scope,
      directory: path.dirname(event.path),
      // The complete Skill instructions are already injected into the model
      // context. Persist only activation metadata so protected Skill content
      // is not duplicated in the visible conversation journal.
      content: "",
      invocation_type: event.invocation_type,
      reason: event.reason,
      resource_paths: event.resource_paths,
      resource_manifest_truncated: event.resource_manifest_truncated
    });
    return;
  }
  if (event.type !== "skill.invoked") {
    return;
  }
  await runLog.append({
    type: "skill.invoked",
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    name: event.name,
    path: event.path,
    scope: event.scope,
    invocation_type: event.invocation_type,
    reason: event.reason,
    source_tool_call_id: event.source_tool_call_id,
    trigger: event.trigger
  });
}

async function persistServerToolCallEvent(
  event: OutboundMessage,
  input: RunStart,
  runLog: RunLog
): Promise<void> {
  if (event.type !== "tool_call.delta" || event.locality !== "server") {
    return;
  }
  await runLog.append({
    type: "tool.call",
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    tool_call_id: event.tool_call_id,
    name: event.name,
    arguments: event.arguments ?? {},
    status: event.status,
    activity_message: event.activity_message,
    locality: event.locality,
    approval: event.approval,
    ...(event.result ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {})
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * A Run whose execution threw: ended once, with the one failure shape the failure boundary builds. The ending is the Run's
 * only exit, so it claims any message that joined the Run, writes the journal, and tells every observer, after it commits.
 */
async function recordFailure(
  scope: { run: string; conversation: string },
  error: unknown,
  state: RunStateMachine
): Promise<void> {
  await state.fail(failures.translate(error, scope)).catch(reported("run_fail_unrecorded", { run_id: scope.run, conversation_id: scope.conversation }));
}

export async function failRun(turn: Pick<Turn<unknown>, "run" | "conversation" | "signal" | "state">, error: unknown): Promise<void> {
  if (turn.signal.reason instanceof RunHandoff) return;
  await recordFailure({ run: turn.run.id, conversation: turn.conversation.id }, error, turn.state);
}

/** A conversation whose agent has no Skills. */
export const NO_SKILLS: RuntimeSessionSkills = {
  records: [],
  visibleRecords: [],
  rendered: {
    section: "",
    aliases: {},
    report: { total_count: 0, included_count: 0, omitted_count: 0, truncated_description_chars: 0, truncated_description_count: 0 }
  }
};
