import type { AgentCorpusResolverLike as AgentCorpusResolver } from "../agentCorpus.js";
import { ConversationRepositoryError, type ConversationRecord } from "../conversationRepository.js";
import { resolveCreatorTools, type CreatorToolControlPlane } from "../creatorTools.js";
import { EntitlementError, type AuthIdentityResolver, type EntitlementResolver } from "../entitlements.js";
import { toProblem } from "../errors/problem.js";
import { log } from "../observability/log.js";
import {
  clientMessageInputDigest,
  TASK_START_MESSAGE_CONTENT,
  type ConversationMessage,
  type RunStart
} from "../protocol.js";
import type { ClientAttributes } from "../surfaces/contract.js";
import type { CapacityGate, KeyedCapacityGate } from "../runtimeConfig.js";
import type { ChatAssets, PartsReader, PreparedMessage } from "./assets.js";
import type { Retried, Submission } from "./chatService.js";
import type { ChatRuntime } from "./chatRuntime.js";
import { errorMessage } from "./modelTurn.js";
import { ChatError, accountPrincipal } from "./principal.js";
import type { ChatServiceApi } from "./serviceApi.js";
import { controlledTurnAuthorizationError, resolveTurnAgentBinding, revalidateTurnAuthorization, type SessionBinding } from "./sessionBinding.js";
import { prepareSocketMessage } from "./socketAttachments.js";
import { productRequiresLocalTools } from "./toolSurface.js";

/** What both transports need to turn an authenticated user message into a Run or a steer. */
export type ChatEdge = {
  /** What a Chat event consumer may leave unsent before it is disconnected. */
  consumerBufferedBytes: number;
  chat: ChatRuntime<SessionBinding>;
  parts: PartsReader;
  chatAssets?: ChatAssets;
  /** The channel layer's door into Chat from another process. */
  serviceApi?: ChatServiceApi;
  turnAuthorizationGate: CapacityGate;
  turnAuthorizationPerUserGate: KeyedCapacityGate;
  entitlementResolver?: EntitlementResolver;
  authIdentityResolver?: AuthIdentityResolver;
  agentCorpusResolver?: AgentCorpusResolver;
  creatorToolControlPlane?: CreatorToolControlPlane;
};

export type ChatSession = {
  authToken: string | undefined;
  binding: SessionBinding;
  conversation: ConversationRecord;
};

export type ChatMessageRequest = {
  /** Parts a client sent, already resolved: the canonical message and digest come from them. */
  prepared?: PreparedMessage;
  runId: string;
  clientMessageId: string;
  message: RunStart["message"];
  taskStart: boolean;
  client: ClientAttributes;
  timeZone?: string;
  /** `start_only`: refuse the message (409 conversation_busy) rather than steer a Run that is active. */
  mode?: "start_or_steer" | "start_only";
};

/** Access is verified again before any Run starts, for a message and for an answer again alike: what the user may use now. */
export async function authorizedBinding(edge: ChatEdge, session: ChatSession, signal?: AbortSignal): Promise<SessionBinding> {
  const releaseAuthorization = edge.turnAuthorizationGate.tryAcquire();
  if (!releaseAuthorization) {
    throw new ChatError("authorization_busy", "Hatch is already verifying the maximum number of turns. Try again shortly.", 429);
  }
  const releaseUserAuthorization = edge.turnAuthorizationPerUserGate.tryAcquire(session.binding.userId);
  if (!releaseUserAuthorization) {
    releaseAuthorization();
    throw new ChatError("user_authorization_busy", "This account is already verifying the maximum number of turns. Try again shortly.", 429);
  }
  let binding = session.binding;
  try {
    await revalidateTurnAuthorization({ auth_token: session.authToken }, binding, edge.entitlementResolver, edge.authIdentityResolver, signal);
    if (binding.agentCorpus) {
      binding = await resolveTurnAgentBinding(binding, edge.agentCorpusResolver, signal);
      // A disabled binding blocks the message here, before any Run exists.
      binding = {
        ...binding,
        creatorTools: await resolveCreatorTools(edge.creatorToolControlPlane, binding.creatorId, binding.productId, binding.agentCorpus!, signal)
      };
    }
  } catch (error) {
    if (error instanceof EntitlementError) throw error;
    throw new EntitlementError("authorization_unavailable", errorMessage(error));
  } finally {
    releaseAuthorization();
    releaseUserAuthorization();
  }
  return binding;
}

