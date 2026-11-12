import "dotenv/config";

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { ZodError } from "zod";
import { ClientToolBroker } from "./clientBroker.js";
import { type RuntimeCompactionMessage } from "./compaction.js";
import { createAgentRuntime, type AgentRuntime, type RunContext, type RuntimeSessionSkills } from "./agentRuntime.js";
import { ThinkingPartJournal } from "./thinkingPartJournal.js";
import { MAX_RICH_TOOL_RESULT_BYTES, type BoundRunStart, type OutputFinishReason } from "./protocol.js";
import { RunStateMachine } from "./runState.js";
import { failures } from "./errors/failures.js";
import { PostgresFailureLedger } from "./errors/postgresFailureLedger.js";
import { ServerToolExecutor } from "./serverTools.js";
import { RuntimeStore, type VisibleConversationPart } from "./store.js";
import { PostgresStore } from "./postgresStore.js";
import {
  assertConversationBinding,
  ConversationRepositoryError,
  InMemoryConversationRepository,
  PostgresConversationRepository,
  type ConversationJournalEvent,
  type ConversationRepository,
  type ConversationRecord,
  type ConversationRunRecord
} from "./conversationRepository.js";
import { ToolBridge } from "./toolBridge.js";
import {
  EntitlementError,
  FileEntitlementResolver,
  RegistryEntitlementResolver,
  registryAuthorizationTimeoutMs,
  type AuthIdentity,
  type AuthIdentityResolver,
  type EntitlementBinding,
  type EntitlementResolver
} from "./entitlements.js";
import {
  deliveryReceiptFromMetadata,
  findCompletedDelivery,
  prepareDelivery,
  recordPreparedDelivery,
  releaseDeliveryUnit,
  reserveDeliveryUnit,
  type CommerceEventSink,
  type DeliveryArtifact,
  type DeliveryBinding,
  type DeliveryUnitReservation
} from "./delivery.js";
import { HttpCommerceEventSink } from "./commerceHttpSink.js";
import { DeliveryAccountingOutbox, type DeliveryAccountingCommand } from "./deliveryOutbox.js";
import { materializeAgentCorpus } from "./agentCorpusMaterialization.js";
import { creatorToolControlPlaneFromEnvironment, resolveCreatorTools, type CreatorToolControlPlane } from "./creatorTools.js";
import { AgentCorpusResolver as FilesystemAgentCorpusResolver, type AgentCorpusResolverLike } from "./agentCorpus.js";
import { AgentReleaseUnavailableError, RuntimeReleaseAgentCorpusResolver } from "./runtimeCorpusResolver.js";
import {
  discoverSkills,
  includeSkillInstructions,
  renderSkillsSection,
  visibleSkillsForSession
} from "./skills.js";
import { createBriefSnapshot, type BriefSnapshot, type BriefSpec } from "./brief.js";
import {
  createOutputGuardFromEnvironment,
  GuardedAssistantOutput,
  OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE,
  PassThroughOutputGuard,
  type GuardedOutputResult,
  type OutputGuard
} from "./outputGuard.js";
import { writeOperationalError } from "./operationalLogging.js";
import { RuntimeAssetStore, runtimeAssetStoreFromEnvironment } from "./assetStore.js";
import { flushLangfuseObservability, initializeLangfuseObservability, withLangfuseTurn } from "./langfuse.js";
import { ChatRuntime, type ChatRuntimeOptions } from "./chat/chatRuntime.js";
import { PostgresEventRelay } from "./chat/eventRelay.js";
import { PostgresStopRelay } from "./chat/stopRelay.js";
import { publicJournalPayload } from "./chat/messageLedger.js";
import { ChatError, principalKey } from "./chat/principal.js";
import type { PrincipalLimits, RunAdmission, Submission } from "./chat/chatService.js";
import { ContactBinder, SentMessageLimits, type ConnectionDirectory } from "./chat/contactBinding.js";
import { SelfBinder } from "./chat/selfBinding.js";
import type { ChatGateway } from "./chat/gateway.js";
import { checkUpgrade, sessionTokenFromCookie } from "./chat/originPolicy.js";
import { RunHandoff } from "./chat/runSupervisor.js";
import { ServiceChatGateway } from "./chat/serviceGateway.js";
import { ChatServiceApi } from "./chat/serviceApi.js";
import { ChatAssets, TextPartsReader, type PartsReader } from "./chat/assets.js";
import { attachmentToolDefinitions } from "./chat/attachmentTools.js";
import { errorMessage, failRun, runModelTurn } from "./chat/modelTurn.js";
import { publicRun } from "./chat/publicRun.js";
import { ChatConversationReadModel } from "./chat/conversationReadModel.js";
import { toolRegistry } from "./tools.js";
import { MAX_BYTES as MAX_ASSET_BYTES } from "./assets/pipeline.js";
import { RegistryConnectionDirectory } from "./chat/registryConnections.js";
import { openChatAssets } from "./chat/openChatAssets.js";
import { objectStoreFromEnvironment } from "./creatorLearning/objectStore.js";
import { MAX_CONSUMER_BUFFERED_BYTES, SseSink, projecting, type EventProjection } from "./chat/sinks.js";
import { productRequiresLocalTools } from "./chat/toolSurface.js";
import type { ScopeResolver, TurnRunner } from "./chat/turnExecutor.js";
import type { TurnCompaction } from "./chat/chatCompaction.js";
import { isContextOverflow, type AssistantMessage } from "@earendil-works/pi-ai";
import { waitForTerminalRun, finalAssistantText, TERMINAL_STATUSES } from "./chat/runResult.js";
import { clientAttributesOf, MAX_USER_MESSAGE_CHARS, ToolCallResultSchema } from "./protocol.js";
import type { ContentPart } from "./surfaces/contract.js";
import { observed } from "./observability/http.js";
import { InflightResponses, drainMsFromEnvironment, exitOnSignal, gracefulShutdown } from "./gracefulShutdown.js";
import { log } from "./observability/log.js";
import { toProblem } from "./errors/problem.js";
import { ConversationError as ConversationHttpError } from "./conversations/conversation.js";
import { startObservability } from "./observability/start.js";
import {
  CapacityGate, KeyedCapacityGate, combineCapacityReleases, once, readRuntimeConfig,
  DEFAULT_MAX_CONTACT_MESSAGES, clientToolTimeoutMs, legacyHmacAuthEnabled, runtimeClientHelloTimeoutMs
} from "./runtimeConfig.js";

export { clientToolTimeoutMs, legacyHmacAuthEnabled, runtimeClientHelloTimeoutMs };
import {
  assertEntitlementMatchesIdentity,
  conversationBinding,
  durableConversationId,
  legacyAuthClaims,
  privateBoundaryProjection,
  protectPrivateAgentBoundary,
  resolveAuthIdentity,
  resolveSessionBinding,
  runtimeNotConfiguredError,
  sanitizeBoundHistory,
  scopedConversationId,
  unconfiguredAgentCorpusResolver,
  unconfiguredEntitlementResolver,
  type LegacyHmacAuth,
  type SessionBinding
} from "./chat/sessionBinding.js";
import { handleRuntimeSocket } from "./ws/runtimeSocket.js";
import { submitUserMessage, retryRun, type ChatEdge } from "./chat/turnSubmission.js";

export { durableConversationId, privateBoundaryProjection, protectPrivateAgentBoundary, scopedConversationId };

type AgentCorpusResolver = AgentCorpusResolverLike;

export type RuntimeServer = {
  server: http.Server;
  wss: WebSocketServer;
  /** What the channel layer calls to talk to the Chat API without a transport. */
  chat: ChatGateway;
  close: () => Promise<void>;
  /** Leaves production traffic to the next instance: unready, stop intake, finish the Runs held, then close. */
  shutdown: (deadlineMs: number) => Promise<{ drained: boolean }>;
};

/** The largest file the asset pipeline takes: a larger upload is refused before it is read. */
const MAX_UPLOAD_BYTES = Math.max(...Object.values(MAX_ASSET_BYTES));

/** The longest a client may ask a request to wait for a Run's result. */
const MAX_WAIT_SECONDS = 60;

// A rich asset is base64-encoded on the client-to-Runtime frame. The protocol
// keeps one asset/message at 100 MiB; 160 MiB leaves room for the ~133 MiB
// base64 body, structured metadata, and a rich local-tool result envelope.
export const MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES = MAX_RICH_TOOL_RESULT_BYTES;

