import type { ConversationMessage } from "../protocol.js";
import type { AlsoCommit, ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import type { ClientAttributes, Principal } from "../surfaces/contract.js";
import { failures } from "../errors/failures.js";
import type { RunEventHub } from "./runEventHub.js";
import type { RunTerminator } from "./runTerminator.js";
import type { RunSupervisor } from "./runSupervisor.js";
import { ChatError } from "./principal.js";
import { assertProductUsable } from "./toolSurface.js";

/** Capacity for one more Run. Reserving can fail; the returned function gives the capacity back. */
export interface RunAdmission {
  reserve(principal: Principal): () => void;
}

/** Limits that must hold before a Run exists, such as a contact's message allowance. */
export interface PrincipalLimits {
  check(principal: Principal, conversation: ConversationRecord): Promise<void>;
}

export type SubmitCommand<Scope> = {
  principal: Principal;
  /** Already authorized for this principal by the transport that received the message. */
  conversation: ConversationRecord;
  /** What the executor needs to run this principal's turn; opaque to the Chat API. */
  scope: Scope;
  client: ClientAttributes;
  clientMessageId: string;
  /** The canonical user message, made only when this client key is new: a retry needs no asset work. */
  message: () => Promise<ConversationMessage>;
  /** Commits with the message, when it is new: binding its assets. */
  bind?: AlsoCommit;
  digest: string;
  runId: string;
  corpusDigest: string;
  requiresLocalTools: boolean;
  timeZone?: string;
};

/** `started`: a new Run. `steered`: it joined the active Run. `replayed`: this client key was already accepted. */
export type Submission = {
  outcome: "started" | "steered" | "replayed";
  run: ConversationRunRecord;
  clientMessageId: string;
  acceptedAt: string;
};

/** What the executor needs to know about a conversation while its Runs are alive. */
export class RunRegistry<Scope> {
  private readonly scopes = new Map<string, Scope>();
  private readonly clients = new Map<string, ClientAttributes>();
  private readonly timeZones = new Map<string, string>();

  rememberScope(runId: string, scope: Scope): void { this.scopes.set(runId, scope); }
  scopeOf(runId: string): Scope | undefined { return this.scopes.get(runId); }
  forget(runId: string): void { this.scopes.delete(runId); }
  /** The client of the latest message decides which tools may run. */
  rememberClient(conversationId: string, client: ClientAttributes, timeZone?: string): void {
    this.clients.set(conversationId, client);
    if (timeZone) this.timeZones.set(conversationId, timeZone);
  }
  timeZoneOf(conversationId: string): string | undefined { return this.timeZones.get(conversationId); }
  clientOf(conversationId: string): ClientAttributes | undefined { return this.clients.get(conversationId); }
}

/**
 * The one way a message enters a conversation, from any client and any transport:
 * steer the active Run or start one, atomically, then let the supervisor own it.
 */
export class ChatService<Scope> {
  constructor(private readonly deps: {
    repository: Pick<ConversationRepository, "acceptSubmission" | "getActiveRun" | "hasAcceptedMessage">;
    /** A Run that cannot be admitted ends here, like any other: observers and the journal both hear of it. */
    terminator: Pick<RunTerminator, "end">;
    supervisor: Pick<RunSupervisor, "adopt" | "executorId" | "holdsConversation">;
    hub: RunEventHub;
    admission: RunAdmission;
    registry: RunRegistry<Scope>;
    limits?: PrincipalLimits;
    /** A message that may start a Run first ends the conversation's background compaction, on any instance. */
    compaction?: { preempt(conversationId: string): Promise<void> };
  }) {}

  async submit(command: SubmitCommand<Scope>): Promise<Submission> {
    const { repository, supervisor, hub, admission, registry, limits, compaction, terminator } = this.deps;
    assertProductUsable(command.requiresLocalTools, command.client.client);
    await limits?.check(command.principal, command.conversation);
    // A message that joins a Run adds no work, so capacity is only reserved for one that may start a Run.
    const known = await repository.hasAcceptedMessage(command.conversation.id, command.clientMessageId);
    const joining = await repository.getActiveRun(command.conversation.id);
    // A cancelled Run whose executor is still winding down must not overlap the next one in the same conversation.
    if (!joining && supervisor.holdsConversation(command.conversation.id)) {
      throw new ChatError("conversation_busy", "The previous run is still stopping. Try again in a moment.", 409);
    }
    let release = joining ? () => undefined : admission.reserve(command.principal);
    try {
      // The new message aborts a compaction running after the last reply, and waits until it has ended.
      if (!joining) await compaction?.preempt(command.conversation.id);
      const accepted = await repository.acceptSubmission({
        binding: command.conversation,
        run: {
          id: command.runId,
          conversationId: command.conversation.id,
          clientMessageId: command.clientMessageId,
          inputDigest: command.digest,
          corpusDigest: command.corpusDigest,
          executorId: supervisor.executorId
        },
        canonicalUser: known ? { role: "user", content: "" } : await command.message()
      }, known ? undefined : command.bind);
      const outcome = accepted.created ? "started" : accepted.steered ? "steered" : "replayed";
      if (outcome === "started" && joining) {
        // The Run we meant to join ended first, so this one starts a Run after all: admit it now.
        try { release = admission.reserve(command.principal); }
        catch (error) {
          const failure = error instanceof ChatError ? { code: error.code, message: error.message } : failures.translate(error, { run: accepted.run.id, conversation: command.conversation.id });
          await terminator.end(accepted.run.id, { status: "failed", failure });
          throw error;
        }
      }
      if (outcome !== "replayed") registry.rememberClient(command.conversation.id, command.client, command.timeZone);
      if (outcome === "started") {
        registry.rememberScope(accepted.run.id, command.scope);
        supervisor.adopt(accepted.run, () => { registry.forget(accepted.run.id); release(); });
      } else {
        release();
      }
      if (outcome !== "replayed") {
        hub.publish(command.conversation.id, { type: "message.accepted", conversation_id: command.conversation.publicId, run_id: accepted.run.id, client_message_id: command.clientMessageId, outcome });
        if (outcome === "started") hub.publish(command.conversation.id, { type: "turn.state", run_id: accepted.run.id, status: "queued" });
      }
      return { outcome, run: accepted.run, clientMessageId: command.clientMessageId, acceptedAt: accepted.receipt.accepted_at };
    } catch (error) {
      release();
      if (error instanceof Error && "code" in error && error.name === "ConversationRepositoryError") {
        const code = (error as { code: string }).code;
        throw new ChatError(code, error.message, code === "client_message_conflict" ? 409 : code === "conversation_archived" ? 409 : 400);
      }
      throw error;
    }
  }
}
