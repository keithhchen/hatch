import { ClientToolBroker } from "../clientBroker.js";
import { type ConversationRecord, type ConversationRepository, type ConversationRunRecord, type ToolCallRecord } from "../conversationRepository.js";
import { type BoundRunStart, type ConversationMessage, type OutboundMessage, type ToolRequest } from "../protocol.js";
import { RunStateMachine } from "../runState.js";
import type { RuntimeStore } from "../store.js";
import type { ClientAttributes } from "../surfaces/contract.js";
import { withPartialOutput } from "./partialOutput.js";
import type { RunRegistry } from "./chatService.js";
import type { RunCompactions, TurnCompaction } from "./chatCompaction.js";
import type { RunEventHub } from "./runEventHub.js";
import type { RunTerminator } from "./runTerminator.js";
import { RunHandoff, type RunControl, type RunExecutor } from "./runSupervisor.js";
import type { ToolRecovery } from "./toolRecovery.js";
import { CLIENT_TOOL_NAMES } from "./toolSurface.js";

/** Everything one execution of a Run needs, with no transport in it. */
export type Turn<Scope> = {
  run: ConversationRunRecord;
  conversation: ConversationRecord;
  scope: Scope;
  /**
   * The Run starts from the transcript's last message. A user message is prompted; anything else (a tool
   * result after a restart, a history compacted after an overflow) is continued: `task_start` with no content.
   */
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
  /** Hears each message that joins the Run. */
  onSteer: (listener: () => void) => () => void;
  /** Compaction of this Run's conversation: before the turn, between tool steps, after an overflow. */
  compaction: TurnCompaction;
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

const requestOf = (call: ToolCallRecord): ToolRequest => ({
  type: "tool_call.request", run_id: call.runId, tool_call_id: call.toolCallId, name: call.name,
  arguments: call.arguments, approval: call.approval,
  ...(call.scope ? { scope: call.scope } : {}), ...(call.skillRunId ? { skill_run_id: call.skillRunId } : {})
});

const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener("abort", stop); resolve(); }, ms);
  const stop = (): void => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", stop, { once: true });
});

export class TurnExecutor<Scope> implements RunExecutor {
  constructor(private readonly deps: {
    repository: Pick<ConversationRepository, "getConversation" | "transitionRun" | "claimSteeredMessages" | "savePartialOutput" | "requestToolCall">;
    /** Ends the Run only while this executor holds it: the executor's way out, the same one a stop or a sweep takes. */
    terminator: Pick<RunTerminator, "end">;
    store: Pick<RuntimeStore, "append" | "readConversation">;
    hub: RunEventHub;
    registry: RunRegistry<Scope>;
    scopes: ScopeResolver<Scope>;
    runner: TurnRunner<Scope>;
    recovery: Pick<ToolRecovery, "plan">;
    compactions: RunCompactions;
    toolTimeoutMs: number;
    toolPollMs?: number;
  }) {}