export type RuntimeServerOptions = {
  createRuntime?: () => AgentRuntime;
  /** Chat's compaction strategy; tests inject one with a test-only summarizer. */
  compactionStrategy?: ChatRuntimeOptions<SessionBinding>["compactionStrategy"];
  conversationStore?: RuntimeStore;
  /** Optional injected store for tests; production defaults beside transcripts. */
  assetStore?: RuntimeAssetStore;
  /** Durable Conversation/Run control-plane. Defaults to Postgres or local app-data. */
  conversationRepository?: ConversationRepository;
  entitlementResolver?: EntitlementResolver;
  /**
   * Explicit local-development mode (HATCH_ALLOW_INSECURE_LOCAL_MODE). Without resolvers and without this
   * flag every session fails with runtime_not_configured instead of receiving invented local ids.
   */
  insecureLocalMode?: boolean;
  /** Production identity verifier owned by the Registry. */
  authIdentityResolver?: AuthIdentityResolver;
  /** Registry-installed current Agent Corpus root, keyed by creator/agent. */
  agentCorpusResolver?: AgentCorpusResolver;
  outputGuard?: OutputGuard;
  commerceEventSink?: CommerceEventSink;
  /** Durable, content-free accounting retry queue. */
  deliveryAccountingOutbox?: DeliveryAccountingOutbox;
  deliveryReconcileIntervalMs?: number;
  /** Server-only resolver for Creator tool bindings and credentials. */
  creatorToolControlPlane?: CreatorToolControlPlane;
  /**
   * A local write requires an explicit decision in the Desktop client. Keep
   * this separate from model request timeouts: an otherwise healthy run must
   * not fail just because the buyer took a moment to read the proposed diff.
   */
  clientToolTimeoutMs?: number;
  /** Explicit migration-only gate. Disabled unless the caller opts in. */
  enableLegacyHmacAuth?: boolean;
  /** Migration-only HMAC secret; inert while enableLegacyHmacAuth is false. */
  legacyHmacSecret?: string;
  /** Deadline for an accepted socket to complete authenticated hello setup. */
  clientHelloTimeoutMs?: number;
  /** Global cap on concurrent per-turn Registry authorization checks. */
  maxPendingTurnAuthorizations?: number;
  /** Per-user cap on concurrent per-turn Registry authorization checks. */
  maxPendingTurnAuthorizationsPerUser?: number;
  /** Origins that may use a browser session cookie on a WebSocket upgrade or a state-changing request. */
  allowedOrigins?: string[];
  /** Limits checked before a customer's message becomes a Run. By default each contact may send `maxContactMessages` to a Product. */
  principalLimits?: PrincipalLimits;
  maxContactMessages?: number;
  /** The channel layer's Connections, which a customer's messages arrive through. */
  connectionDirectory?: ConnectionDirectory;
  /** Uploads, attachments in messages, and the ls/grep/read tools over them. Without it a message takes text only. */
  chatAssets?: ChatAssets;
  /** The token the channel layer presents to reach Chat from another process; without it that door stays shut. */
  chatServiceToken?: string;
  /** Pending and active runs admitted for one authenticated user. */
  maxActiveRunsPerUser?: number;
  /** Pending and active runs admitted across the Runtime process. */
  maxActiveRunsGlobal?: number;
  /** Ping interval used to reap connections that no longer answer. */
  connectionHeartbeatMs?: number;
  /** Maximum time a ready connection may receive no client messages. */
  connectionIdleTimeoutMs?: number;
  /** Hard cap for a socket's queued outbound bytes. */
  maxSocketBufferedBytes?: number;
  /** A Chat event consumer with this much unsent is disconnected and resumes by cursor (default 1 MB). */
  maxConsumerBufferedBytes?: number;
  /** Hard deadline for Runtime-owned network tools. */
  serverToolTimeoutMs?: number;
  /** Deadline for receiving HTTP headers. */
  httpHeadersTimeoutMs?: number;
  /** End-to-end deadline for a Runtime HTTP handler. */
  httpRequestTimeoutMs?: number;
  /** Maximum serialized JSON response size for discovery and history. */
  maxHttpResponseBytes?: number;
};

/**
 * The Runtime remains usable without commerce (for local development and
 * protocol tests), but a deployed consumer Runtime must write completed
 * delivery events to the same durable ledger read by the Creator Dashboard.
 *
 * Kept here rather than in a demo-only entry point so `node dist/index.js`
 * has the same transaction behavior as the app we ship.
 */
