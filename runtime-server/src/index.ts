import "dotenv/config";

import http from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createAgentRuntime, type AgentRuntime, type RuntimeSessionSkills } from "./agentRuntime.js";
import { MAX_RICH_TOOL_RESULT_BYTES } from "./protocol.js";
import { failures } from "./errors/failures.js";
import { PostgresFailureLedger } from "./errors/postgresFailureLedger.js";
import { ServerToolExecutor } from "./serverTools.js";
import { RuntimeStore } from "./store.js";
import { PostgresStore } from "./postgresStore.js";
import {
  InMemoryConversationRepository,
  PostgresConversationRepository,
  type ConversationRepository
} from "./conversationRepository.js";
import { ToolBridge } from "./toolBridge.js";
import {
  FileEntitlementResolver,
  RegistryEntitlementResolver,
  registryAuthorizationTimeoutMs,
  type AuthIdentityResolver,
  type EntitlementResolver
} from "./entitlements.js";
import { deliveryReceiptFromMetadata, recordPreparedDelivery, type CommerceEventSink } from "./delivery.js";
import { HttpCommerceEventSink } from "./commerceHttpSink.js";
import { DeliveryAccountingOutbox } from "./deliveryOutbox.js";
import { creatorToolControlPlaneFromEnvironment, resolveCreatorTools, type CreatorToolControlPlane } from "./creatorTools.js";
import { AgentCorpusResolver as FilesystemAgentCorpusResolver, type AgentCorpusResolverLike } from "./agentCorpus.js";
import { RuntimeReleaseAgentCorpusResolver } from "./runtimeCorpusResolver.js";
import {
  discoverSkills,
  includeSkillInstructions,
  renderSkillsSection,
  visibleSkillsForSession
} from "./skills.js";
import { type BriefSpec } from "./brief.js";
import { createOutputGuardFromEnvironment, PassThroughOutputGuard, type OutputGuard } from "./outputGuard.js";
import { writeOperationalError } from "./operationalLogging.js";
import { RuntimeAssetStore, runtimeAssetStoreFromEnvironment } from "./assetStore.js";
import { flushLangfuseObservability, initializeLangfuseObservability } from "./langfuse.js";
import { ChatRuntime, type ChatRuntimeOptions } from "./chat/chatRuntime.js";
import { PostgresEventRelay } from "./chat/eventRelay.js";
import { PostgresStopRelay } from "./chat/stopRelay.js";
import { ChatError, principalKey } from "./chat/principal.js";
import type { PrincipalLimits, RunAdmission } from "./chat/chatService.js";
import { ContactBinder, SentMessageLimits, type ConnectionDirectory } from "./chat/contactBinding.js";
import { SelfBinder } from "./chat/selfBinding.js";
import type { ChatGateway } from "./chat/gateway.js";
import { checkUpgrade } from "./chat/originPolicy.js";
import { ServiceChatGateway } from "./chat/serviceGateway.js";
import { ChatServiceApi } from "./chat/serviceApi.js";
import { ChatAssets, TextPartsReader, type PartsReader } from "./chat/assets.js";
import { attachmentToolDefinitions } from "./chat/attachmentTools.js";
import { failRun, runModelTurn } from "./chat/modelTurn.js";
import { toolRegistry } from "./tools.js";
import { RegistryConnectionDirectory } from "./chat/registryConnections.js";
import { openChatAssets } from "./chat/openChatAssets.js";
import { objectStoreFromEnvironment } from "./creatorLearning/objectStore.js";
import { MAX_CONSUMER_BUFFERED_BYTES } from "./chat/sinks.js";
import { productRequiresLocalTools } from "./chat/toolSurface.js";
import type { ScopeResolver, TurnRunner } from "./chat/turnExecutor.js";
import { observed } from "./observability/http.js";
import { InflightResponses, drainMsFromEnvironment, exitOnSignal, gracefulShutdown } from "./gracefulShutdown.js";
import { log } from "./observability/log.js";
import { startObservability } from "./observability/start.js";
import {
  CapacityGate, KeyedCapacityGate, combineCapacityReleases, once, readRuntimeConfig,
  DEFAULT_MAX_CONTACT_MESSAGES, clientToolTimeoutMs
} from "./runtimeConfig.js";
import {
  unconfiguredAgentCorpusResolver,
  unconfiguredEntitlementResolver,
  type LegacyHmacAuth,
  type SessionBinding
} from "./chat/sessionBinding.js";
import type { ChatEdge } from "./chat/turnSubmission.js";
import { bearerToken, handleHttpRequestFailure, httpDeadlineMs, writeJson } from "./http/httpSupport.js";
import { handleHttpRequest, type RuntimeReadiness } from "./http/runtimeRouter.js";
import { handleRuntimeSocket } from "./ws/runtimeSocket.js";

// The Runtime's public surface stays here: callers import these from index.js.
export { clientToolTimeoutMs, legacyHmacAuthEnabled, runtimeClientHelloTimeoutMs } from "./runtimeConfig.js";
export {
  durableConversationId, privateBoundaryProjection, protectPrivateAgentBoundary, scopedConversationId
} from "./chat/sessionBinding.js";

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
    const requestTask = handleHttpRequest(req, res, {
      entitlementResolver,
      agentCorpusResolver,
      conversationStore,
      assetStore,
      authIdentityResolver,
      legacyHmacAuth,
      maxHttpResponseBytes,
      conversationRepository,
      repositoryReady,
      edge,
      readiness,
      allowedOrigins
    }, requestAbortController.signal);
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
