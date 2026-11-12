import { WebSocket } from "ws";
import {
  assertConversationBinding,
  ConversationRepositoryError,
  type ConversationRecord,
  type ConversationRepository
} from "../conversationRepository.js";
import { EntitlementError } from "../entitlements.js";
import { creatorAgentView } from "../chat/creatorAgentCatalog.js";
import { errorMessage } from "../chat/modelTurn.js";
import { SocketSink, projecting } from "../chat/sinks.js";
import {
  conversationBinding,
  durableConversationId,
  privateBoundaryProjection,
  resolveHelloAuthClaims,
  resolveSessionBinding,
  type LegacyHmacAuth,
  type SessionBinding
} from "../chat/sessionBinding.js";
import { chatFailure, submitUserMessage, type ChatEdge } from "../chat/turnSubmission.js";
import { clientAttributesOf, parseInboundMessage, type ClientHello, type OutboundMessage } from "../protocol.js";
import type { RuntimeStore } from "../store.js";
import type { ClientAttributes } from "../surfaces/contract.js";

/** What the Runtime socket protocol needs from the rest of the Runtime; the composition root supplies it. */
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
  const { chat, entitlementResolver, agentCorpusResolver, authIdentityResolver } = edge;
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
  let detach: (() => void) | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let awaitingPong = false;
  let lastClientActivityAt = Date.now();
  const messageTasks = new Set<Promise<void>>();
  // A message being authorized has no Run yet; a cancel with its run id stops it before one exists.
  const pendingSubmissions = new Map<string, AbortController>();

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
  /** Local-tool calls still waiting for a client: whoever reconnects can answer them. */
  const replayPendingToolRequests = async (conversationId: string): Promise<void> => {
    for (const request of await chat.pendingToolRequests(conversationId)) sink.push(request as unknown as Record<string, unknown>);
  };

  socket.on("message", (data) => {
    lastClientActivityAt = Date.now();
    awaitingPong = false;
    const messageTask = (async () => {
      try {
        const message = parseInboundMessage(withUpgradeToken(JSON.parse(String(data)), upgradeToken));

        if (message.type === "client.hello") {
          if (hello || helloPending) {
            await send({
              type: "turn.failed",
              error: {
                code: "duplicate_hello",
                message: "client.hello can only be sent once per runtime connection"
              }
            });
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
              entitlementResolver,
              agentCorpusResolver,
              authIdentityResolver,
              authClaims,
              connectionAbortController.signal
            );
            connectionAbortController.signal.throwIfAborted();
            const requestedStorageConversationId = nextBinding.explicit
              ? durableConversationId(nextBinding, message.conversation_id)
              : message.conversation_id;
            await repositoryReady;
            const conversation = await conversationRepository.getConversation(requestedStorageConversationId);
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
              ...(nextBinding.purchasedCorpusDigest ? {
                purchased_corpus_digest: nextBinding.purchasedCorpusDigest,
                effective_corpus_digest: nextBinding.corpusDigest,
                version_policy: nextBinding.versionPolicy ?? "pinned",
                version_history: nextBinding.versionHistory ?? []
              } : {}),
              ...(nextBinding.entitlementId ? { access_mode: nextBinding.accessMode ?? "unmetered" } : {}),
              ...(nextBinding.entitlementId ? { entitlement_id: nextBinding.entitlementId } : {}),
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
              ...(binding.purchasedCorpusDigest ? {
                purchased_corpus_digest: binding.purchasedCorpusDigest,
                effective_corpus_digest: binding.corpusDigest,
                version_policy: binding.versionPolicy ?? "pinned",
                version_history: binding.versionHistory ?? []
              } : {}),
              ...(binding.entitlementId ? { access_mode: binding.accessMode ?? "unmetered" } : {}),
              ...(binding.entitlementId ? { entitlement_id: binding.entitlementId } : {}),
              ...(binding.agentCorpus ? { creator_agent: creatorAgentView(binding.agentCorpus) } : {})
            });
            // A connection sees its conversation's live events, whoever started the Run.
            // Subscribed before the ready frame is awaited: a client that answers it at once cannot outrun its own subscription.
            detach = chat.hub.subscribe(conversation.id, sink);
            await ready;
            await replayPendingToolRequests(conversation.id);
            startEstablishedConnectionHeartbeat();
          } finally {
            helloPending = false;
          }
          return;
        }

        if (!hello || !binding || !connectionConversation) {
          await send({
            type: "turn.failed",
            error: {
              code: "hello_required",
              message: "client.hello must be sent before run messages"
            }
          });
          return;
        }
        const conversation = connectionConversation;

        if (message.type === "conversation.subscribe") {
          if (message.conversation_id !== conversation.publicId) {
            await send({ type: "turn.failed", error: { code: "conversation_mismatch", message: `This connection is bound to conversation ${conversation.publicId}.` } });
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
          if (answer.outcome !== "accepted") await send({ type: "turn.failed", run_id: message.run_id, error: answer.error });
          return;
        }

        if (message.type === "turn.cancel") {
          const reason = message.reason ?? "Run canceled";
          const pending = pendingSubmissions.get(message.run_id);
          if (pending) {
            pending.abort(new Error(reason));
            await send({ type: "turn.failed", run_id: message.run_id, error: { code: "run_cancelled", message: reason } });
            return;
          }
          const cancelled = await chat.cancel(conversation.id, message.run_id, reason);
          if (cancelled.outcome !== "cancelled") await send({ type: "turn.failed", run_id: message.run_id, error: cancelled.error });
          return;
        }

        if (message.type === "client.message") {
          if (message.conversation_id !== conversation.publicId) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "conversation_mismatch",
                message: `This connection is bound to conversation ${conversation.publicId}.`
              }
            });
            return;
          }
          // The client of this message decides which tools the Run may use from now on.
          const messageClient = clientAttributesOf({ ...message }, { ...client, local_tools: message.local_tools ?? hello.local_tools });
          const submission = new AbortController();
          const abortWithConnection = () => submission.abort(connectionAbortController.signal.reason);
          connectionAbortController.signal.addEventListener("abort", abortWithConnection, { once: true });
          pendingSubmissions.set(message.run_id, submission);
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
            if (accepted.outcome === "replayed") {
              await send({ type: "message.accepted", conversation_id: conversation.publicId, run_id: accepted.run.id, client_message_id: accepted.clientMessageId, outcome: accepted.outcome });
              await send({ type: "turn.state", run_id: accepted.run.id, status: accepted.run.status, reason: "Idempotent client message replay" });
            }
          } catch (error) {
            if (submission.signal.aborted) return;
            await send({ type: "turn.failed", run_id: message.run_id, error: chatFailure(error) });
          } finally {
            pendingSubmissions.delete(message.run_id);
            connectionAbortController.signal.removeEventListener("abort", abortWithConnection);
          }
        }
      } catch (error) {
        await send({
          type: "turn.failed",
          error: {
            code: error instanceof EntitlementError || error instanceof ConversationRepositoryError
              ? error.code
              : "protocol_error",
            message: errorMessage(error)
          }
        });
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