export async function commerceEventSinkFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<CommerceEventSink | undefined> {
  const commerceUrl = environment.HATCH_COMMERCE_URL?.trim();
  if (commerceUrl) {
    const serviceToken = environment.HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN?.trim();
    if (!serviceToken) throw new Error("HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN is required with HATCH_COMMERCE_URL.");
    return new HttpCommerceEventSink(commerceUrl, serviceToken);
  }

  const ledgerFile = environment.HATCH_COMMERCE_LEDGER_FILE?.trim();
  if (!ledgerFile) return undefined;
  if (environment.NODE_ENV === "production") {
    throw new Error("Production Runtime must use HATCH_COMMERCE_URL; shared Commerce ledger files are development-only.");
  }

  const commerce = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href) as {
    CommerceLedger: { open(options: { filePath: string }): Promise<{
      findByIdempotencyKey(key: string): unknown;
    }> };
    CommerceService: new (ledger: unknown) => {
      getEntitlement(entitlementId: string): unknown;
      authorizeAndReserve(input: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
      releaseReservation(input: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
      completeDelivery(input: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
    };
    LedgerCommerceSink: new (ledger: unknown) => {
      ingest(type: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
    };
  };
  const ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  const recognizedSink = new commerce.LedgerCommerceSink(ledger);
  const service = new commerce.CommerceService(ledger);
  return {
    append: (type, payload, options) => recognizedSink.ingest(type, payload, options),
    findByIdempotencyKey: (key) => ledger.findByIdempotencyKey(key),
    getEntitlement: (entitlementId) => service.getEntitlement(entitlementId),
    authorizeAndReserve: (input, options) => service.authorizeAndReserve(input, options),
    releaseReservation: (input, options) => service.releaseReservation(input, options),
    completeDelivery: (input, options) => service.completeDelivery(input, options)
  };
}

export async function createRuntimeServerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<RuntimeServer> {
  initializeLangfuseObservability(environment);
  const config = readRuntimeConfig(environment);
  const { registryUrl, registryToken: runtimeRegistryToken, corpusRoot: runtimeCorpusRoot, dataDir: runtimeDataDir } = config;
  const registryAuth = registryUrl
    ? new RegistryEntitlementResolver(
      registryUrl,
      fetch,
      {
        timeoutMs: registryAuthorizationTimeoutMs(environment),
        serviceToken: environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN,
        commerceUrl: environment.HATCH_COMMERCE_URL,
        commerceServiceToken: environment.HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN,
      }
    )
    : undefined;
  const entitlementFile = environment.HATCH_ENTITLEMENTS_FILE?.trim();
  const fileEntitlements = config.legacyHmacEnabled && entitlementFile
    ? new FileEntitlementResolver(entitlementFile, {
      enableLegacyHmacAuth: true,
      hmacSecret: config.legacyHmacSecret!
    })
    : undefined;
  const commerceEventSink = await commerceEventSinkFromEnvironment(environment);
  const deliveryOutboxFile = environment.HATCH_DELIVERY_OUTBOX_FILE?.trim()
    || (environment.HATCH_RUNTIME_DATA_DIR?.trim()
      ? path.join(environment.HATCH_RUNTIME_DATA_DIR.trim(), "delivery-accounting-outbox.json")
      : undefined);
  if (registryUrl && environment.NODE_ENV === "production" && !commerceEventSink) {
    throw new Error("HATCH_COMMERCE_URL is required for entitlement-backed Runtime delivery.");
  }
  if (registryUrl && commerceEventSink && environment.NODE_ENV === "production" && !deliveryOutboxFile) {
    throw new Error("HATCH_DELIVERY_OUTBOX_FILE or HATCH_RUNTIME_DATA_DIR is required for production delivery recovery.");
  }
  const conversationStore = createConversationStore(environment);
  // Attachments need records that outlive a restart: without a Runtime database a message takes text only.
  const chatAssets = conversationStore instanceof PostgresStore
    ? await openChatAssets({ pool: conversationStore.pool, blobs: objectStoreFromEnvironment(environment, path.join(runtimeDataDir, "chat-assets"))!, environment })
    : undefined;
  return createRuntimeServer({
    outputGuard: createOutputGuardFromEnvironment(environment),
    commerceEventSink,
    ...(commerceEventSink ? {
      deliveryAccountingOutbox: new DeliveryAccountingOutbox(
        deliveryOutboxFile ?? path.resolve(".hatch-runtime", "delivery-accounting-outbox.json")
      )
    } : {}),
    creatorToolControlPlane: creatorToolControlPlaneFromEnvironment(environment),
    entitlementResolver: registryAuth ?? fileEntitlements,
    insecureLocalMode: config.insecureLocalMode,
    authIdentityResolver: registryAuth,
    agentCorpusResolver: runtimeRegistryToken && registryUrl
      ? new RuntimeReleaseAgentCorpusResolver({
        registryUrl,
        serviceToken: runtimeRegistryToken,
        corpusRoot: runtimeCorpusRoot || path.join(runtimeDataDir, "corpora"),
        timeoutMs: registryAuthorizationTimeoutMs(environment)
      })
      : runtimeCorpusRoot
        ? new FilesystemAgentCorpusResolver(runtimeCorpusRoot)
        : undefined,
    conversationStore,
    ...(chatAssets ? { chatAssets } : {}),
    assetStore: runtimeAssetStoreFromEnvironment(environment, runtimeDataDir),
    chatServiceToken: config.chatServiceToken,
    maxContactMessages: config.maxContactMessages,
    ...(registryUrl && runtimeRegistryToken ? { connectionDirectory: new RegistryConnectionDirectory({ registryUrl, serviceToken: runtimeRegistryToken, timeoutMs: registryAuthorizationTimeoutMs(environment) }) } : {}),
    clientToolTimeoutMs: config.clientToolTimeoutMs,
    clientHelloTimeoutMs: config.helloTimeoutMs,
    maxPendingTurnAuthorizations: config.maxPendingTurnAuthorizations,
    maxPendingTurnAuthorizationsPerUser: config.maxPendingTurnAuthorizationsPerUser,
    allowedOrigins: config.allowedOrigins,
    maxActiveRunsPerUser: config.maxActiveRunsPerUser,
    maxActiveRunsGlobal: config.maxActiveRunsGlobal,
    maxSocketBufferedBytes: config.maxSocketBufferedBytes,
    maxConsumerBufferedBytes: config.maxConsumerBufferedBytes,
    connectionHeartbeatMs: config.connectionHeartbeatMs,
    connectionIdleTimeoutMs: config.connectionIdleTimeoutMs,
    serverToolTimeoutMs: config.serverToolTimeoutMs,
    httpHeadersTimeoutMs: config.httpHeadersTimeoutMs,
    httpRequestTimeoutMs: config.httpRequestTimeoutMs,
    maxHttpResponseBytes: config.maxHttpResponseBytes,
    enableLegacyHmacAuth: config.legacyHmacEnabled,
    legacyHmacSecret: config.legacyHmacSecret
  });
}

type ReadinessCheck = "starting" | "ready" | "failed";
type RuntimeReadiness = {
  /** Set once shutdown begins, so the proxy sends nothing new. */
  draining?: boolean;
  repository: ReadinessCheck;
  deliveryAccounting: ReadinessCheck | "disabled";
};
export function createRuntimeServer(options: RuntimeServerOptions = {}): RuntimeServer {
  const connectionTasks = new Set<Promise<void>>();
  const createRuntime = options.createRuntime ?? createAgentRuntime;
  const unconfigured = !options.entitlementResolver && !options.agentCorpusResolver && options.insecureLocalMode !== true;
  const entitlementResolver = unconfigured ? unconfiguredEntitlementResolver : options.entitlementResolver;
  const authIdentityResolver = options.authIdentityResolver
    ?? (entitlementResolver instanceof RegistryEntitlementResolver ? entitlementResolver : undefined);
  const agentCorpusResolver = unconfigured ? unconfiguredAgentCorpusResolver : options.agentCorpusResolver;
  const legacyHmacSecret = options.legacyHmacSecret?.trim() || undefined;
  if (options.enableLegacyHmacAuth === true && !legacyHmacSecret) {
    throw new Error("legacyHmacSecret is required when legacy HMAC auth is enabled");
  }
  const legacyHmacAuth: LegacyHmacAuth = {
    enabled: options.enableLegacyHmacAuth === true,
    signingSecret: options.enableLegacyHmacAuth === true
      ? legacyHmacSecret
      : undefined
  };
  const helloTimeoutMs = options.clientHelloTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(helloTimeoutMs) || helloTimeoutMs < 1) {
    throw new Error("clientHelloTimeoutMs must be a positive safe integer");
  }
  const turnAuthorizationGate = new CapacityGate(
    options.maxPendingTurnAuthorizations ?? 16,
    "maxPendingTurnAuthorizations"
  );
  const turnAuthorizationPerUserGate = new KeyedCapacityGate(
    options.maxPendingTurnAuthorizationsPerUser ?? 4,
    "maxPendingTurnAuthorizationsPerUser"
  );
  const activeRunGate = new CapacityGate(
    options.maxActiveRunsGlobal ?? 16,
    "maxActiveRunsGlobal"
  );
  const activeRunPerUserGate = new KeyedCapacityGate(
    options.maxActiveRunsPerUser ?? 2,
    "maxActiveRunsPerUser"
  );
  const connectionHeartbeatMs = options.connectionHeartbeatMs ?? 30_000;
  if (!Number.isSafeInteger(connectionHeartbeatMs) || connectionHeartbeatMs < 1) {
    throw new Error("connectionHeartbeatMs must be a positive safe integer");
  }
  const connectionIdleTimeoutMs = options.connectionIdleTimeoutMs ?? 1_800_000;
  if (!Number.isSafeInteger(connectionIdleTimeoutMs) || connectionIdleTimeoutMs < 1) {
    throw new Error("connectionIdleTimeoutMs must be a positive safe integer");
  }
  const conversationStore = options.conversationStore
    ?? (options.conversationRepository instanceof InMemoryConversationRepository
      ? new RuntimeStore(options.conversationRepository.localAuthority)
      : options.conversationRepository instanceof PostgresConversationRepository
        ? new PostgresStore({ pool: options.conversationRepository.pool }) : createConversationStore());
  const conversationRepository = options.conversationRepository ?? createConversationRepository(conversationStore);
  if (conversationStore instanceof PostgresStore && conversationRepository instanceof PostgresConversationRepository) {
    conversationRepository.bindSubmissionStore(conversationStore);
    failures.attach(new PostgresFailureLedger(conversationStore.pool as never));
  } else if (!(conversationRepository instanceof InMemoryConversationRepository)
    || conversationRepository.localAuthority !== conversationStore.localAuthority) {
    throw new Error("Runtime store and repository must share one submission authority");
  }
  // Production RuntimeStore exposes the app-data directory. A few server
  // integrations inject a transcript-compatible store without that optional
  // filesystem property; keep those integrations usable while preserving the
  // normal durable location whenever it is available.
  const dataDirectory = typeof conversationStore.dataDirectory === "string" && conversationStore.dataDirectory.length > 0
    ? conversationStore.dataDirectory
    : path.resolve(process.env.HATCH_RUNTIME_DATA_DIR ?? ".hatch-runtime");
  const assetStore = options.assetStore ?? runtimeAssetStoreFromEnvironment(process.env, dataDirectory);
  const commerceEventSink = options.commerceEventSink;
  const deliveryAccountingOutbox = options.deliveryAccountingOutbox
    ?? (commerceEventSink?.authorizeAndReserve
      ? new DeliveryAccountingOutbox(path.join(dataDirectory, "delivery-accounting-outbox.json"))
      : undefined);
  const repositoryReady = conversationRepository.initialize();
  const readiness: RuntimeReadiness = {
    repository: "starting",
    deliveryAccounting: commerceEventSink ? "starting" : "disabled"
  };
  void repositoryReady.then(
    () => { readiness.repository = "ready"; },
    () => { readiness.repository = "failed"; }
  );
  const reconciliationTasks = new Set<Promise<unknown>>();
  let reconciliationInFlight = false;
  const scheduleDeliveryReconciliation = (): void => {
    if (!commerceEventSink || !deliveryAccountingOutbox || reconciliationInFlight) return;
    reconciliationInFlight = true;
    const product = repositoryReady.then(async () => {
      await deliveryAccountingOutbox.initialize();
      await commerceEventSink.checkReady?.();
      await reconcileDeliveryAccountingOutbox(deliveryAccountingOutbox, commerceEventSink);
      readiness.deliveryAccounting = "ready";
    }).catch((error) => {
      readiness.deliveryAccounting = "failed";
      writeOperationalError("commerce_delivery_reconciliation_failed", error);
    });
    reconciliationTasks.add(product);
    void product.finally(() => {
      reconciliationInFlight = false;
      reconciliationTasks.delete(product);
    });
  };
  scheduleDeliveryReconciliation();
  const reconciliationInterval = commerceEventSink && deliveryAccountingOutbox
    ? setInterval(scheduleDeliveryReconciliation, options.deliveryReconcileIntervalMs ?? 5_000)
    : undefined;
  reconciliationInterval?.unref();
  const outputGuard = options.outputGuard ?? new PassThroughOutputGuard();
  const httpRequestTimeoutMs = options.httpRequestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(httpRequestTimeoutMs) || httpRequestTimeoutMs < 1) {
    throw new Error("httpRequestTimeoutMs must be a positive safe integer");
  }
  const httpHeadersTimeoutMs = options.httpHeadersTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(httpHeadersTimeoutMs) || httpHeadersTimeoutMs < 1) {
    throw new Error("httpHeadersTimeoutMs must be a positive safe integer");
  }
  const maxSocketBufferedBytes = options.maxSocketBufferedBytes ?? 160 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSocketBufferedBytes) || maxSocketBufferedBytes < MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES) {
    throw new Error(`maxSocketBufferedBytes must be an integer of at least ${MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES}`);
  }
  const maxHttpResponseBytes = options.maxHttpResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxHttpResponseBytes) || maxHttpResponseBytes < 1_024) {
    throw new Error("maxHttpResponseBytes must be an integer of at least 1024");
  }
  const allowedOrigins = options.allowedOrigins ?? [];
  // The attachment tools are part of the Chat tool set whenever this Runtime can hold attachments, for every Run.
  const chatAssets = options.chatAssets;
  if (chatAssets) for (const definition of attachmentToolDefinitions(chatAssets.tools())) toolRegistry.set(definition.name, definition);
  const parts: PartsReader = chatAssets ?? new TextPartsReader();

  const admission: RunAdmission = {
    reserve(principal) {
      const releaseGlobal = activeRunGate.tryAcquire();
      if (!releaseGlobal) throw new ChatError("runtime_run_capacity", "Hatch is already running the maximum number of tasks. Try again shortly.", 503);
      const releaseUser = activeRunPerUserGate.tryAcquire(principalKey(principal));
      if (!releaseUser) {
        releaseGlobal();
        throw new ChatError("user_run_capacity", "This account already has the maximum number of pending or active tasks.", 429);
      }
      return once(combineCapacityReleases(releaseGlobal, releaseUser));
    }
  };
  const scopes: ScopeResolver<SessionBinding> = {
    // A Run this process did not start (taken over after a restart) is rebuilt from its conversation.
    async resolve(conversation, signal) {
      const base = { creatorId: conversation.creatorId, userId: conversation.ownerAccountId, productId: conversation.productId };
      if (!agentCorpusResolver) return { ...base, corpusDigest: conversation.corpusDigest, explicit: false };
      const current = await agentCorpusResolver.resolve(conversation.creatorId, conversation.productId, signal);
      return {
        ...base,
        corpusDigest: current.digest,
        runtimeDigest: current.runtimeDigest,
        briefSpec: current.corpus.product.brief_spec as BriefSpec | undefined,
        agentCorpus: current.corpus,
        agentCorpusRoot: current.root,
        explicit: true
      };
    }
  };
  const serverToolTimeoutMs = options.serverToolTimeoutMs ?? 120_000;
  const runner: TurnRunner<SessionBinding> = {
    async run(turn) {
      const binding = turn.scope;
      try {
        const serverTools = new ServerToolExecutor(serverToolTimeoutMs);
        if (binding.agentCorpus && binding.agentCorpusRoot) {
          serverTools.setResolvedCreatorTools(binding.creatorTools ?? await resolveCreatorTools(
            options.creatorToolControlPlane,
            binding.creatorId,
            binding.productId,
            binding.agentCorpus,
            turn.signal
          ));
        }
        if (chatAssets) serverTools.setAttachments(chatAssets.toolsFor(turn.conversation));
        const sessionSkills = await buildSessionSkills(binding.agentCorpusRoot);
        await runModelTurn(
          turn.input, turn.persistedUser, sessionSkills, binding, turn.broker, serverTools,
          new ToolBridge(turn.broker, serverTools, () => turn.clientOf().client),
          createRuntime(), conversationStore, conversationRepository, assetStore, turn.state,
          async (message) => turn.publish(message), outputGuard, turn.signal,
          commerceEventSink, deliveryAccountingOutbox, scheduleDeliveryReconciliation,
          turn.clientOf, turn.claimSteered, turn.onSteer, turn.compaction
        );
      } catch (error) {
        await failRun(turn, error);
      }
    }
  };
  const chat = new ChatRuntime<SessionBinding>({
    repository: conversationRepository,
    store: conversationStore,
    runner,
    scopes,
    admission,
    limits: options.principalLimits ?? new SentMessageLimits(conversationRepository, options.maxContactMessages ?? DEFAULT_MAX_CONTACT_MESSAGES),
    toolTimeoutMs: options.clientToolTimeoutMs ?? clientToolTimeoutMs(),
    compactionStrategy: options.compactionStrategy,
    // With a shared database every instance sees every Run's live events.
    ...(conversationStore instanceof PostgresStore ? { relay: new PostgresEventRelay(conversationStore.pool as never), stops: new PostgresStopRelay(conversationStore.pool as never), steers: new PostgresStopRelay(conversationStore.pool as never, { channel: "hatch_run_steers" }) } : {})
  });
  void repositoryReady.then(() => chat.start()).catch(() => undefined);
  const edge: ChatEdge = {
    chat, parts, chatAssets, turnAuthorizationGate, turnAuthorizationPerUserGate,
    entitlementResolver, authIdentityResolver, agentCorpusResolver,
    creatorToolControlPlane: options.creatorToolControlPlane,
    consumerBufferedBytes: options.maxConsumerBufferedBytes ?? MAX_CONSUMER_BUFFERED_BYTES
  };
  const gateway = chatGatewayFor(options, chat, scopes, conversationRepository, conversationStore, agentCorpusResolver, parts, chatAssets);
  edge.serviceApi = new ChatServiceApi({ token: options.chatServiceToken, gateway });

  const inflight = new InflightResponses();
  const server = http.createServer(observed((req, res) => {
    inflight.track(res);
    const requestAbortController = new AbortController();
    const abortDisconnectedRequest = () => {
      requestAbortController.abort(new Error("Runtime HTTP client disconnected"));
    };
    req.once("aborted", abortDisconnectedRequest);
    res.once("close", () => {
      if (!res.writableEnded) abortDisconnectedRequest();
    });
    // A stream or a long wait is bounded by its own protocol, not by the short request deadline.
    const requestDeadlineMs = httpDeadlineMs(req, httpRequestTimeoutMs);
    const requestDeadline = requestDeadlineMs === undefined ? undefined : setTimeout(() => {
      requestAbortController.abort(new Error("Runtime HTTP request deadline exceeded"));
      if (!res.headersSent && !res.writableEnded) {
        writeJson(res, 504, {
          error: { code: "request_timeout", message: "The Runtime request timed out." }
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }, requestDeadlineMs);
    requestDeadline?.unref();
    const requestTask = handleHttpRequest(
      req,
      res,
      entitlementResolver,
      agentCorpusResolver,
      conversationStore,
      assetStore,
      authIdentityResolver,
      legacyHmacAuth,
      requestAbortController.signal,
      maxHttpResponseBytes,
      conversationRepository,
      repositoryReady,
      edge,
      commerceEventSink,
      readiness,
      allowedOrigins
    );
    void requestTask.catch((error) => {
      if (!res.destroyed && !res.writableEnded) handleHttpRequestFailure(res, error);
    }).finally(() => {
      clearTimeout(requestDeadline);
      req.off("aborted", abortDisconnectedRequest);
    });
  }));
  server.headersTimeout = httpHeadersTimeoutMs;
  server.requestTimeout = httpRequestTimeoutMs;
  const acceptedConnections = new Set<import("node:net").Socket>();
  server.on("connection", (connection) => {
    acceptedConnections.add(connection);
    connection.once("close", () => acceptedConnections.delete(connection));
  });

  const wss = new WebSocketServer({
    server,
    path: "/runtime",
    maxPayload: MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES,
    // A browser attaches its cookie to a cross-site upgrade: cookie auth needs an allowed Origin.
    verifyClient: (info, done) => {
      const verdict = checkUpgrade({ origin: info.origin, cookie: info.req.headers.cookie, url: info.req.url ?? "" }, allowedOrigins);
      if (verdict.ok) done(true);
      else done(false, verdict.status, verdict.message);
    }
  });
  wss.on("connection", (socket, request) => {
    // `ws` emits an error before close for malformed/oversized frames. Owning
    // the event prevents a process-level uncaught exception; close performs
    // the same cleanup as any other disconnect.
    socket.on("error", () => undefined);
    const product = handleRuntimeSocket(socket, bearerToken(request), {
      edge,
      store: conversationStore,
      conversationRepository,
      repositoryReady,
      legacyHmacAuth,
      helloTimeoutMs,
      connectionHeartbeatMs,
      connectionIdleTimeoutMs,
      maxSocketBufferedBytes
    });
    connectionTasks.add(product);
    void product.then(
      () => connectionTasks.delete(product),
      () => connectionTasks.delete(product)
    );
  });

  let serverClosed: Promise<void> | undefined;
  const stopIntake = async () => {
    readiness.draining = true;
    if (reconciliationInterval) clearInterval(reconciliationInterval);
    serverClosed ??= new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    serverClosed.catch(() => undefined);
  };
  return {
    server,
    wss,
    chat: gateway,
    shutdown: (deadlineMs) => gracefulShutdown({
      deadlineMs,
      markUnready: () => { readiness.draining = true; },
      stopIntake,
      // Runs finish here; one still going at the deadline is handed to the next instance, which resumes it from its lease.
      drain: async () => { await Promise.all([chat.drain(), inflight.requestsDone()]); },
      closeConnections: async () => {
        inflight.endAll();
        for (const client of wss.clients) client.close(1001, "server restarting: reconnect and resume");
        for (let waited = 0; wss.clients.size && waited < 1_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
      },
      closeStorage: () => close(),
      onError: (step, error) => log.error("runtime_shutdown_step_failed", { step, error }),
    }),
    close: () => close()
  };
  async function close(): Promise<void> {
    await stopIntake();
    for (const client of wss.clients) {
      // Shutdown must not wait for a peer to complete the WebSocket close
      // handshake. Tests caught the same production failure mode: a Desktop
      // connection can keep the Runtime process alive indefinitely during a
      // deploy after the HTTP server has otherwise stopped accepting work.
      client.terminate();
    }
    // A peer may already have started a close handshake and disappeared
    // from `wss.clients` while its upgraded TCP socket is still open.
    for (const connection of acceptedConnections) connection.destroy();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await serverClosed;
    await Promise.allSettled([...connectionTasks]);
    // Runs are handed off, not failed: another instance continues them.
    await chat.stop();
    await Promise.allSettled([...reconciliationTasks]);
    await conversationStore.close();
    await conversationRepository.close();
    await flushLangfuseObservability();
  }
}

/** Streams and `?wait=` polls bound themselves; everything else gets the request deadline. */
function httpDeadlineMs(req: http.IncomingMessage, requestTimeoutMs: number): number | undefined {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (String(req.headers.accept ?? "").includes("text/event-stream")) return undefined;
  const wait = Number(url.searchParams.get("wait") ?? 0);
  return requestTimeoutMs + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_WAIT_SECONDS) * 1000 : 0);
}

/** The gateway the channel layer calls: contacts through their Connection, accounts through their conversation. */
function chatGatewayFor(
  options: RuntimeServerOptions,
  chat: ChatRuntime<SessionBinding>,
  scopes: ScopeResolver<SessionBinding>,
  repository: ConversationRepository,
  store: RuntimeStore,
  agentCorpusResolver: AgentCorpusResolver | undefined,
  parts: PartsReader,
  chatAssets: ChatAssets | undefined
): ChatGateway {
  const contactBinder = options.connectionDirectory && agentCorpusResolver
    ? new ContactBinder(options.connectionDirectory, agentCorpusResolver, repository)
    : undefined;
  const selfBinder = options.connectionDirectory && agentCorpusResolver
    ? new SelfBinder(options.connectionDirectory, agentCorpusResolver, repository)
    : undefined;
  const unavailable = (kind: string): never => { throw new ChatError("binding_unavailable", `${kind} messages are not configured on this Runtime.`, 503); };
  return new ServiceChatGateway<SessionBinding>({
    chat: chat.service,
    parts,
    ...(chatAssets ? { uploads: chatAssets } : {}),
    repository,
    history: store,
    binders: {
      contact: {
        async bind(principal, ref) {
          if (principal.kind !== "contact" || !contactBinder) return unavailable("Customer");
          const bound = await contactBinder.bind(principal, ref);
          const scope = await scopes.resolve(bound.conversation, new AbortController().signal);
          return { conversation: bound.conversation, scope: { ...scope, userId: principalKey(principal) }, corpusDigest: bound.corpus.digest, requiresLocalTools: bound.requiresLocalTools };
        }
      },
      account: {
        async bind(principal, ref) {
          if (principal.kind !== "account") return unavailable("Account");
          // A conversation by id is the account's own; a thread is a self Connection's, bound to its linked account.
          if (ref.kind === "thread" && !selfBinder) return unavailable("Self-use");
          const conversation = ref.kind === "conversation" ? await repository.getConversation(ref.id) : await selfBinder!.conversationFor(principal.accountId, ref);
          if (!conversation || conversation.ownerAccountId !== principal.accountId) throw new ChatError("conversation_not_found", "Conversation was not found.", 404);
          const scope = await scopes.resolve(conversation, new AbortController().signal);
          return { conversation, scope, corpusDigest: scope.corpusDigest, requiresLocalTools: scope.agentCorpus ? productRequiresLocalTools(scope.agentCorpus) : false };
        }
      }
    }
  });
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  conversationStore?: RuntimeStore,
  assetStore?: RuntimeAssetStore,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal,
  maxHttpResponseBytes = 64 * 1024 * 1024,
  conversationRepository?: ConversationRepository,
  repositoryReady?: Promise<unknown>,
  edge?: ChatEdge,
  commerceEventSink?: CommerceEventSink,
  readiness?: RuntimeReadiness,
  allowedOrigins: readonly string[] = []
): Promise<void> {
  setCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/healthz") {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/readyz") {
    const repository = readiness?.repository ?? "failed";
    const deliveryAccounting = readiness?.deliveryAccounting ?? "disabled";
    const ready = !readiness?.draining && repository === "ready"
      && (deliveryAccounting === "ready" || deliveryAccounting === "disabled");
    writeJson(res, ready ? 200 : 503, {
      ok: ready,
      checks: {
        conversation_repository: repository,
        delivery_accounting: deliveryAccounting
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/me/creator-agents") {
    const authToken = bearerToken(req);
    if (!authToken) {
      writeJson(res, 401, { error: { code: "authentication_required", message: "Sign in to view purchased Expert Agents." } });
      return;
    }
    let identity: AuthIdentity | undefined;
    try {
      identity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
    } catch (error) {
      writeJson(res, 503, { error: { code: error instanceof EntitlementError ? error.code : "authentication_unavailable", message: errorMessage(error) } });
      return;
    }
    const claims = identity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth);
    if (authIdentityResolver && !identity) {
      writeJson(res, 401, { error: { code: "authentication_required", message: "Your Hatch session is no longer valid." } });
      return;
    }
    if (!claims && !entitlementResolver) {
      writeJson(res, 503, { error: { code: "entitlements_unavailable", message: "Expert Agent purchases are temporarily unavailable." } });
      return;
    }
    try {
      // Access is relational: owned rows are the account's own published
      // Products (addressed by product_id, no entitlement_id); every other
      // row is an entitlement grant.
      const creatorAgents: Array<Record<string, unknown>> = claims && agentCorpusResolver
        ? (await agentCorpusResolver.list(claims.sub, signal)).map(({ corpus, digest }) => ({
          creator_id: corpus.creator.id,
          product_id: corpus.product.id,
          corpus_digest: digest,
          effective_corpus_digest: digest,
          creator: corpus.creator,
          product: {
            id: corpus.product.id,
            name: corpus.product.name,
            description: corpus.product.description ?? "",
            ...(corpus.product.brief_spec ? { brief_spec: corpus.product.brief_spec } : {}),
            ...(corpus.product.promise ? { promise: corpus.product.promise } : {}),
            ...(corpus.product.boundaries.length ? { boundaries: corpus.product.boundaries } : {})
          },
          presentation: corpus.product.presentation
        }))
        : [];
      if (entitlementResolver) {
        const entitlements = await entitlementResolver.list({
          authToken,
          licenseToken: authToken,
          signal
        });
        // Resolve Corpus digests sequentially. A buyer can own many grants and
        // each digest walks bounded assets; unbounded Promise.all multiplies
        // transient memory by the full grant count.
        for (const entitlement of entitlements) {
          signal?.throwIfAborted();
          assertEntitlementMatchesIdentity(claims, entitlement);
          if (!agentCorpusResolver) throw new Error("Current Agent Corpus resolver is unavailable");
          let resolved: Awaited<ReturnType<AgentCorpusResolver["resolve"]>>;
          try {
            resolved = await agentCorpusResolver.resolve(entitlement.creator_id, entitlement.product_id, signal);
          } catch (error) {
            // A withdrawn Agent is not chat-able; it leaves the list like it
            // leaves the Web library. Every other failure still fails the call.
            if (error instanceof AgentReleaseUnavailableError) continue;
            throw error;
          }
          if (resolved.corpus.product.id !== entitlement.product_id || resolved.corpus.creator.id !== entitlement.creator_id) {
            throw new Error(`Entitlement ${entitlement.entitlement_id} does not match its current Agent Corpus`);
          }
          creatorAgents.push({
            entitlement_id: entitlement.entitlement_id,
            creator_id: entitlement.creator_id,
            product_id: entitlement.product_id,
            corpus_digest: resolved.digest,
            purchased_corpus_digest: entitlement.purchased_corpus_digest ?? resolved.digest,
            effective_corpus_digest: resolved.digest,
            creator: resolved.corpus.creator,
            product: {
              id: resolved.corpus.product.id,
              name: resolved.corpus.product.name,
              description: resolved.corpus.product.description ?? "",
              ...(resolved.corpus.product.brief_spec ? { brief_spec: resolved.corpus.product.brief_spec } : {}),
              ...(resolved.corpus.product.promise ? { promise: resolved.corpus.product.promise } : {}),
              ...(resolved.corpus.product.boundaries.length ? { boundaries: resolved.corpus.product.boundaries } : {})
            },
            presentation: resolved.corpus.product.presentation
          });
        }
      }
      writeJsonBounded(res, 200, { creator_agents: creatorAgents }, maxHttpResponseBytes);
    } catch (error) {
      writeHttpAuthorizationFailure(res, error, "entitlement_lookup_failed");
    }
    return;
  }

  if (url.pathname.startsWith("/v1/service/chat/")) {
    try {
      await repositoryReady;
      if (!await edge?.serviceApi?.handle(req, res, url)) throw new ConversationHttpError(404, "not_found", "Route was not found.");
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  if (url.pathname === "/v1/conversations" || url.pathname.startsWith("/v1/conversations/")) {
    if (!conversationRepository) {
      writeJson(res, 503, { error: { code: "conversation_repository_unavailable", message: "Conversation storage is unavailable." } });
      return;
    }
    try {
      await repositoryReady;
      await handleConversationHttpRequest(
        req,
        res,
        url,
        conversationRepository,
        conversationStore,
        assetStore,
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        signal,
        edge,
        maxHttpResponseBytes,
        allowedOrigins
      );
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  const match = url.pathname.match(/^\/conversations\/([^/]+)\/messages$/);
  if (req.method === "GET" && match) {
    const conversationId = decodeURIComponent(match[1] ?? "");
    let binding: SessionBinding | undefined;
    try {
      binding = await bindingFromHistoryRequest(
        req,
        url,
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        signal
      );
    } catch (error) {
      writeHttpAuthorizationFailure(res, error, "entitlement_required");
      return;
    }
    if (!binding) {
      writeJson(res, 400, { error: { code: "binding_required", message: "A signed-in entitlement binding is required." } });
      return;
    }
    const store = conversationStore ?? createConversationStore();
    const durableHistoryId = durableConversationId(binding, conversationId);
    const durableMessages = await store.readVisibleConversation(durableHistoryId);
    // Keep old Desktop builds readable during the migration from the
    // corpus-digest-scoped transcript key. New WS runs always write to the
    // durable identity so an Agent Corpus update cannot orphan history.
    const legacyHistoryId = scopedConversationId(binding, conversationId);
    const storageConversationId = durableMessages.length > 0 || durableHistoryId === legacyHistoryId
      ? durableHistoryId
      : legacyHistoryId;
    const messages = durableMessages.length > 0 || durableHistoryId === legacyHistoryId
      ? durableMessages
      : await store.readVisibleConversation(legacyHistoryId);
    const historyTruncated = typeof (store as RuntimeStore & {
      visibleConversationTruncated?: (id: string) => Promise<boolean>;
    }).visibleConversationTruncated === "function"
      ? await (store as RuntimeStore & {
        visibleConversationTruncated: (id: string) => Promise<boolean>;
      }).visibleConversationTruncated(storageConversationId)
      : false;
    writeJsonBounded(res, 200, {
      conversation_id: conversationId,
      product_id: binding.productId,
      creator_id: binding.creatorId,
      messages: sanitizeBoundHistory(
        messages,
        binding.productId
      ),
      history_truncated: historyTruncated
    }, maxHttpResponseBytes);
    return;
  }

  const legacyAssetMatch = url.pathname.match(/^\/conversations\/([^/]+)\/assets\/([^/]+)$/);
  if (req.method === "GET" && legacyAssetMatch) {
    const conversationId = decodeURIComponent(legacyAssetMatch[1] ?? "");
    let binding: SessionBinding | undefined;
    try {
      binding = await bindingFromHistoryRequest(
        req,
        url,
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        signal
      );
    } catch (error) {
      writeHttpAuthorizationFailure(res, error, "entitlement_required");
      return;
    }
    if (!binding) {
      writeJson(res, 400, { error: { code: "binding_required", message: "A signed-in entitlement binding is required." } });
      return;
    }
    const store = conversationStore ?? createConversationStore();
    const durableHistoryId = durableConversationId(binding, conversationId);
    const durableMessages = await store.readVisibleConversation(durableHistoryId);
    const legacyHistoryId = scopedConversationId(binding, conversationId);
    const storageConversationId = durableMessages.length > 0 || durableHistoryId === legacyHistoryId
      ? durableHistoryId
      : legacyHistoryId;
    try {
      await serveConversationAsset(
        res,
        store,
        assetStore,
        storageConversationId,
        decodeURIComponent(legacyAssetMatch[2] ?? "")
      );
    } catch (error) {
      writeConversationHttpError(req, res, error);
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

async function serveConversationAsset(
  res: http.ServerResponse,
  store: RuntimeStore | undefined,
  assetStore: RuntimeAssetStore | undefined,
  conversationId: string,
  assetId: string
): Promise<void> {
  if (!store || !assetStore) {
    throw new ConversationHttpError(503, "asset_store_unavailable", "Conversation assets are temporarily unavailable.");
  }
  if (!assetId) {
    throw new ConversationHttpError(404, "asset_not_found", "The conversation asset was not found.");
  }

  // The transcript is the authorization boundary for binary assets. A caller
  // may only read an asset whose immutable reference was already committed to
  // this conversation; knowing or guessing an asset_id is not sufficient.
  const reference = await store.readConversationAssetReference(conversationId, assetId);
  if (!reference) {
    throw new ConversationHttpError(404, "asset_not_found", "The conversation asset was not found.");
  }

  let bytes: Buffer;
  try {
    bytes = await assetStore.read(assetId, reference.storage_ref);
  } catch (error) {
    if (isMissingAssetError(error)) {
      throw new ConversationHttpError(404, "asset_not_found", "The conversation asset is no longer available.");
    }
    throw new ConversationHttpError(500, "asset_unavailable", "The conversation asset could not be read.");
  }
  if (bytes.byteLength !== reference.source_bytes
    || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new ConversationHttpError(500, "asset_corrupt", "The conversation asset failed its integrity check.");
  }

  const mediaType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(reference.media_type)
    ? reference.media_type
    : "application/octet-stream";
  const filename = encodeURIComponent(reference.display_name.replace(/[\r\n]/g, "_")).replaceAll("'", "%27");
  res.writeHead(200, {
    "content-type": mediaType,
    "content-length": String(bytes.byteLength),
    "content-disposition": `inline; filename*=UTF-8''${filename}`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff"
  });
  res.end(bytes);
}

function isMissingAssetError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && (("code" in error && ["ENOENT", "NoSuchKey", "NotFound"].includes(String((error as { code?: unknown }).code)))
      || ("status" in error && Number((error as { status?: unknown }).status) === 404)
      || ("statusCode" in error && Number((error as { statusCode?: unknown }).statusCode) === 404))
  );
}

/**
 * HTTP is the durable Library/read model. The WebSocket remains the executor
 * transport for a run, but both paths use the same repository and binding.
 * This makes renderer reload/reconnect recovery possible without treating the
 * transcript event log as a control-plane database.
 */
async function handleConversationHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  repository: ConversationRepository,
  store: RuntimeStore | undefined,
  assetStore: RuntimeAssetStore | undefined,
  entitlementResolver: EntitlementResolver | undefined,
  agentCorpusResolver: AgentCorpusResolver | undefined,
  authIdentityResolver: AuthIdentityResolver | undefined,
  legacyHmacAuth: LegacyHmacAuth,
  signal: AbortSignal | undefined,
  edge: ChatEdge | undefined,
  maxHttpResponseBytes: number,
  allowedOrigins: readonly string[]
): Promise<void> {
  const binding = await requireConversationBinding(
    req,
    url,
    entitlementResolver,
    agentCorpusResolver,
    authIdentityResolver,
    legacyHmacAuth,
    signal
  );
  const repoBinding = conversationBinding(binding);
  const writeResponse = (status: number, body: unknown) => writeJsonBounded(res, status, body, maxHttpResponseBytes);
  const authToken = bearerToken(req);
  // A cookie is sent by the browser on any cross-site request, so changing anything with one needs an allowed Origin.
  if (req.method !== "GET" && typeof req.headers.authorization !== "string" && sessionTokenFromCookie(req.headers.cookie)
    && !(typeof req.headers.origin === "string" && allowedOrigins.includes(req.headers.origin))) {
    throw new ConversationHttpError(403, "origin_not_allowed", "This origin may not use a browser session.");
  }
  const requireEdge = (): ChatEdge => {
    if (!edge) throw new ConversationHttpError(503, "chat_unavailable", "The Chat API is unavailable.");
    return edge;
  };

  if (url.pathname === "/v1/conversations") {
    if (req.method === "GET") {
      const status = parseConversationStatus(url.searchParams.get("status"));
      const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 100);
      const page = await repository.listConversations(repoBinding, {
        ...(status ? { status } : {}),
        ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
        ...(limit ? { limit } : {})
      });
      writeResponse(200, {
        conversations: page.conversations.map(publicConversation),
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        sent_message_count: await repository.countSentMessages(repoBinding)
      });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["title", "client_request_id", "brief_answers"]);
      const title = optionalString(body, "title", 500);
      const clientRequestId = optionalString(body, "client_request_id", 256);
      const briefSnapshot = binding.briefSpec
        ? createBriefSnapshot(binding.briefSpec, body.brief_answers)
        : undefined;
      const publicId = `conv_${randomUUID().replaceAll("-", "")}`;
      const created = await repository.createConversation({
        ...repoBinding,
        id: durableConversationId(binding, publicId),
        publicId,
        ...(title ? { title } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(briefSnapshot ? { briefSnapshot } : {})
      });
      writeResponse(created.created ? 201 : 200, { conversation: publicConversation(created.conversation), created: created.created });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET or POST for /v1/conversations.");
  }

  const uploadMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/assets$/);
  if (uploadMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to upload a file.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(uploadMatch[1] ?? ""));
    const chatAssets = requireEdge().chatAssets;
    if (!chatAssets) throw new ConversationHttpError(501, "attachments_unavailable", "This Runtime cannot take attachments.");
    // The file is the request body and its name is `?name=`: it becomes a ready asset, or is refused with the reason.
    const name = url.searchParams.get("name")?.trim();
    if (!name) throw new ConversationHttpError(400, "invalid_upload", "name is the file's name.");
    const bytes = await readBoundedBytes(req, MAX_UPLOAD_BYTES);
    if (!bytes.length) throw new ConversationHttpError(400, "invalid_upload", "The file is empty.");
    writeResponse(201, await chatAssets.upload(conversation, { name, bytes }));
    return;
  }

  const assetMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/assets\/([^/]+)$/);
  if (assetMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(assetMatch[1] ?? ""));
    if (req.method !== "GET") {
      throw new ConversationHttpError(405, "method_not_allowed", "Use GET for a conversation asset.");
    }
    await serveConversationAsset(
      res,
      store,
      assetStore,
      conversation.id,
      decodeURIComponent(assetMatch[2] ?? "")
    );
    return;
  }

  const conversationMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)$/);
  if (conversationMatch) {
    const resolved = await requireBoundConversation(repository, binding, decodeURIComponent(conversationMatch[1] ?? ""));
    if (req.method === "GET") {
      writeResponse(200, { conversation: publicConversation(resolved) });
      return;
    }
    if (req.method === "PATCH") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["title", "status", "version"]);
      const title = body.title === null ? null : optionalString(body, "title", 500);
      const status = body.status === undefined ? undefined : parseConversationStatus(valueString(body, "status"));
      const expectedVersion = body.version === undefined ? undefined : positiveIntegerValue(body.version, "version", Number.MAX_SAFE_INTEGER);
      if (body.title === undefined && body.status === undefined) {
        throw new ConversationHttpError(400, "metadata_required", "Provide title or status when updating a conversation.");
      }
      const updated = await repository.updateConversation(resolved.id, {
        ...(body.title !== undefined ? { title } : {}),
        ...(status ? { status } : {}),
        ...(expectedVersion ? { expectedVersion } : {})
      });
      writeResponse(200, { conversation: publicConversation(updated) });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET or PATCH for a conversation.");
  }

  const toolDetailMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/tools\/([^/]+)\/([^/]+)$/);
  if (toolDetailMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(toolDetailMatch[1] ?? ""));
    if (!store) throw new ConversationHttpError(503, "history_unavailable", "Conversation history is unavailable.");
    const tool = await store.readConversationToolDetail(conversation.id,
      decodeURIComponent(toolDetailMatch[2] ?? ""), decodeURIComponent(toolDetailMatch[3] ?? ""));
    if (!tool) throw new ConversationHttpError(404, "tool_not_found", "The tool output was not found in this conversation.");
    const projected = sanitizeBoundHistory([{
      run_id: tool.run_id, role: "assistant", content: "", timestamp: tool.timestamp, tool_calls: [tool]
    }], binding.productId);
    writeResponse(200, { tool: projected[0]?.tool_calls?.[0] });
    return;
  }

  const historyMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(historyMatch[1] ?? ""));
    if (!store) throw new ConversationHttpError(503, "history_unavailable", "Conversation history is unavailable.");
    const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 100) ?? 50;
    const page = await new ChatConversationReadModel({ history: store, repository }).page(conversation.id, {
      limit,
      beforeCursor: url.searchParams.get("before_cursor") ?? undefined
    });
    writeResponse(200, { ...page, messages: sanitizeBoundHistory(page.messages, binding.productId) });
    return;
  }

  const snapshotMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/(snapshot|events)$/);
  if (snapshotMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(snapshotMatch[1] ?? ""));
    const afterCursor = parseNonNegativeInteger(url.searchParams.get("after_cursor"), "after_cursor");
    if (url.searchParams.get("view") === "page") {
      if (snapshotMatch[2] === "events") {
        const throughCursor = parseNonNegativeInteger(url.searchParams.get("through_cursor"), "through_cursor");
        const limit = parsePositiveInteger(url.searchParams.get("limit"), "limit", 200) ?? 100;
        const page = await repository.journalPage(conversation.id, afterCursor ?? 0, throughCursor, limit);
        writeResponse(200, {
          ...page,
          conversation_id: conversation.publicId,
          events: page.events.map(publicJournalEvent),
          runs: page.runs.map(publicRun)
        });
        return;
      }
      if (!store) throw new ConversationHttpError(503, "history_unavailable", "Conversation history is unavailable.");
      // Capture the recovery waterline before reading the projection. Events
      // committed while history is loading are then covered by incremental recovery.
      const snapshot = await repository.recoverySnapshot(conversation.id, []);
      const page = await new ChatConversationReadModel({ history: store, repository }).page(conversation.id, { limit: 50 });
      const pageRuns = await Promise.all(page.run_ids.map((id) => repository.getRun(conversation.id, id)));
      const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
      for (const run of pageRuns) if (run) runs.set(run.id, run);
      writeResponse(200, {
        conversation: publicConversation(snapshot.conversation),
        ...page,
        messages: sanitizeBoundHistory(page.messages, binding.productId),
        runs: [...runs.values()].map(publicRun),
        events: [],
        cursor: snapshot.cursor
      });
      return;
    }
    if (snapshotMatch[2] === "events" && String(req.headers.accept ?? "").includes("text/event-stream")) {
      // Resume by cursor: after_cursor, or the Last-Event-ID the browser echoes on reconnect.
      const lastEventId = Number(req.headers["last-event-id"]);
      const resumeAfter = afterCursor ?? (Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : (await repository.recoverySnapshot(conversation.id, [])).cursor);
      openEventStream(res, requireEdge(), conversation, resumeAfter, privateBoundaryProjection(() => binding));
      return;
    }
    const snapshot = await repository.snapshot(conversation.id, afterCursor ?? 0);
    const eventResponse = snapshot.events.map(publicJournalEvent);
    if (snapshotMatch[2] === "events") {
      writeResponse(200, { conversation_id: conversation.publicId, events: eventResponse, cursor: snapshot.cursor });
      return;
    }
    const messages = store
      ? sanitizeBoundHistory(await store.readVisibleConversation(conversation.id), binding.productId)
      : [];
    writeResponse(200, {
      conversation: publicConversation(snapshot.conversation),
      runs: snapshot.runs.map(publicRun),
      messages,
      events: eventResponse,
      cursor: snapshot.cursor,
      pending_tool_calls: await edge?.chat.pendingToolRequests(conversation.id) ?? []
    });
    return;
  }

  const messagesMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to send a message.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(messagesMatch[1] ?? ""));
    const body = await readJsonObject(req);
    rejectUnknownFields(body, ["client_message_id", "content", "parts", "client", "device", "locale", "language", "time_zone"]);
    const clientMessageId = requiredString(body, "client_message_id", 256);
    if ((body.content === undefined) === (body.parts === undefined)) {
      throw new ConversationHttpError(400, "invalid_request", "Provide either content or parts.");
    }
    const content = body.content !== undefined ? requiredString(body, "content", MAX_USER_MESSAGE_CHARS) : "";
    const chatEdge = requireEdge();
    // Parts may refer to ready assets: they are resolved before anything is accepted.
    const prepared = body.parts !== undefined ? await chatEdge.parts.prepare(contentPartsOf(body.parts), conversation, clientMessageId) : undefined;
    const wait = parseNonNegativeInteger(url.searchParams.get("wait"), "wait") ?? 0;
    const streaming = String(req.headers.accept ?? "").includes("text/event-stream");
    // Without more to go on, an HTTP caller is an agent without a machine for local tools.
    const client = clientAttributesOf({ client: "mcp", ...body } as { client?: string });
    const before = (await repository.recoverySnapshot(conversation.id, [])).cursor;
    const { submission } = await submitUserMessage(chatEdge, { authToken, binding, conversation }, {
      runId: `run_${randomUUID().replaceAll("-", "")}`,
      clientMessageId,
      ...(prepared ? { prepared } : {}),
      message: { role: "user", content },
      taskStart: false,
      client,
      ...(typeof body.time_zone === "string" ? { timeZone: body.time_zone } : {})
    }, signal);
    if (streaming) {
      // A send replayed after its Run ended has no end left to wait for: it is answered with the Run's result.
      const ended = submission.outcome === "replayed" ? await repository.getRun(conversation.id, submission.run.id) : undefined;
      const finished = ended && TERMINAL_STATUSES.has(ended.status) ? {
        status: ended.status,
        reply: ended.status === "completed" && store ? finalAssistantText(await store.readVisibleConversation(conversation.id), ended.id) : "",
        cursor: await repository.latestRunStateCursor(ended.id)
      } : undefined;
      openEventStream(res, chatEdge, conversation, before, privateBoundaryProjection(() => binding), submission, finished);
      return;
    }
    const run = await waitForTerminalRun(() => repository.getRun(conversation.id, submission.run.id), Math.min(wait, MAX_WAIT_SECONDS) * 1000, 100, signal);
    if (!run || !TERMINAL_STATUSES.has(run.status)) {
      writeResponse(202, { run_id: submission.run.id, outcome: submission.outcome, status: run?.status ?? submission.run.status });
      return;
    }
    const reply = run.status === "completed" && store ? finalAssistantText(await store.readVisibleConversation(conversation.id), run.id) : "";
    writeResponse(200, { run: publicRun(run), outcome: submission.outcome, reply });
    return;
  }

  const retryMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/retry$/);
  if (retryMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to answer again.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(retryMatch[1] ?? ""));
    const body = await readJsonObject(req);
    rejectUnknownFields(body, ["retry_id", "client", "device", "locale", "language", "time_zone"]);
    // The client's key for this answer again: the same key is the same Run, whatever happened to the response.
    const retried = await retryRun(requireEdge(), { authToken, binding, conversation }, {
      runId: `run_${randomUUID().replaceAll("-", "")}`,
      key: requiredString(body, "retry_id", 256),
      client: clientAttributesOf({ client: "mcp", ...body } as { client?: string }),
      ...(typeof body.time_zone === "string" ? { timeZone: body.time_zone } : {})
    }, signal);
    writeResponse(202, { run_id: retried.run.id, outcome: retried.outcome, status: retried.run.status });
    return;
  }

  const toolResultsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/tool-results$/);
  if (toolResultsMatch) {
    if (req.method !== "POST") throw new ConversationHttpError(405, "method_not_allowed", "Use POST to provide a tool result.");
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(toolResultsMatch[1] ?? ""));
    const chatEdge = requireEdge();
    const { client: clientField, ...resultBody } = await readJsonObject(req);
    const result = ToolCallResultSchema.parse({ type: "tool_call.result", ...resultBody });
    const client = clientAttributesOf({ client: typeof clientField === "string" ? clientField : "cli" });
    const answer = await chatEdge.chat.answerTool(conversation.id, result, client.client);
    if (answer.outcome !== "accepted") throw new ConversationHttpError(answer.outcome === "forbidden" ? 403 : 404, answer.error.code, answer.error.message);
    writeResponse(200, { accepted: true });
    return;
  }

  const runsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs$/);
  if (runsMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(runsMatch[1] ?? ""));
    if (req.method === "GET") {
      writeResponse(200, { conversation_id: conversation.publicId, runs: (await repository.listRuns(conversation.id)).map(publicRun) });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET for runs; send a message with POST /messages to start or steer a Run.");
  }

  const runMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs\/([^/]+)(?:\/(cancel))?$/);
  if (runMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(runMatch[1] ?? ""));
    const runId = decodeURIComponent(runMatch[2] ?? "");
    if (runMatch[3] === "cancel" && req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["reason"]);
      const reason = optionalString(body, "reason", 500) ?? "Run cancelled";
      await requireEdge().chat.cancel(conversation.id, runId, reason);
      const run = await repository.getRun(conversation.id, runId);
      if (!run) throw new ConversationHttpError(404, "run_not_found", `Run ${runId} was not found.`);
      if (!store) throw new ConversationHttpError(503, "history_unavailable", "Message acceptance is unavailable.");
      const receipt = await store.readSubmissionReceipt(conversation.id, runId);
      writeResponse(200, { run: publicRun(run), submission: receipt ?? null });
      return;
    }
    if (!runMatch[3] && req.method === "GET") {
      const run = await repository.getRun(conversation.id, runId);
      if (!run) throw new ConversationHttpError(404, "run_not_found", `Run ${runId} was not found.`);
      if (!store) throw new ConversationHttpError(503, "history_unavailable", "Message acceptance is unavailable.");
      const receipt = await store.readSubmissionReceipt(conversation.id, runId);
      writeResponse(200, { run: publicRun(run), submission: receipt ?? null });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET for a run or POST for /cancel.");
  }

  throw new ConversationHttpError(404, "not_found", "Conversation route was not found.");
}

