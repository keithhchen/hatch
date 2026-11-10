import path from "node:path";
import { ZodError } from "zod";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ClientToolBroker } from "../clientBroker.js";
import type { RuntimeCompactionMessage } from "../compaction.js";
import type { AgentRuntime, RunContext, RuntimeSessionSkills } from "../agentRuntime.js";
import { ThinkingPartJournal } from "../thinkingPartJournal.js";
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
import type { RuntimeStore, VisibleConversationPart } from "../store.js";
import type { ConversationRepository, RunReply } from "../conversationRepository.js";
import { RunFenced } from "../runHold.js";
import type { ToolBridge } from "../toolBridge.js";
import {
  findCompletedDelivery,
  prepareDelivery,
  recordPreparedDelivery,
  releaseDeliveryUnit,
  reserveDeliveryUnit,
  type CommerceEventSink,
  type DeliveryArtifact,
  type DeliveryBinding,
  type DeliveryUnitReservation
} from "../delivery.js";
import type { DeliveryAccountingCommand, DeliveryAccountingOutbox } from "../deliveryOutbox.js";
import { materializeAgentCorpus, type MaterializedAgentCorpus } from "../agentCorpusMaterialization.js";
import { knowledgeProviderConfigured, type AgentCorpus } from "../agentCorpus.js";
import {
  GuardedAssistantOutput,
  OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE,
  type GuardedOutputResult,
  type OutputGuard
} from "../outputGuard.js";
import { writeOperationalError } from "../operationalLogging.js";
import type { RuntimeAssetStore } from "../assetStore.js";
import { withLangfuseTurn } from "../langfuse.js";
import type { ClientAttributes } from "../surfaces/contract.js";
import { withinImageBudget } from "./imageBudget.js";
import type { Turn } from "./turnExecutor.js";
import { RunHandoff } from "./runSupervisor.js";
import type { TurnCompaction } from "./chatCompaction.js";

