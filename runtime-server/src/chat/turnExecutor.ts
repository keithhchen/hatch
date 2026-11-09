import { ClientToolBroker } from "../clientBroker.js";
import { ConversationRepositoryError, type ConversationRecord, type ConversationRepository, type ConversationRunRecord } from "../conversationRepository.js";
import { type BoundRunStart, type ConversationMessage, type OutboundMessage } from "../protocol.js";
import { RunStateMachine } from "../runState.js";
import type { RuntimeStore } from "../store.js";
import type { ClientAttributes } from "../surfaces/contract.js";
import { withPartialOutput } from "./partialOutput.js";
import type { RunRegistry } from "./chatService.js";
import type { RunEventHub } from "./runEventHub.js";
import type { RunControl, RunExecutor } from "./runSupervisor.js";
import { CLIENT_TOOL_NAMES } from "./toolSurface.js";

/** Everything one execution of a Run needs, with no transport in it. */
export type Turn<Scope> = {
  run: ConversationRunRecord;
  conversation: ConversationRecord;
  scope: Scope;
  /** The Run restarts from the last user message of the conversation. */
  input: BoundRunStart;
  persistedUser: ConversationMessage;
  state: RunStateMachine;
  broker: ClientToolBroker;
  publish: (message: OutboundMessage) => void;
  signal: AbortSignal;
  /** The client of the latest message: it decides which tools may run and what the reminder says. */
  clientOf: () => ClientAttributes;
  /** Hands the Run the messages that joined it; they are appended to the transcript in order. */
  claimSteered: () => Promise<ConversationMessage[]>;
};

/** Runs one turn of the Agent. The adapter wraps the existing per-turn pipeline. */
export interface TurnRunner<Scope> {
  run(turn: Turn<Scope>): Promise<void>;
}

/** Where the scope of a Run comes from when this process did not start it. */
export interface ScopeResolver<Scope> {
  resolve(conversation: ConversationRecord, signal: AbortSignal): Promise<Scope>;
}

const FALLBACK_CLIENT: ClientAttributes = { client: "web" };

export class TurnExecutor<Scope> implements RunExecutor {
  constructor(private readonly deps: {
    repository: Pick<ConversationRepository, "getConversation" | "transitionRun" | "claimSteeredMessages" | "savePartialOutput" | "getRun">;
    store: Pick<RuntimeStore, "append" | "readConversation">;
    hub: RunEventHub;
    registry: RunRegistry<Scope>;
    scopes: ScopeResolver<Scope>;
    runner: TurnRunner<Scope>;
    toolTimeoutMs: number;
  }) {}

  async execute(run: ConversationRunRecord, control: RunControl): Promise<void> {
    const { repository, store, hub, registry } = this.deps;
    const conversation = await repository.getConversation(run.conversationId);
    if (!conversation) throw new Error(`Conversation ${run.conversationId} was not found`);
    const scope = registry.scopeOf(run.id) ?? await this.deps.scopes.resolve(conversation, control.signal);
    const claimSteered = async (): Promise<ConversationMessage[]> => {
      const claimed = await repository.claimSteeredMessages(run.id);
      for (const { clientMessageId, message } of claimed) {
        await store.append({ type: "conversation.model_message", conversation_id: conversation.id, run_id: run.id, client_message_id: clientMessageId, message });
      }
      return claimed.map(({ message }) => message);
    };
    await claimSteered();
    const history = await store.readConversation(conversation.id);
    const last = [...history].reverse().find((message) => message.role === "user");
    if (!last) throw new Error(`Conversation ${conversation.publicId} has no user message to run from`);
    const taskStart = last.kind === "task_start";
    const input: BoundRunStart = {
      type: "client.message",
      run_id: run.id,
      conversation_id: conversation.id,
      client_message_id: run.clientMessageId,
      message: { role: "user", content: taskStart ? "" : last.content ?? "", ...(!taskStart && last.attachments?.length ? { attachments: last.attachments } : {}) },
      local_tools: [...CLIENT_TOOL_NAMES],
      ...(registry.timeZoneOf(conversation.id) ? { time_zone: registry.timeZoneOf(conversation.id) } : {}),
      ...(taskStart ? { task_start: true as const } : {})
    };
    const partial = withPartialOutput(
      (message) => hub.publish(conversation.id, message),
      (text) => repository.savePartialOutput(run.id, text)
    );
    const publish = (message: OutboundMessage): void => partial.publish(message as unknown as Record<string, unknown>);
    const state = new RunStateMachine(run.id, conversation.id, store as RuntimeStore, async (status, reason) => {
      await repository.transitionRun(run.id, status, reason);
      publish({ type: "turn.state", run_id: run.id, status, ...(reason ? { reason } : {}) });
    }, async () => {
      const latest = await repository.getRun(conversation.id, run.id);
      if (latest && latest.consumedCount < latest.steeredCount) throw new ConversationRepositoryError("steer_pending", `Run ${run.id} has an unclaimed message`, latest);
    });
    const broker = new ClientToolBroker(async (message) => publish(message), store as RuntimeStore, this.deps.toolTimeoutMs);
    control.toolSession({
      handleResult: (result) => broker.handleResult(result),
      pendingRequests: () => broker.pendingRequests(),
      // Cancelling records the state change in the transcript before it cancels the waiting tool calls.
      cancelRun: async (runId, reason) => { await state.cancel(reason).catch(() => undefined); return broker.cancelRun(runId, reason); }
    });
    // Whoever stops this execution (an explicit stop, or a handoff at shutdown) must not leave a tool call hanging.
    const releaseTools = (): void => { void broker.cancelAll("The Run stopped").catch(() => undefined); };
    control.signal.addEventListener("abort", releaseTools, { once: true });
    try {
      await this.deps.runner.run({
        run, conversation, scope, input, persistedUser: last, state, broker, publish, signal: control.signal,
        clientOf: () => registry.clientOf(conversation.id) ?? FALLBACK_CLIENT,
        claimSteered
      });
    } finally {
      control.signal.removeEventListener("abort", releaseTools);
      await partial.flush();
    }
  }
}