async function requireConversationBinding(
  req: http.IncomingMessage,
  url: URL,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal
): Promise<SessionBinding> {
  try {
    const binding = await bindingFromHistoryRequest(
      req,
      url,
      entitlementResolver,
      agentCorpusResolver,
      authIdentityResolver,
      legacyHmacAuth,
      signal
    );
    if (!binding) throw new ConversationHttpError(400, "binding_required", "A signed-in Expert Agent binding is required.");
    return binding;
  } catch (error) {
    if (error instanceof ConversationHttpError) throw error;
    throw new ConversationHttpError(403, "entitlement_required", errorMessage(error));
  }
}

async function requireBoundConversation(
  repository: ConversationRepository,
  binding: SessionBinding,
  publicId: string
) {
  if (!publicId) throw new ConversationHttpError(400, "conversation_id_required", "A conversation ID is required.");
  const conversation = await repository.getConversation(durableConversationId(binding, publicId));
  if (!conversation) throw new ConversationHttpError(404, "conversation_not_found", `Conversation ${publicId} was not found.`);
  try {
    assertConversationBinding(conversation, conversationBinding(binding));
  } catch (error) {
    if (error instanceof ConversationRepositoryError) {
      throw new ConversationHttpError(403, error.code, error.message);
    }
    throw error;
  }
  return conversation;
}

