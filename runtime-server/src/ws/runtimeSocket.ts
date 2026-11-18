import { WebSocket } from "ws";
import { ZodError } from "zod";
import {
  assertConversationBinding,
  ConversationRepositoryError,
  type ConversationRecord,
  type ConversationRepository
} from "../conversationRepository.js";
import { AuthorizationError } from "../entitlements.js";
import { creatorAgentView } from "../chat/creatorAgentCatalog.js";
import { errorMessage } from "../chat/modelTurn.js";
import { AgentReleaseUnavailableError } from "../runtimeCorpusResolver.js";
import { SocketSink, projecting } from "../chat/sinks.js";
import {
  conversationBinding,
  privateBoundaryProjection,
  protectedLiveRun,
  resolveHelloAuthClaims,
  resolveSessionBinding,
  type LegacyHmacAuth,
  type SessionBinding
} from "../chat/sessionBinding.js";
import { DESKTOP_RETIRED_CODE, DESKTOP_RETIRED_NOTICE, isDesktopFrame } from "../chat/desktopRetired.js";
import { chatFailure, submitUserMessage, type ChatEdge } from "../chat/turnSubmission.js";
import { clientAttributesOf, parseInboundMessage, type ClientHello, type OutboundMessage } from "../protocol.js";
import type { RuntimeStore } from "../store.js";
import type { ClientAttributes } from "../surfaces/contract.js";

/** What the Runtime socket protocol needs from the rest of the Runtime; the composition root supplies it. */
/** Why a submission was aborted by the user's stop (a closed connection aborts it too, but leaves the Run alone). */
class UserStop extends Error {}

export type RuntimeSocketDeps = {
  edge: ChatEdge;
  store: RuntimeStore;
  conversationRepository: ConversationRepository;
  repositoryReady: Promise<unknown>;
  legacyHmacAuth: LegacyHmacAuth;
  /** Deadline for an accepted socket to complete authenticated hello setup. */
  helloTimeoutMs: number;
  connectionHeartbeatMs: number;
  connectionIdleTimeoutMs: number;
  maxSocketBufferedBytes: number;
};

