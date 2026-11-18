import type { ConversationMessage } from "../protocol.js";
import { ConversationRepositoryError, type AlsoCommit, type ConversationRecord, type ConversationRepository, type ConversationRunRecord } from "../conversationRepository.js";
import type { ClientAttributes, Principal } from "../surfaces/contract.js";
import { failures } from "../errors/failures.js";
import { admissionStatus } from "../errors/problem.js";
import type { RunEventHub } from "./runEventHub.js";
import type { RunTerminator } from "./runTerminator.js";
import type { RunSupervisor } from "./runSupervisor.js";
import { accountOf, ChatError } from "./principal.js";
import type { Library } from "./library.js";
import { log } from "../observability/log.js";
import { assertProductUsable } from "./toolSurface.js";
import type { RunCap } from "../usage/usageCap.js";
import type { ChatAnalytics } from "./chatAnalytics.js";

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
  /** `start_only`: the message never joins an active Run; it is refused with `conversation_busy` (409). Default: it steers. */
  mode?: "start_or_steer" | "start_only";
};

/** Answering the transcript again after a Run that failed or was interrupted: no new message, so no digest or assets. */
export type RetryCommand<Scope> = Pick<SubmitCommand<Scope>, "principal" | "conversation" | "scope" | "client" | "runId" | "corpusDigest" | "requiresLocalTools" | "timeZone"> & {
  /** The client's key for this retry: the same key is the same Run. */
  key: string;
};