function publicConversation(conversation: ConversationRecord): Record<string, unknown> {
  return {
    id: conversation.publicId,
    creator_id: conversation.creatorId,
    agent_id: conversation.agentId,
    product_id_at_creation: conversation.productIdAtCreation,
    ...(conversation.title ? { title: conversation.title } : {}),
    status: conversation.status,
    created_at: conversation.createdAt,
    updated_at: conversation.updatedAt,
    version: conversation.version,
    ...(conversation.briefSnapshot ? { brief_snapshot: conversation.briefSnapshot } : {})
  };
}

function contentPartsOf(value: unknown): ContentPart[] {
  if (!Array.isArray(value) || value.length === 0) throw new ConversationHttpError(400, "invalid_request", "parts must be a non-empty array.");
  return value.map((part) => {
    const record = part as Record<string, unknown>;
    if (record?.type === "text" && typeof record.text === "string") return { type: "text" as const, text: record.text };
    if ((record?.type === "image" || record?.type === "file" || record?.type === "audio") && typeof record.assetId === "string") {
      return { type: record.type, assetId: record.assetId };
    }
    throw new ConversationHttpError(400, "invalid_request", "Each part is text, or an image, file or audio with an assetId.");
  });
}

/**
 * Streams a conversation as Server-Sent Events from a cursor. The stream ends when the
 * Run it was opened for ends; closing it early never stops the Run.
 */