export async function handleRuntimeSocket(
  socket: WebSocket,
  upgradeToken: string | undefined,
  deps: RuntimeSocketDeps
): Promise<void> {
  const {
    edge, store, conversationRepository, repositoryReady, legacyHmacAuth,
    helloTimeoutMs, connectionHeartbeatMs, connectionIdleTimeoutMs, maxSocketBufferedBytes
  } = deps;
  const { chat, agentCorpusResolver, authIdentityResolver } = edge;
  const connectionAbortController = new AbortController();
  let hello: ClientHello | undefined;
  const helloDeadline = setTimeout(() => {
    if (hello || socket.readyState === WebSocket.CLOSED) return;
    connectionAbortController.abort(new Error("Runtime client hello deadline exceeded"));
    socket.terminate();
  }, helloTimeoutMs);
  helloDeadline.unref();
  let binding: SessionBinding | undefined;
  let connectionConversation: ConversationRecord | undefined;
  let authToken: string | undefined;
  let client: ClientAttributes = { client: "web" };
  let helloPending = false;
  let desktopSocket = false;
  let detach: (() => void) | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let awaitingPong = false;
  let lastClientActivityAt = Date.now();
  const messageTasks = new Set<Promise<void>>();
  // Messages being admitted, by message key: a steer shares its Run's id, so the Run id cannot tell two of them apart.
  const pendingSubmissions = new Map<string, { controller: AbortController; runId: string }>();

  const terminateConnection = (reason: string): void => {
    connectionAbortController.abort(new Error(reason));
    socket.terminate();
  };
  const startEstablishedConnectionHeartbeat = (): void => {
    if (heartbeatTimer) return;
    lastClientActivityAt = Date.now();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastClientActivityAt >= connectionIdleTimeoutMs) {
        terminateConnection("Runtime connection idle timeout exceeded");
        return;
      }
      if (awaitingPong) {
        terminateConnection("Runtime connection heartbeat missed");
        return;
      }
      awaitingPong = true;
      try {
        socket.ping();
      } catch {
        terminateConnection("Runtime connection heartbeat failed");
      }
    }, connectionHeartbeatMs);
    heartbeatTimer.unref();
  };

  socket.on("pong", () => {
    awaitingPong = false;
  });

  // Closing a connection ends the connection, nothing else: the Runs it started belong to the server.
  socket.once("close", () => {
    clearTimeout(helloDeadline);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    detach?.();
    detach = undefined;
    connectionAbortController.abort(new Error("Runtime socket closed"));
  });

  const project = privateBoundaryProjection(() => binding);
  const sink = projecting(new SocketSink(socket, edge.consumerBufferedBytes), project);
  const send = async (message: OutboundMessage): Promise<void> => {
    const outbound = project(message as unknown as Record<string, unknown>) as unknown as OutboundMessage;
    if (socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(outbound);
    const payloadBytes = Buffer.byteLength(payload, "utf8");
    if (payloadBytes > maxSocketBufferedBytes
      || socket.bufferedAmount + payloadBytes > maxSocketBufferedBytes) {
      terminateConnection("Runtime outbound WebSocket backpressure limit exceeded");
      throw new Error("Runtime outbound WebSocket backpressure limit exceeded");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch((error) => {
      terminateConnection("Runtime WebSocket send failed");
      throw error;
    });
  };
  // `turn.failed` means a Run ended. A refused frame is not that: a session-level refusal is `session.error`, and a refused frame about a Run
  // (a stale cancel, an unknown tool call) is `frame.rejected`, which leaves the Run as it was.
  const sessionError = (code: string, message: string) => send({ type: "session.error", error: { code, message } });
  const frameRejected = (runId: string, error: { code: string; message: string }) => send({ type: "frame.rejected", run_id: runId, error });
  /**
   * A client.message the Runtime refused. A client that asked (`reject_by_message`) is told which message, and no Run ends:
   * the message may have meant to join a live Run. Every other client is told the Run failed, as always.
   */
  const refuseMessage = (frame: { run_id: string; client_message_id?: unknown; reject_by_message?: unknown }, error: { code: string; message: string }) =>
    frame.reject_by_message === true
      ? send({ type: "message.rejected", run_id: frame.run_id, client_message_id: typeof frame.client_message_id === "string" ? frame.client_message_id : frame.run_id, error })
      : send({ type: "turn.failed", run_id: frame.run_id, error });
  /** Local-tool calls still waiting for a client: whoever reconnects can answer them. */
  const replayPendingToolRequests = async (conversationId: string): Promise<void> => {
    for (const request of await chat.pendingToolRequests(conversationId)) sink.push(request as unknown as Record<string, unknown>);
  };

  socket.on("message", (data) => {
    lastClientActivityAt = Date.now();
    awaitingPong = false;
    const messageTask = (async () => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
        // Desktop is retired: whatever it sends is answered with the notice, before authentication, validation, any Run, usage or guest count.
        if (desktopSocket ||= isDesktopFrame(raw)) {
          const { type, run_id: runId } = raw as { type: string; run_id?: unknown };
          const error = { code: DESKTOP_RETIRED_CODE, message: DESKTOP_RETIRED_NOTICE };
          if (type === "client.message" && typeof runId === "string") await send({ type: "turn.failed", run_id: runId, error });
          else await sessionError(error.code, error.message);
          return;
        }
        const message = parseInboundMessage(withUpgradeToken(raw, upgradeToken));

        if (message.type === "client.hello") {
          if (hello || helloPending) {
            await sessionError("duplicate_hello", "client.hello can only be sent once per runtime connection");
            return;
          }
          helloPending = true;
          try {
            const authClaims = await resolveHelloAuthClaims(
              message,
              authIdentityResolver,
              legacyHmacAuth,
              connectionAbortController.signal
            );
            const nextBinding = await resolveSessionBinding(
              message,
              agentCorpusResolver,
              authIdentityResolver,
              authClaims,
              connectionAbortController.signal
            );
            connectionAbortController.signal.throwIfAborted();
            await repositoryReady;
            // By the owner and the id the client knows: a conversation that moved to an account when its visitor signed in keeps its id.
            const owner = conversationBinding(nextBinding);
            const conversation = nextBinding.explicit
              ? await conversationRepository.findOwnedConversation({ ownerAccountId: owner.ownerAccountId, creatorId: owner.creatorId }, message.conversation_id)
              : await conversationRepository.getConversation(message.conversation_id);
            if (!conversation) {
              throw new ConversationRepositoryError(
                "conversation_not_found",
                `Conversation ${message.conversation_id} was not found`
              );
            }
            if (conversation.publicId !== message.conversation_id) {
              throw new ConversationRepositoryError(
                "conversation_binding_mismatch",
                "Conversation public identity does not match the requested session."
              );
            }
            assertConversationBinding(conversation, conversationBinding(nextBinding));
            connectionAbortController.signal.throwIfAborted();
            await store.append({
              type: "session.started",
              creator_id: nextBinding.creatorId,
              user_id: nextBinding.userId,
              agent_id: nextBinding.productId,
              product_id: nextBinding.productId,
              corpus_digest: nextBinding.corpusDigest,
              client_version: message.client_version,
              local_tools: message.local_tools
            });
            connectionAbortController.signal.throwIfAborted();
            // Publish the connection binding only after all fallible session
            // setup is durable. A failed hello can then be retried without
            // leaving a half-ready socket that rejects every later hello.
            binding = nextBinding;
            connectionConversation = conversation;
            hello = message;
            authToken = message.auth_token ?? message.license_token;
            client = clientAttributesOf(message, message);
            clearTimeout(helloDeadline);
            const ready = send({
              type: "session.ready",
              conversation_id: conversation.publicId,
              accepted_protocol_version: message.protocol_version,
              runtime_capabilities: {
                rich_assets: true,
                message_acceptance: true,
                local_file_references: true
              },
              creator_id: binding.creatorId,
              user_id: binding.userId,
              product_id: binding.productId,
              corpus_digest: binding.corpusDigest,
              ...(binding.agentCorpus ? { creator_agent: creatorAgentView(binding.agentCorpus) } : {})
            });
            // A connection sees its conversation's live events, whoever started the Run.
            // Subscribed before the ready frame is awaited: a client that answers it at once cannot outrun its own subscription.
            detach = chat.hub.subscribe(conversation.id, sink);
            // In the same step as the subscription: the Run as it stands, then each event after it. A page that reloaded, or came back
            // from an outage, learns everything that happened while it was away, and skips what it already holds by the events' `seq`.
            const live = chat.hub.liveRun(conversation.id);
            if (live) sink.push({ type: "run.live", ...protectedLiveRun(live, binding.productId) });
            await ready;
            await replayPendingToolRequests(conversation.id);
            startEstablishedConnectionHeartbeat();
          } finally {
            helloPending = false;
          }
          return;
        }

        if (!hello || !binding || !connectionConversation) {
          const error = { code: "hello_required", message: "client.hello must be sent before run messages" };
          // A message that never reached a session never started its Run: the client takes its words back.
          if (message.type === "client.message") await refuseMessage(message, error);
          else await sessionError(error.code, error.message);
          return;
        }
        const conversation = connectionConversation;

        if (message.type === "conversation.subscribe") {
          if (message.conversation_id !== conversation.publicId) {
            await sessionError("conversation_mismatch", `This connection is bound to conversation ${conversation.publicId}.`);
            return;
          }
          detach?.();
          const afterCursor = message.after_cursor ?? (await conversationRepository.recoverySnapshot(conversation.id, [])).cursor;
          detach = chat.feed.attach(conversation.id, { afterCursor, stream: message.stream }, sink);
          if (message.stream) await replayPendingToolRequests(conversation.id);
          return;
        }

        if (message.type === "tool_call.result") {
          const answer = await chat.answerTool(conversation.id, message, client.client);
          if (answer.outcome !== "accepted") await frameRejected(message.run_id, answer.error);
          return;
        }

        if (message.type === "turn.cancel") {
          const reason = message.reason ?? "Run canceled";
          // A stop ends everything of this conversation that is not yet admitted, and the Run itself when there is one.
          const stopped = [...pendingSubmissions.values()];
          for (const pending of stopped) pending.controller.abort(new UserStop(reason));
          const cancelled = await chat.cancel(conversation.id, message.run_id, reason);
          if (cancelled.outcome === "cancelled") return;
          // No Run to cancel: the client is told its Run is cancelled only when it never started because its message was stopped.
          if (stopped.some((pending) => pending.runId === message.run_id)) await send({ type: "turn.failed", run_id: message.run_id, error: { code: "run_cancelled", message: reason } });
          else await frameRejected(message.run_id, cancelled.error);
          return;
        }

        if (message.type === "client.message") {
          if (message.conversation_id !== conversation.publicId) {
            await refuseMessage(message, {
              code: "conversation_mismatch",
              message: `This connection is bound to conversation ${conversation.publicId}.`
            });
            return;
          }
          // The client of this message decides which tools the Run may use from now on.
          const messageClient = clientAttributesOf({ ...message }, { ...client, local_tools: message.local_tools ?? hello.local_tools });
          const submission = new AbortController();
          const abortWithConnection = () => submission.abort(connectionAbortController.signal.reason);
          connectionAbortController.signal.addEventListener("abort", abortWithConnection, { once: true });
          const messageKey = message.client_message_id ?? message.run_id;
          pendingSubmissions.set(messageKey, { controller: submission, runId: message.run_id });
          try {
            const { submission: accepted, binding: current } = await submitUserMessage(edge, { authToken, binding, conversation }, {
              runId: message.run_id,
              clientMessageId: message.client_message_id ?? message.run_id,
              message: message.message,
              taskStart: message.task_start === true,
              client: messageClient,
              ...((message.time_zone ?? hello.time_zone) ? { timeZone: message.time_zone ?? hello.time_zone } : {})
            }, submission.signal);
            binding = current;
            // A stop that arrived while the message was being admitted found no Run to cancel: the Run it started is cancelled now.
            if (submission.signal.reason instanceof UserStop && accepted.outcome !== "replayed") await chat.cancel(conversation.id, accepted.run.id, submission.signal.reason.message);
            if (accepted.outcome === "replayed") {
              await send({ type: "message.accepted", conversation_id: conversation.publicId, run_id: accepted.run.id, client_message_id: accepted.clientMessageId, outcome: accepted.outcome });
              await send({ type: "turn.state", run_id: accepted.run.id, status: accepted.run.status, reason: "Idempotent client message replay" });
            }
          } catch (error) {
            if (submission.signal.aborted) return;
            await refuseMessage(message, chatFailure(error));
          } finally {
            if (pendingSubmissions.get(messageKey)?.controller === submission) pendingSubmissions.delete(messageKey);
            connectionAbortController.signal.removeEventListener("abort", abortWithConnection);
          }
        }
      } catch (error) {
        const rawMessage = raw as { type?: unknown; run_id?: unknown; client_message_id?: unknown; reject_by_message?: unknown } | undefined;
        const unreadableMessage = (error instanceof SyntaxError || error instanceof ZodError) && rawMessage?.type === "client.message" && typeof rawMessage.run_id === "string";
        // A message the Runtime could not read never started its Run, so that Run ends here, with text a person may read (never the validation report).
        if (unreadableMessage) {
          await refuseMessage(rawMessage as { run_id: string; client_message_id?: unknown; reject_by_message?: unknown }, { code: "invalid_frame", message: "The Runtime could not accept that message." });
          return;
        }
        if (error instanceof AgentReleaseUnavailableError) {
          await sessionError("agent_unavailable", "This Agent is not available.");
          return;
        }
        // Anything else is a refusal of the session; its text is for the client's developer.
        await sessionError(error instanceof AuthorizationError || error instanceof ConversationRepositoryError ? error.code : "protocol_error", errorMessage(error));
      }
    })();
    messageTasks.add(messageTask);
    void messageTask.then(
      () => messageTasks.delete(messageTask),
      () => messageTasks.delete(messageTask)
    );
  });

  return new Promise<void>((resolve) => {
    socket.once("close", () => {
      void Promise.allSettled([...messageTasks]).then(() => resolve());
    });
  });
}

/** A session cookie lets a browser omit the token from its hello; the upgrade already verified its Origin. */
function withUpgradeToken(raw: unknown, token: string | undefined): unknown {
  if (!token || typeof raw !== "object" || raw === null) return raw;
  const message = raw as Record<string, unknown>;
  return message.type === "client.hello" && !message.auth_token && !message.license_token ? { ...message, auth_token: token } : raw;
}