/** What a model turn needs to know about the conversation it serves: who, which Product, and what it may deliver. */
export type TurnBinding = {
  creatorId: string;
  userId: string;
  productId: string;
  corpusDigest: string;
  runtimeDigest?: string;
  purchasedCorpusDigest?: string;
  /** Free purchases are permanent access; metered accounting is opt-in. */
  accessMode?: "unmetered" | "metered";
  agentCorpus?: AgentCorpus;
  agentCorpusRoot?: string;
  entitlementId?: string;
  orderId?: string;
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
};

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
  send: (message: OutboundMessage) => Promise<void>,
  outputGuard: OutputGuard,
  abortSignal: AbortSignal,
  commerceEventSink: CommerceEventSink | undefined,
  deliveryAccountingOutbox: DeliveryAccountingOutbox | undefined,
  scheduleDeliveryReconciliation: () => void,
  clientOf: () => ClientAttributes,
  claimSteered: () => Promise<ConversationMessage[]>,
  compaction: TurnCompaction,
  profile?: TurnProfile
): Promise<void> {
  const turnStarted = performance.now();
  let setupCompleted = turnStarted;
  let modelFirstText: number | undefined;
  let firstSafeSegment: number | undefined;
  const guardTiming: Array<import("../outputGuard.js").OutputGuardTiming & { released_ms?: number }> = [];
  let deliveredArtifact: DeliveryArtifact | undefined;
  const deliveryBinding = deliveryBindingFromSession(binding);
  let deliveryReservation: DeliveryUnitReservation | undefined;
  let deliveryReservationConsumed = false;
  let deliveryAccountingPending = false;
  try {
    abortSignal.throwIfAborted();
    await state.start();
    const committedInput = await store.readConversation(input.conversation_id);
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
    const guardedOutput = new GuardedAssistantOutput(
      outputGuard,
      input.run_id,
      undefined,
      undefined,
      undefined,
      (timing) => guardTiming.push({
        ...timing,
        started_ms: timing.started_ms - turnStarted
      })
    );
    let approvedAssistantText = "";
    const visibleParts: VisibleConversationPart[] = [];
    const thinkingPartJournal = new ThinkingPartJournal(visibleParts);
    const visibleActivityKeys = new Set<string>();
    const recordVisiblePart = (message: OutboundMessage): void => {
      if (!("run_id" in message) || message.run_id !== input.run_id) return;
      if (message.type === "assistant.delta" && message.delta.kind === "text") {
        const end = approvedAssistantText.length;
        const start = end - message.delta.content.length;
        if (start < 0) return;
        const last = visibleParts.at(-1);
        if (last?.type === "text" && last.end === start) {
          last.end = end;
        } else {
          visibleParts.push({ type: "text", start, end });
        }
        return;
      }
      if (
        message.type === "assistant.delta"
        && (message.delta.kind === "thinking_start"
          || message.delta.kind === "thinking_delta"
          || message.delta.kind === "thinking_end")
      ) {
        thinkingPartJournal.accept(message.delta);
        return;
      }
      if (message.type === "tool_call.delta") {
        const key = `tool:${message.tool_call_id}`;
        if (!visibleActivityKeys.has(key)) {
          visibleActivityKeys.add(key);
          visibleParts.push({ type: "tool_call", tool_call_id: message.tool_call_id });
        }
        return;
      }
      if (message.type === "skill.invoked" || message.type === "skill.activated") {
        const key = [
          "skill",
          message.status,
          message.name,
          message.reason,
          "source_tool_call_id" in message ? message.source_tool_call_id : ""
        ].join(":");
        if (!visibleActivityKeys.has(key)) {
          visibleActivityKeys.add(key);
          visibleParts.push({
            type: "skill_event",
            name: message.name,
            status: message.status,
            reason: message.reason,
            ...(message.type === "skill.invoked" ? { source_tool_call_id: message.source_tool_call_id } : {})
          });
        }
        return;
      }
      if (message.type === "skill.run") {
        const key = `skill-run:${message.skill_run_id}`;
        if (!visibleActivityKeys.has(key)) {
          visibleActivityKeys.add(key);
          visibleParts.push({ type: "skill_run", skill_run_id: message.skill_run_id });
        }
      }
    };
    const emit = async (message: OutboundMessage): Promise<void> => {
      await send(message);
      recordVisiblePart(message);
    };
    const emitReleased = async (result: GuardedOutputResult): Promise<void> => {
      for (const content of result.released) {
        approvedAssistantText += content;
        const releasedAt = performance.now();
        firstSafeSegment ??= releasedAt;
        await emit({
          type: "assistant.delta",
          run_id: input.run_id,
          delta: { kind: "text", content }
        });
        const timing = guardTiming.find((entry) => entry.outcome === "pass" && entry.released_ms === undefined);
        if (timing) timing.released_ms = releasedAt - turnStarted;
      }
    };
    const commitTerminal = async (
      finishReason: OutputFinishReason,
      recordDelivery = true
    ): Promise<void> => {
      let receiptStatus: "recorded" | "syncing" | undefined;
      // The reply is written by the Run's ending, in the same transaction as its status: a crash cannot leave a reply on a Run that was not ended.
      const reply: RunReply = {
        message: { role: "assistant", content: finishReason === "content_filter" ? OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE : approvedAssistantText },
        finishReason,
        visibleParts: finishReason === "content_filter"
          ? visibleParts.filter((part) => part.type === "thinking")
          : visibleParts
      };
      if (finishReason === "stop" && recordDelivery && commerceEventSink && deliveryBinding) {
        const receipt = prepareDelivery(
          deliveryBinding,
          input.conversation_id,
          input.run_id,
          deliveredArtifact ?? { type: "message", content: approvedAssistantText }
        );
        try {
          const recorded = await recordPreparedDelivery(
            commerceEventSink,
            deliveryBinding,
            input.conversation_id,
            input.run_id,
            receipt,
            deliveryReservation
          );
          deliveryReservationConsumed = Boolean(deliveryReservation);
          receiptStatus = "recorded";
          await emit({ type: "delivery.ready", run_id: input.run_id, ...recorded, receipt_status: receiptStatus });
        } catch (error) {
          if (!deliveryAccountingOutbox || !deliveryReservation) throw error;
          const command: DeliveryAccountingCommand = {
            version: 1,
            commandId: receipt.delivery_id,
            binding: deliveryBinding,
            conversationId: input.conversation_id,
            runId: input.run_id,
            artifact: { type: receipt.artifact_type, digest: receipt.artifact_digest },
            reservation: deliveryReservation
          };
          await deliveryAccountingOutbox.enqueue(command);
          deliveryAccountingPending = true;
          receiptStatus = "syncing";
          writeOperationalError("commerce_delivery_receipt_deferred", error);
          await emit({ type: "delivery.ready", run_id: input.run_id, ...receipt, receipt_status: receiptStatus });
          scheduleDeliveryReconciliation();
        }
      }
      const completedAt = performance.now();
      await emit({
        type: "turn.completed",
        run_id: input.run_id,
        finish_reason: finishReason,
        ...(receiptStatus ? { receipt_status: receiptStatus } : {}),
        timing: {
          total_ms: completedAt - turnStarted,
          setup_ms: setupCompleted - turnStarted,
          ...(modelFirstText === undefined ? {} : { model_first_text_ms: modelFirstText - turnStarted }),
          ...(firstSafeSegment === undefined ? {} : { first_safe_segment_ms: firstSafeSegment - turnStarted }),
          guard: guardTiming
        }
      });
      await state.complete(reply);
    };
    const sendFixedAssistant = async (content: string): Promise<void> => {
      const pushed = await guardedOutput.push(content);
      await emitReleased(pushed);
      if (pushed.blocked) {
        await commitTerminal("content_filter", false);
        return;
      }
      const final = await guardedOutput.finish();
      await emitReleased(final);
      await commitTerminal(final.blocked ? "content_filter" : "stop", false);
    };
    if (commerceEventSink && deliveryBinding) {
      const completedDelivery = await findCompletedDelivery(
        commerceEventSink,
        deliveryBinding,
        input.conversation_id,
        input.run_id
      );
      if (completedDelivery) {
        await send({ type: "delivery.ready", run_id: input.run_id, ...completedDelivery, receipt_status: "recorded" });
        await sendFixedAssistant("This delivery was already completed. The existing artifact has not been changed.");
        return;
      }
    }
    if (input.message.content.trim() === "/compact") {
      await compaction.manual(committedInput);
      await sendFixedAssistant("Compaction complete.");
      return;
    }

    if (commerceEventSink && deliveryBinding) {
      deliveryReservation = await reserveDeliveryUnit(
        commerceEventSink,
        deliveryBinding,
        input.conversation_id,
        input.run_id
      );
    }

    const preTurnCompaction = await compaction.ifNeeded(committedInput, "pre_turn");
    let runtimeMessages = committedInput;
    if (preTurnCompaction) {
      runtimeMessages = preTurnCompaction.replacement_history;
    }

    setupCompleted = performance.now();
    // Older images beyond the byte budget leave the model's view; the path labels in the text stay.
    const messages = withinImageBudget(runtimeMessages);

    // Store/materialization work may race with a disconnect. Never start a
    // provider request after the owning run has already been aborted.
    abortSignal.throwIfAborted();
    const briefSnapshot = (await conversationRepository.getConversation(input.conversation_id))?.briefSnapshot;
    const contextFor = (messages: ConversationMessage[]): RunContext => ({
      clientBroker: broker,
      assetStore,
      serverTools,
      state,
      messages,
      sessionSkills,
      activatedSkills: [],
      clientTools: materializedAgent?.localTools ?? input.local_tools,
      allowedExternalTools: materializedAgent?.externalTools,
      externalToolDefinitions: materializedAgent?.externalToolDefinitions,
      persistModelMessage: async (message) => {
        await store.append({
          type: "conversation.model_message",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          message
        });
      },
      compactMessagesIfNeeded: async (runtimeMessages: RuntimeCompactionMessage[], phase) => (await compaction.ifNeeded(runtimeMessages, phase))?.replacement_history,
      toolBridge,
      toolScope: "main",
      agentSystemPrompt: materializedAgent?.systemPrompt,
      ...(profile?.liveState ? { liveState: profile.liveState } : {}),
      ...(profile?.ownPrompt ? { ownPrompt: true } : {}),
      ...(profile?.mayStaySilent ? { mayStaySilent: true } : {}),
      briefSnapshot,
      deliveryAuditContext: materializedAgent?.deliveryAuditContext,
      knowledgeAvailable: Boolean(
        binding.agentCorpus?.knowledge.documents.length
        && knowledgeProviderConfigured()
      ),
      abortSignal,
      clientAttributes: clientOf,
      claimSteered
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
          currentMessages = await store.readConversation(input.conversation_id);
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
      await persistServerToolCallEvent(event, input, store);
      await persistSkillEvent(event, input, store);
      if (event.type === "assistant.delta" && event.delta.kind === "text") {
        modelFirstText ??= performance.now();
        const result = await guardedOutput.push(event.delta.content);
        await emitReleased(result);
        if (result.blocked) {
          await commitTerminal("content_filter");
          return;
        }
        continue;
      }
      if (
        event.type === "tool_call.delta"
        && event.locality === "client"
        && event.name === "file_write"
        && event.status === "completed"
        && typeof event.arguments?.content === "string"
      ) {
        deliveredArtifact = {
          type: "file",
          content: event.arguments.content
        };
      }
      if (event.type === "turn.completed") {
        const final = await guardedOutput.finish();
        await emitReleased(final);
        const latest = await conversationRepository.getRun(input.conversation_id, input.run_id);
        if (latest && latest.consumedCount < latest.steeredCount && !final.blocked) {
          // A message joined after the last claim: keep this answer, leave the Run open, and
          // the supervisor runs it again from that message.
          await store.append({
            type: "conversation.model_message",
            conversation_id: input.conversation_id,
            run_id: input.run_id,
            message: { role: "assistant", content: approvedAssistantText },
            finish_reason: "stop",
            visible_parts: visibleParts
          });
          return;
        }
        await commitTerminal(
          event.finish_reason === "content_filter" || final.blocked
            ? "content_filter"
            : "stop"
        );
        return;
      }
      await emit(event);
    }
  } catch (error) {
    if (state.status === "cancelled" || state.status === "interrupted") {
      return;
    }
    // Shutting down is a handoff; another instance continues the Run.
    if (abortSignal.reason instanceof RunHandoff || error instanceof RunFenced) return;
    await recordFailure({ run: input.run_id, conversation: input.conversation_id }, error, state);
  } finally {
    if (commerceEventSink && deliveryReservation && !deliveryReservationConsumed && !deliveryAccountingPending) {
      const releaseReason = state.status === "cancelled"
        ? "run_cancelled"
        : state.status === "failed"
          ? "run_failed"
          : "delivery_not_completed";
      await releaseDeliveryUnit(commerceEventSink, deliveryReservation, releaseReason).catch((error) => {
        writeOperationalError("commerce_delivery_reservation_release_failed", error);
      });
    }
  }
}

function deliveryBindingFromSession(binding: TurnBinding): DeliveryBinding | undefined {
  // Permanent free purchases do not reserve, consume, or produce delivery
  // events. Metering is an explicit future paid-product capability.
  if (binding.accessMode !== "metered" || !binding.entitlementId || !binding.orderId) return undefined;
  return {
    entitlementId: binding.entitlementId,
    orderId: binding.orderId,
    userId: binding.userId,
    creatorId: binding.creatorId,
    agentId: binding.productId,
    productId: binding.productId,
    purchasedCorpusDigest: binding.purchasedCorpusDigest ?? binding.corpusDigest,
    corpusDigest: binding.corpusDigest
  };
}

async function persistSkillEvent(
  event: OutboundMessage,
  input: RunStart,
  store: RuntimeStore
): Promise<void> {
  if (event.type === "skill.activated") {
    await store.append({
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
  await store.append({
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
  store: RuntimeStore
): Promise<void> {
  if (event.type !== "tool_call.delta" || event.locality !== "server") {
    return;
  }
  await store.append({
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
  await state.fail(failures.translate(error, scope)).catch(() => undefined);
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