function openEventStream(
  res: http.ServerResponse,
  edge: ChatEdge,
  conversation: ConversationRecord,
  afterCursor: number,
  project: EventProjection,
  submission?: Submission,
  /** The submission's Run had already ended: the stream carries its reply and its end, and closes. */
  finished?: { status: string; reply: string; cursor?: number }
): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const sink = projecting(new SseSink(res, edge.consumerBufferedBytes), project);
  if (submission) {
    sink.push({ type: "message.accepted", conversation_id: conversation.publicId, run_id: submission.run.id, client_message_id: submission.clientMessageId, outcome: submission.outcome });
  }
  if (submission && finished) {
    if (finished.reply) sink.push({ type: "assistant.delta", run_id: submission.run.id, delta: { kind: "text", content: finished.reply, offset: 0 } });
    sink.push({ type: "journal.event", ...(finished.cursor === undefined ? {} : { cursor: finished.cursor }), journal_type: "run.state", run_id: submission.run.id, payload: { id: submission.run.id, status: finished.status } });
    res.end();
    return;
  }
  const detach = edge.chat.feed.attach(conversation.id, { afterCursor, stream: true }, {
    push(event) {
      sink.push(event);
      const ended = event.type === "journal.event" && event.journal_type === "run.state" && event.run_id === submission?.run.id
        && TERMINAL_STATUSES.has(String((event.payload as { status?: string }).status));
      if (ended) { detach(); res.end(); }
    }
  });
  res.once("close", detach);
  void edge.chat.pendingToolRequests(conversation.id).then((pending) => {
    for (const request of pending) { try { sink.push(request as unknown as Record<string, unknown>); } catch { detach(); } }
  });
}