/**
 * The one path a user message takes, from WebSocket or HTTP: re-verify access,
 * make the message canonical, then steer the active Run or start one.
 */
export async function submitUserMessage(
  edge: ChatEdge,
  session: ChatSession,
  request: ChatMessageRequest,
  signal?: AbortSignal
): Promise<{ submission: Submission; binding: SessionBinding }> {
  const binding = await authorizedBinding(edge, session, signal);
  if (request.taskStart && binding.briefSpec && !session.conversation.briefSnapshot) {
    throw new ChatError("conversation_brief_required", "A Brief is required before starting this task.", 409);
  }
  const prepared = request.taskStart ? undefined
    : request.prepared ?? await prepareSocketMessage(edge, request.message, session.conversation, request.clientMessageId);
  const canonicalMessage = prepared?.message ?? (async (): Promise<ConversationMessage> => ({ role: "user", content: TASK_START_MESSAGE_CONTENT, kind: "task_start" }));
  signal?.throwIfAborted();
  const submission = await edge.chat.service.submit({
    principal: accountPrincipal(binding.userId),
    conversation: session.conversation,
    scope: binding,
    client: request.client,
    clientMessageId: request.clientMessageId,
    message: canonicalMessage,
    ...(prepared?.bind ? { bind: prepared.bind } : {}),
    digest: prepared?.digest ?? clientMessageInputDigest({ ...request.message, task_start: true }),
    runId: request.runId,
    corpusDigest: binding.corpusDigest,
    requiresLocalTools: binding.agentCorpus ? productRequiresLocalTools(binding.agentCorpus) : false,
    ...(request.timeZone ? { timeZone: request.timeZone } : {}),
    ...(request.mode ? { mode: request.mode } : {})
  });
  return { submission, binding };
}

/**
 * Answers a conversation again after a Run that failed or was interrupted, with no new message: re-verify access,
 * then start a Run over the same transcript, or replay the one this key started.
 */
export async function retryRun(
  edge: ChatEdge,
  session: ChatSession,
  request: { runId: string; key: string; client: ClientAttributes; timeZone?: string },
  signal?: AbortSignal
): Promise<Retried> {
  const binding = await authorizedBinding(edge, session, signal);
  signal?.throwIfAborted();
  return edge.chat.service.retry({
    principal: accountPrincipal(binding.userId),
    conversation: session.conversation,
    scope: binding,
    client: request.client,
    key: request.key,
    runId: request.runId,
    corpusDigest: binding.corpusDigest,
    requiresLocalTools: binding.agentCorpus ? productRequiresLocalTools(binding.agentCorpus) : false,
    ...(request.timeZone ? { timeZone: request.timeZone } : {})
  });
}

/** A failure a client can act on, whichever way it arrived. */
export function chatFailure(error: unknown): { code: string; message: string } {
  if (error instanceof EntitlementError) return controlledTurnAuthorizationError(error);
  if (error instanceof ChatError) return { code: error.code, message: error.message };
  if (error instanceof ConversationRepositoryError) {
    return {
      code: error.code,
      message: error.code === "client_message_conflict"
        ? "This client_message_id was already used with different message or attachment content."
        : error.code === "conversation_not_found" ? "Create the task before starting a run." : error.message
    };
  }
  log.error("socket_message_failed", { error });
  return { code: "protocol_error", message: toProblem(error).message };
}