  async execute(run: ConversationRunRecord, control: RunControl): Promise<void> {
    const { repository, store, hub, registry } = this.deps;
    const conversation = await repository.getConversation(run.conversationId);
    if (!conversation) throw new Error(`Conversation ${run.conversationId} was not found`);
    const scope = registry.scopeOf(run.id) ?? await this.deps.scopes.resolve(conversation, control.signal);
    // The repository appends each claimed message to the transcript in the claim's own transaction.
    const claimSteered = async (): Promise<ConversationMessage[]> =>
      (await repository.claimSteeredMessages(run.id)).map(({ message }) => message);
    const partial = withPartialOutput(
      (message) => hub.publish(conversation.id, message),
      (text) => repository.savePartialOutput(run.id, text)
    );
    const publish = (message: OutboundMessage): void => partial.publish(message as unknown as Record<string, unknown>);
    const state = new RunStateMachine(run.id, conversation.id, store as RuntimeStore, async (ending) => {
      const { run: ended, ended: did } = await this.deps.terminator.end(run.id, ending);
      return { ended: did, status: ended.status };
    }, async (status, reason) => {
      await repository.transitionRun(run.id, status, reason);
      publish({ type: "turn.state", run_id: run.id, status, ...(reason ? { reason } : {}) });
    }, run.status);
    const broker = new ClientToolBroker(async (message) => publish(message), store as RuntimeStore, this.deps.toolTimeoutMs, { request: (call) => repository.requestToolCall(call) });
    control.toolSession({
      handleResult: (result) => broker.handleResult(result),
      pendingRequests: () => broker.pendingRequests(),
      // Cancelling records the state change in the transcript before it cancels the waiting tool calls.
      cancelRun: async (runId, reason) => { await state.cancel(reason).catch(() => undefined); return broker.cancelRun(runId, reason); }
    });
    // An explicit stop must not leave a tool call hanging. A handoff is not an end: the calls stay recorded for the next instance.
    const releaseTools = (): void => {
      if (control.signal.reason instanceof RunHandoff) broker.abandon();
      else void broker.cancelAll("The Run stopped").catch(() => undefined);
    };
    control.signal.addEventListener("abort", releaseTools, { once: true });
    try {
      if (!await this.recover(run, conversation, state, publish, control.signal)) return;
      await claimSteered();
      const history = await store.readConversation(conversation.id);
      const last = [...history].reverse().find((message) => message.role === "user");
      if (!last) throw new Error(`Conversation ${conversation.publicId} has no user message to run from`);
      const continuing = last.kind === "task_start" || history.at(-1)?.role !== "user";
      const input: BoundRunStart = {
        type: "client.message",
        run_id: run.id,
        conversation_id: conversation.id,
        client_message_id: run.clientMessageId,
        message: { role: "user", content: continuing ? "" : last.content ?? "", ...(!continuing && last.attachments?.length ? { attachments: last.attachments } : {}) },
        local_tools: [...CLIENT_TOOL_NAMES],
        ...(registry.timeZoneOf(conversation.id) ? { time_zone: registry.timeZoneOf(conversation.id) } : {}),
        ...(continuing ? { task_start: true as const } : {})
      };
      await this.deps.runner.run({
        run, conversation, scope, input, persistedUser: last, state, broker, publish, signal: control.signal,
        clientOf: () => registry.clientOf(conversation.id) ?? FALLBACK_CLIENT,
        claimSteered,
        onSteer: control.onSteer,
        compaction: this.deps.compactions.forRun({ run, conversation, state, publish, signal: control.signal })
      });
    } finally {
      control.signal.removeEventListener("abort", releaseTools);
      await partial.flush();
    }
  }

  /**
   * A Run taken over after a crash first settles the calls the dead executor left open: results are written
   * to the transcript, a local tool that a client may still answer is waited for, and a call that may have
   * had an effect interrupts the Run. False when the Run ended here.
   */
  private async recover(run: ConversationRunRecord, conversation: ConversationRecord, state: RunStateMachine, publish: (message: OutboundMessage) => void, signal: AbortSignal): Promise<boolean> {
    let announced = false;
    for (;;) {
      signal.throwIfAborted();
      const plan = await this.deps.recovery.plan(run, await this.deps.store.readConversation(conversation.id));
      if (plan.kind === "interrupt") {
        await state.interrupt(plan.reason);
        return false;
      }
      if (plan.kind === "ready") {
        for (const message of plan.results) await this.deps.store.append({ type: "conversation.model_message", conversation_id: conversation.id, run_id: run.id, message });
        if (state.status === "waiting_for_tool") await state.resumeFromTool();
        return true;
      }
      if (!announced) {
        announced = true;
        await state.waitForTool();
        // Observers on this instance learn what the Run waits for; any client can answer it, on any instance.
        for (const call of plan.calls) publish(requestOf(call));
      }
      await sleep(this.deps.toolPollMs ?? 250, signal);
    }
  }
}