function publicJournalEvent(event: ConversationJournalEvent): Record<string, unknown> {
  return {
    cursor: event.cursor,
    ...(event.runId ? { run_id: event.runId } : {}),
    type: event.type,
    payload: publicJournalPayload(event.payload),
    created_at: event.createdAt
  };
}

function parseConversationStatus(value: string | null): "active" | "archived" | undefined {
  if (value === null || value === "") return undefined;
  if (value === "active" || value === "archived") return value;
  throw new ConversationHttpError(400, "invalid_status", "status must be active or archived.");
}

function parsePositiveInteger(value: string | null, field: string, max: number): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must be a non-negative integer.`);
  }
  return parsed;
}

async function readBoundedBytes(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > maxBytes) throw new ConversationHttpError(413, "request_too_large", `A file is limited to ${maxBytes} bytes.`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > 1_048_576) throw new ConversationHttpError(413, "request_too_large", "Conversation request body is limited to 1 MiB.");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConversationHttpError(400, "invalid_json", "Request body must be JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConversationHttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function valueString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new ConversationHttpError(400, "invalid_request", `${field} must be a string.`);
  return value;
}

function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (body[field] === undefined) return undefined;
  const value = valueString(body, field).trim();
  if (value.length === 0 || value.length > maxLength) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must contain 1 to ${maxLength} characters.`);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = optionalString(body, field, maxLength);
  if (!value) throw new ConversationHttpError(400, "invalid_request", `${field} is required.`);
  return value;
}