/** `started`: a new Run. `replayed`: this key already started one. */
export type Retried = { outcome: "started" | "replayed"; run: ConversationRunRecord };

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
    repository: Pick<ConversationRepository, "acceptSubmission" | "acceptRetry" | "getActiveRun" | "getRunByClientMessageId" | "hasAcceptedMessage">;
    /** A Run that cannot be admitted ends here, like any other: observers and the journal both hear of it. */
    terminator: Pick<RunTerminator, "end">;
    supervisor: Pick<RunSupervisor, "adopt" | "executorId" | "holdsConversation" | "steered">;
    hub: RunEventHub;
    admission: RunAdmission;
    registry: RunRegistry<Scope>;
    limits?: PrincipalLimits;
    /** Asked before a new Run starts, never for a message that joins one: whoever pays for the Run may be out of budget. */
    cap?: RunCap<Scope>;
    /** A message that may start a Run first ends the conversation's background compaction, on any instance. */
    compaction?: { waitForCompaction(conversationId: string): Promise<void> };
    /** Told of each message taken, for product analytics. */
    analytics?: ChatAnalytics;
    /** Chatting with an Agent saves it to the account's library; asked once per Run that starts, and never waited for. */
    library?: Pick<Library, "save">;
    /** A report conversation's report becomes 'generating' with the Run its first message starts. */
    artifacts?: { runAccepted(conversation: ConversationRecord, run: ConversationRunRecord): Promise<void>; assertAcceptsMessage(conversation: ConversationRecord, runId: string): Promise<void> };
  }) {}

  /**
   * The one way a failed Run is answered again, from any client: a new Run over the same transcript, started atomically, or
   * refused (409) while a Run is active or when the latest Run is not failed or interrupted. A repeated key replays its Run.
   */
  async retry(command: RetryCommand<Scope>): Promise<Retried> {
    const { repository, supervisor, hub, admission, registry, limits, compaction, cap, artifacts } = this.deps;
    const binding = command.conversation;
    const accept = () => repository.acceptRetry({
      binding,
      run: { id: command.runId, conversationId: binding.id, clientMessageId: command.key, corpusDigest: command.corpusDigest, executorId: supervisor.executorId }
    }).catch((error: unknown) => { throw refused(error); });
    // A key that already started a Run needs no capacity and no checks: it is told which Run that was, even while it runs.
    if (await repository.getRunByClientMessageId(binding.id, command.key)) return { outcome: "replayed", run: (await accept()).run };
    assertProductUsable(command.requiresLocalTools, command.client.client);
    await limits?.check(command.principal, binding);
    await cap?.(command.scope);
    if (supervisor.holdsConversation(binding.id)) throw new ChatError("conversation_busy", "The previous run is still stopping. Try again in a moment.", 409);
    const release = admission.reserve(command.principal);
    try {
      await compaction?.waitForCompaction(binding.id);
      const accepted = await accept();
      if (!accepted.created) { release(); return { outcome: "replayed", run: accepted.run }; }
      await artifacts?.runAccepted(binding, accepted.run);
      registry.rememberClient(binding.id, command.client, command.timeZone);
      registry.rememberScope(accepted.run.id, command.scope);
      supervisor.adopt(accepted.run, () => { registry.forget(accepted.run.id); release(); });
      hub.publish(binding.id, { type: "turn.state", run_id: accepted.run.id, status: "queued" });
      return { outcome: "started", run: accepted.run };
    } catch (error) {
      release();
      throw error;
    }
  }

  async submit(command: SubmitCommand<Scope>): Promise<Submission> {
    const { repository, supervisor, hub, admission, registry, limits, compaction, terminator, cap, analytics, artifacts, library } = this.deps;
    assertProductUsable(command.requiresLocalTools, command.client.client);
    await limits?.check(command.principal, command.conversation);
    // A message that joins a Run adds no work, so capacity is only reserved for one that may start a Run.
    const known = await repository.hasAcceptedMessage(command.conversation.id, command.clientMessageId);
    if (!known) await artifacts?.assertAcceptsMessage(command.conversation, command.runId);
    const joining = command.mode === "start_only" ? undefined : await repository.getActiveRun(command.conversation.id);
    // A message this conversation already accepted starts nothing new, so it is not asked again.
    if (!joining && !known) await cap?.(command.scope);
    // A cancelled Run whose executor is still winding down must not overlap the next one in the same conversation.
    if (!joining && supervisor.holdsConversation(command.conversation.id)) {
      throw new ChatError("conversation_busy", "The previous run is still stopping. Try again in a moment.", 409);
    }
    let release = joining ? () => undefined : once(admission.reserve(command.principal));
    let accepted: Awaited<ReturnType<typeof repository.acceptSubmission>>;
    try {
      // The new message aborts a compaction running after the last reply, and waits until it has ended.
      if (!joining) await compaction?.waitForCompaction(command.conversation.id);
      accepted = await repository.acceptSubmission({
        binding: command.conversation,
        run: {
          id: command.runId,
          conversationId: command.conversation.id,
          clientMessageId: command.clientMessageId,
          inputDigest: command.digest,
          corpusDigest: command.corpusDigest,
          executorId: supervisor.executorId
        },
        canonicalUser: known ? { role: "user", content: "" } : await command.message(),
        ...(command.mode ? { mode: command.mode } : {})
      }, known ? undefined : command.bind);
    } catch (error) {
      release();
      throw refused(error);
    }
    // From here the message is stored, so what follows is never a refusal: a Run that cannot go on ends failed, and the message is answered with that.
    const outcome = accepted.created ? "started" : accepted.steered ? "steered" : "replayed";
    const failureOf = (error: unknown) => error instanceof ChatError ? { code: error.code, message: error.message } : failures.translate(error, { run: accepted.run.id, conversation: command.conversation.id });
    let failure: { code: string; message: string } | undefined;
    let adopted = false;
    try {
      if (outcome === "started" && joining) {
        // The Run we meant to join ended first, so this one starts a Run after all: admit it now.
        try { await cap?.(command.scope); release = once(admission.reserve(command.principal)); }
        catch (error) { failure = failureOf(error); }
      }
      if (outcome !== "replayed") {
        registry.rememberClient(command.conversation.id, command.client, command.timeZone);
        if (outcome === "started") await artifacts?.runAccepted(command.conversation, accepted.run);
        if (!known) analytics?.messageAccepted({ conversation: command.conversation, principal: command.principal, client: command.client });
        const account = accountOf(command.principal);
        if (outcome === "started" && account && library) {
          library.save(account, command.conversation.productId).catch((error: unknown) => log.error("library_save_failed", { error: error instanceof Error ? error.message : String(error) }));
        }
      }
      if (outcome === "started" && !failure) {
        registry.rememberScope(accepted.run.id, command.scope);
        supervisor.adopt(accepted.run, () => { registry.forget(accepted.run.id); release(); });
        adopted = true;
      } else {
        release();
      }
      if (outcome !== "replayed") {
        hub.publish(command.conversation.id, { type: "message.accepted", conversation_id: command.conversation.publicId, run_id: accepted.run.id, client_message_id: command.clientMessageId, outcome });
        if (outcome === "started") hub.publish(command.conversation.id, { type: "turn.state", run_id: accepted.run.id, status: "queued" });
        // The message is recorded: wake whoever executes the Run.
        if (outcome === "steered") supervisor.steered(accepted.run.id);
      }
      if (failure) await terminator.end(accepted.run.id, { status: "failed", failure });
    } catch (error) {
      log.error("chat_submit_after_accept_failed", { run: accepted.run.id, conversation: command.conversation.id, error: error instanceof Error ? error.message : String(error) });
      if (!adopted) {
        release();
        // A started Run nobody will execute is ended now; if even that fails the sweeper takes it.
        if (outcome === "started") await terminator.end(accepted.run.id, { status: "failed", failure: failureOf(error) }).catch((endError: unknown) => log.error("chat_submit_end_failed", { run: accepted.run.id, error: endError instanceof Error ? endError.message : String(endError) }));
      }
    }
    return { outcome, run: accepted.run, clientMessageId: command.clientMessageId, acceptedAt: accepted.receipt.accepted_at };
  }
}

/** A release that frees a reservation once, however many paths reach it. */
function once(release: () => void): () => void {
  let released = false;
  return () => { if (!released) { released = true; release(); } };
}

/** A refusal of the repository, as the Chat API tells it. */
function refused(error: unknown): unknown {
  return error instanceof ConversationRepositoryError ? new ChatError(error.code, error.message, admissionStatus(error.code)) : error;
}