function positiveIntegerValue(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must be a positive integer.`);
  }
  return value;
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ConversationHttpError(400, "invalid_request", `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`);
  }
}

function writeConversationHttpError(req: http.IncomingMessage, res: http.ServerResponse, error: unknown): void {
  const { status, code, message, internal } = toProblem(error);
  if (internal) log.error("conversation_request_failed", { method: req.method, path: req.url?.split("?")[0], error });
  writeJson(res, status, { error: { code, message } });
}

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
}

function handleHttpRequestFailure(res: http.ServerResponse, error: unknown): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  try {
    if (error instanceof URIError) {
      writeJson(res, 400, {
        error: { code: "invalid_request_path", message: "The request path contains invalid encoding." }
      });
      return;
    }
    writeJson(res, 500, {
      error: { code: "internal_error", message: "The Runtime could not complete this request." }
    });
  } catch {
    res.destroy();
  }
}

function writeHttpAuthorizationFailure(
  res: http.ServerResponse,
  error: unknown,
  forbiddenCode: string
): void {
  const code = error instanceof EntitlementError ? error.code : "";
  if (code === "auth_registry_unavailable"
    || code === "auth_registry_invalid"
    || code === "entitlement_registry_unavailable"
    || code === "authorization_unavailable"
    || code === "authorization_cancelled") {
    writeJson(res, 503, {
      error: {
        code: "authorization_unavailable",
        message: "Hatch could not verify access right now. Try again shortly."
      }
    });
    return;
  }
  if (code === "authentication_required"
    || code === "auth_invalid"
    || code === "entitlement_required"
    || code === "entitlement_not_found"
    || code === "agent_entitlement_mismatch") {
    writeJson(res, 403, {
      error: { code: forbiddenCode, message: "This Expert Agent is not available for the signed-in account." }
    });
    return;
  }
  writeJson(res, 500, {
    error: { code: "internal_error", message: "The Runtime could not complete this request." }
  });
}

function createConversationStore(environment: NodeJS.ProcessEnv = process.env): RuntimeStore {
  const databaseUrl = environment.HATCH_RUNTIME_DATABASE_URL;
  return databaseUrl
    ? new PostgresStore({ connectionString: databaseUrl, environment })
    : new RuntimeStore(environment.HATCH_RUNTIME_DATA_DIR ?? path.resolve(".hatch-runtime"));
}

function createConversationRepository(store: RuntimeStore): ConversationRepository {
  if (store instanceof PostgresStore) {
    // Share the existing pool so the transcript projection and durable
    // Conversation control-plane use one Runtime database lifecycle.
    return new PostgresConversationRepository({ pool: store.pool });
  }
  if (!store.localAuthority) throw new Error("Local Runtime store requires a submission authority");
  return new InMemoryConversationRepository(store.localAuthority);
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeJsonBounded(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  maxBytes: number
): void {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    writeJson(res, 413, {
      error: {
        code: "response_too_large",
        message: "The requested Runtime response exceeds the bounded response size."
      }
    });
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized, "utf8")
  });
  res.end(serialized);
}

async function buildSessionSkills(corpusRoot?: string): Promise<RuntimeSessionSkills> {
  // Both standalone Runtime Skills and published Agent Corpus Skills use the
  // same metadata-only catalog and the same explicit Skill loader. A Corpus
  // root is an explicit discovery scope, so it cannot accidentally mix in
  // host/global Skills.
  const runtimeSkillsRoot = corpusRoot && await stat(path.join(corpusRoot, "runtime", "skills")).then(() => true, () => false)
    ? path.join(corpusRoot, "runtime", "skills")
    : corpusRoot
      ? path.join(corpusRoot, "skills")
      : undefined;
  const records = runtimeSkillsRoot
    ? await discoverSkills({
      roots: [{ path: runtimeSkillsRoot, scope: "custom", followSymlinks: false }]
    })
    : await discoverSkills();
  const visibleRecords = visibleSkillsForSession(records);
  const rendered = await includeSkillInstructions()
    ? renderSkillsSection(visibleRecords, { executionMode: "protected" })
    : emptyRenderedSkills();
  return {
    records,
    visibleRecords,
    rendered
  };
}

async function bindingFromHistoryRequest(
  req: http.IncomingMessage,
  url: URL,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal
): Promise<SessionBinding | undefined> {
  const entitlementId = url.searchParams.get("entitlement_id") ?? undefined;
  const authToken = bearerToken(req);
  const authIdentity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  // Owner REST requests use the same owned-Product authorization as client.hello.
  const selectedProduct = url.searchParams.get("product_id");
  const productMode = Boolean(entitlementResolver || agentCorpusResolver);
  if (entitlementResolver === unconfiguredEntitlementResolver) throw runtimeNotConfiguredError();
  if (productMode && selectedProduct && !entitlementId) {
    return resolveSessionBinding({
      auth_token: authToken,
      product_id: selectedProduct
    }, entitlementResolver, agentCorpusResolver, authIdentityResolver,
    authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth), signal);
  }
  if (productMode) {
    if (!entitlementResolver || !agentCorpusResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Expert Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!entitlementId || !authToken) {
      throw new EntitlementError("entitlement_required", "A Bearer token and Expert Agent entitlement are required.");
    }
    if (authIdentityResolver && !authIdentity) {
      throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
    }
    // HTTP and WebSocket use the same account/access/Product binding. A
    // purchase record authorizes access; it does not select Agent instructions.
    return resolveSessionBinding({
      auth_token: authToken,
      entitlement_id: entitlementId
    }, entitlementResolver, agentCorpusResolver, authIdentityResolver,
    authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth), signal);
  }

  // Self-reported scope is accepted only when no product resolver is configured.
  // This keeps resolver-free local development usable without creating a
  // production authorization bypass.
  const value = (name: string): string | undefined => url.searchParams.get(name) ?? (typeof req.headers[`x-hatch-${name.replaceAll("_", "-")}`] === "string" ? String(req.headers[`x-hatch-${name.replaceAll("_", "-")}`]) : undefined);
  const [creatorId, userId, productId, corpusDigestValue] = [value("creator_id"), value("user_id"), value("product_id"), value("corpus_digest")];
  if (!creatorId || !userId || !productId || !corpusDigestValue || !/^sha256:[a-f0-9]{64}$/.test(corpusDigestValue)) return undefined;
  return { creatorId, userId, productId, corpusDigest: corpusDigestValue, explicit: true };
}

/** An API key or session token from Authorization; a browser may use its session cookie instead. */
function bearerToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return sessionTokenFromCookie(req.headers.cookie);
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}


async function reconcileDeliveryAccountingOutbox(
  outbox: DeliveryAccountingOutbox,
  sink: CommerceEventSink
): Promise<void> {
  await outbox.reconcile(async (command) => {
    await recordPreparedDelivery(
      sink,
      command.binding,
      command.conversationId,
      command.runId,
      deliveryReceiptFromMetadata(
        command.binding,
        command.conversationId,
        command.runId,
        command.artifact
      ),
      command.reservation
    );
  });
}

function emptyRenderedSkills(): ReturnType<typeof renderSkillsSection> {
  return {
    section: "",
    aliases: {},
    report: {
      total_count: 0,
      included_count: 0,
      omitted_count: 0,
      truncated_description_chars: 0,
      truncated_description_count: 0
    }
  };
}


if (import.meta.url === `file://${process.argv[1]}`) {
  startObservability("runtime");
  const port = Number(process.env.PORT ?? 8400);
  const host = process.env.HATCH_RUNTIME_HOST?.trim() || "127.0.0.1";
  void createRuntimeServerFromEnvironment().then((runtimeServer) => {
    exitOnSignal(() => runtimeServer.shutdown(drainMsFromEnvironment(process.env)));
    runtimeServer.server.listen(port, host, () => {
      const commerce = process.env.HATCH_COMMERCE_LEDGER_FILE ? " with commerce ledger" : "";
      console.log(`Hatch TS runtime listening on ws://${host}:${port}/runtime${commerce}`);
    });
  }).catch((error: unknown) => {
    log.error("runtime_startup_failed", { error });
    process.exitCode = 1;
  });
}
