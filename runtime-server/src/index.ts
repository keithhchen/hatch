import "dotenv/config";

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import { ClientToolBroker } from "./clientBroker.js";
import {
  compactRuntimeMessages,
  shouldAutoCompactMessages,
  type CompactionCheckpoint,
  type RuntimeCompactionMessage
} from "./compaction.js";
import { createAgentRuntime, type AgentRuntime, type RuntimeSessionSkills } from "./agentRuntime.js";
import { parseInboundMessage, PROTOCOL_VERSION, type ClientHello, type OutboundMessage, type OutputFinishReason, type RunStart } from "./protocol.js";
import { RunStateMachine } from "./runState.js";
import { ServerToolExecutor } from "./serverTools.js";
import { SkillRuntime } from "./skillRuntime.js";
import { RuntimeStore } from "./store.js";
import { PostgresStore } from "./postgresStore.js";
import {
  assertConversationBinding,
  ConversationRepositoryError,
  FileConversationRepository,
  PostgresConversationRepository,
  type ConversationBinding,
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
  type EntitlementResolver
} from "./entitlements.js";
import { findCompletedDelivery, recordCompletedDelivery, type CommerceEventSink, type DeliveryArtifact, type DeliveryBinding } from "./delivery.js";
import { AgentCorpusChangedError, materializeAgentCorpus } from "./agentCorpusMaterialization.js";
import { creatorToolControlPlaneFromEnvironment, resolveCreatorTools, type CreatorToolControlPlane } from "./creatorTools.js";
import { AgentCorpusResolver, createKnowledgeProvider, knowledgeProviderConfigured, type AgentCorpus } from "./agentCorpus.js";
import {
  discoverSkills,
  includeSkillInstructions,
  renderSkillsSection,
  visibleSkillsForSession
} from "./skills.js";
import { verifyHatchAuthToken } from "./authToken.js";
import {
  authRequestSourceIp,
  authTrustedProxyPolicyFromEnvironment,
  type TrustedProxyPolicy
} from "./authRateLimit.js";
import {
  createOutputGuardFromEnvironment,
  GuardedAssistantOutput,
  OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE,
  PassThroughOutputGuard,
  type GuardedOutputResult,
  type OutputGuard
} from "./outputGuard.js";

export type RuntimeServer = {
  server: http.Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
};

// A successful local tool result may occupy up to 4 MiB. Reserve bounded JSON
// envelope overhead while keeping one hard transport cap for every frame.
export const MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES = 5 * 1024 * 1024;

export type RuntimeServerOptions = {
  createRuntime?: () => AgentRuntime;
  conversationStore?: RuntimeStore;
  /** Durable Conversation/Run control-plane. Defaults to Postgres or local app-data. */
  conversationRepository?: ConversationRepository;
  entitlementResolver?: EntitlementResolver;
  /** Production identity verifier owned by the Registry. */
  authIdentityResolver?: AuthIdentityResolver;
  /** Registry-installed current Agent Corpus root, keyed by creator/agent. */
  agentCorpusResolver?: AgentCorpusResolver;
  outputGuard?: OutputGuard;
  commerceEventSink?: CommerceEventSink;
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
  /** Global cap on concurrent hello identity/entitlement verification. */
  maxPendingHelloAuthorizations?: number;
  /** Per-user cap after identity introspection and before Corpus resolution. */
  maxPendingHelloAuthorizationsPerUser?: number;
  /** Global cap on concurrent per-turn Registry authorization checks. */
  maxPendingTurnAuthorizations?: number;
  /** Per-user cap on concurrent per-turn Registry authorization checks. */
  maxPendingTurnAuthorizationsPerUser?: number;
  /** Pending and active runs admitted from one WebSocket connection. */
  maxActiveRunsPerConnection?: number;
  /** Pending and active runs admitted for one authenticated user. */
  maxActiveRunsPerUser?: number;
  /** Pending and active runs admitted across the Runtime process. */
  maxActiveRunsGlobal?: number;
  /** Authenticated, ready WebSocket connections across the Runtime process. */
  maxEstablishedConnectionsGlobal?: number;
  /** Authenticated, ready WebSocket connections for one user. */
  maxEstablishedConnectionsPerUser?: number;
  /** Ping interval used to reap connections that no longer answer. */
  connectionHeartbeatMs?: number;
  /** Maximum time a ready connection may receive no client messages. */
  connectionIdleTimeoutMs?: number;
  /** All accepted WebSockets, including clients that have not sent hello. */
  maxOpenConnectionsGlobal?: number;
  /** Accepted WebSockets from one trusted source address, including pre-hello clients. */
  maxOpenConnectionsPerSource?: number;
  /** Hard cap for a socket's queued outbound bytes. */
  maxSocketBufferedBytes?: number;
  /** Hard deadline for Runtime-owned network tools. */
  serverToolTimeoutMs?: number;
  /** TCP connections accepted by the shared HTTP/WebSocket server. */
  maxHttpConnections?: number;
  /** In-flight HTTP handlers across the Runtime process. */
  maxHttpRequestsGlobal?: number;
  /** In-flight HTTP handlers from one remote address. */
  maxHttpRequestsPerSource?: number;
  /** Deadline for receiving HTTP headers. */
  httpHeadersTimeoutMs?: number;
  /** End-to-end deadline for a Runtime HTTP handler. */
  httpRequestTimeoutMs?: number;
  /** Maximum serialized JSON response size for discovery and history. */
  maxHttpResponseBytes?: number;
  /** Explicit reverse proxies allowed to supply X-Forwarded-For. */
  trustedProxyPolicy?: TrustedProxyPolicy;
};

type LegacyHmacAuth = {
  enabled: boolean;
  signingSecret?: string;
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
  const ledgerFile = environment.HATCH_COMMERCE_LEDGER_FILE?.trim();
  if (!ledgerFile) return undefined;

  const commerce = await import(new URL("../../packages/commerce/src/index.js", import.meta.url).href) as {
    CommerceLedger: { open(options: { filePath: string }): Promise<{
      findByIdempotencyKey(key: string): unknown;
    }> };
    LedgerCommerceSink: new (ledger: unknown) => {
      ingest(type: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown>;
    };
  };
  const ledger = await commerce.CommerceLedger.open({ filePath: ledgerFile });
  const recognizedSink = new commerce.LedgerCommerceSink(ledger);
  return {
    append: (type, payload, options) => recognizedSink.ingest(type, payload, options),
    findByIdempotencyKey: (key) => ledger.findByIdempotencyKey(key)
  };
}

export async function createRuntimeServerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Promise<RuntimeServer> {
  const registryUrl = environment.HATCH_REGISTRY_URL?.trim();
  const agentCorpusRoot = environment.HATCH_AGENT_CORPUS_ROOT?.trim();
  const runtimeDatabaseUrl = environment.HATCH_RUNTIME_DATABASE_URL?.trim();
  const runtimeHost = environment.HATCH_RUNTIME_HOST?.trim() || "127.0.0.1";
  const helloTimeoutMs = runtimeClientHelloTimeoutMs(environment.HATCH_RUNTIME_HELLO_TIMEOUT_MS);
  const maxPendingHelloAuthorizations = runtimeMaxPendingHelloAuthorizations(
    environment.HATCH_RUNTIME_MAX_PENDING_HELLO_AUTHORIZATIONS
  );
  const maxPendingHelloAuthorizationsPerUser = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_PENDING_HELLO_AUTHORIZATIONS_PER_USER",
    environment.HATCH_RUNTIME_MAX_PENDING_HELLO_AUTHORIZATIONS_PER_USER,
    2
  );
  const maxPendingTurnAuthorizations = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS",
    environment.HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS,
    16
  );
  const maxPendingTurnAuthorizationsPerUser = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS_PER_USER",
    environment.HATCH_RUNTIME_MAX_PENDING_TURN_AUTHORIZATIONS_PER_USER,
    4
  );
  const maxActiveRunsPerConnection = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_CONNECTION",
    environment.HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_CONNECTION,
    1
  );
  const maxActiveRunsGlobal = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ACTIVE_RUNS_GLOBAL",
    environment.HATCH_RUNTIME_MAX_ACTIVE_RUNS_GLOBAL,
    16,
    10_000
  );
  const maxActiveRunsPerUser = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_USER",
    environment.HATCH_RUNTIME_MAX_ACTIVE_RUNS_PER_USER,
    2,
    10_000
  );
  const maxEstablishedConnectionsGlobal = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ESTABLISHED_CONNECTIONS_GLOBAL",
    environment.HATCH_RUNTIME_MAX_ESTABLISHED_CONNECTIONS_GLOBAL,
    256,
    100_000
  );
  const maxOpenConnectionsGlobal = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_OPEN_CONNECTIONS_GLOBAL",
    environment.HATCH_RUNTIME_MAX_OPEN_CONNECTIONS_GLOBAL,
    512,
    100_000
  );
  const maxOpenConnectionsPerSource = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_OPEN_CONNECTIONS_PER_SOURCE",
    environment.HATCH_RUNTIME_MAX_OPEN_CONNECTIONS_PER_SOURCE,
    16,
    10_000
  );
  const maxSocketBufferedBytes = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_SOCKET_BUFFERED_BYTES",
    environment.HATCH_RUNTIME_MAX_SOCKET_BUFFERED_BYTES,
    8 * 1024 * 1024,
    64 * 1024 * 1024
  );
  const maxEstablishedConnectionsPerUser = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_ESTABLISHED_CONNECTIONS_PER_USER",
    environment.HATCH_RUNTIME_MAX_ESTABLISHED_CONNECTIONS_PER_USER,
    8,
    10_000
  );
  const connectionHeartbeatMs = runtimeDurationMs(
    "HATCH_RUNTIME_CONNECTION_HEARTBEAT_MS",
    environment.HATCH_RUNTIME_CONNECTION_HEARTBEAT_MS,
    30_000,
    1_000,
    300_000
  );
  const connectionIdleTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_CONNECTION_IDLE_TIMEOUT_MS",
    environment.HATCH_RUNTIME_CONNECTION_IDLE_TIMEOUT_MS,
    1_800_000,
    60_000,
    86_400_000
  );
  const serverToolTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_SERVER_TOOL_TIMEOUT_MS",
    environment.HATCH_RUNTIME_SERVER_TOOL_TIMEOUT_MS,
    120_000,
    1_000,
    300_000
  );
  const maxHttpConnections = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_HTTP_CONNECTIONS",
    environment.HATCH_RUNTIME_MAX_HTTP_CONNECTIONS,
    768,
    100_000
  );
  const maxHttpRequestsGlobal = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_HTTP_REQUESTS_GLOBAL",
    environment.HATCH_RUNTIME_MAX_HTTP_REQUESTS_GLOBAL,
    64,
    10_000
  );
  const maxHttpRequestsPerSource = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_HTTP_REQUESTS_PER_SOURCE",
    environment.HATCH_RUNTIME_MAX_HTTP_REQUESTS_PER_SOURCE,
    8,
    1_024
  );
  const httpHeadersTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_HTTP_HEADERS_TIMEOUT_MS",
    environment.HATCH_RUNTIME_HTTP_HEADERS_TIMEOUT_MS,
    5_000,
    1_000,
    60_000
  );
  const httpRequestTimeoutMs = runtimeDurationMs(
    "HATCH_RUNTIME_HTTP_REQUEST_TIMEOUT_MS",
    environment.HATCH_RUNTIME_HTTP_REQUEST_TIMEOUT_MS,
    10_000,
    1_000,
    120_000
  );
  const maxHttpResponseBytes = runtimeCapacityLimit(
    "HATCH_RUNTIME_MAX_HTTP_RESPONSE_BYTES",
    environment.HATCH_RUNTIME_MAX_HTTP_RESPONSE_BYTES,
    8 * 1024 * 1024,
    64 * 1024 * 1024
  );
  const insecureLocalMode = explicitBooleanEnvironmentFlag(
    "HATCH_ALLOW_INSECURE_LOCAL_MODE",
    environment.HATCH_ALLOW_INSECURE_LOCAL_MODE
  );
  if (registryUrl) {
    const parsedRegistryUrl = new URL(registryUrl);
    if (parsedRegistryUrl.protocol !== "http:" && parsedRegistryUrl.protocol !== "https:") {
      throw new Error("HATCH_REGISTRY_URL must use http or https");
    }
  }
  if (!isLoopbackRuntimeHost(runtimeHost)
    && !insecureLocalMode
    && (!registryUrl || !agentCorpusRoot || !runtimeDatabaseUrl)) {
    throw new Error(
      "A non-loopback Runtime requires HATCH_REGISTRY_URL, HATCH_AGENT_CORPUS_ROOT, and HATCH_RUNTIME_DATABASE_URL; "
      + "set HATCH_ALLOW_INSECURE_LOCAL_MODE=true only for an intentional local fixture"
    );
  }
  const legacyHmacEnabled = legacyHmacAuthEnabled(environment.HATCH_ENABLE_LEGACY_HMAC_AUTH);
  const legacyHmacSecret = environment.HATCH_AUTH_SIGNING_SECRET?.trim() || undefined;
  if (legacyHmacEnabled && !legacyHmacSecret) {
    throw new Error("HATCH_AUTH_SIGNING_SECRET is required when legacy HMAC auth is enabled");
  }
  const registryAuth = registryUrl
    ? new RegistryEntitlementResolver(
      registryUrl,
      fetch,
      {
        timeoutMs: registryAuthorizationTimeoutMs(environment),
        serviceToken: environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN,
      }
    )
    : undefined;
  const entitlementFile = environment.HATCH_ENTITLEMENTS_FILE?.trim();
  const fileEntitlements = legacyHmacEnabled && entitlementFile
    ? new FileEntitlementResolver(entitlementFile, {
      enableLegacyHmacAuth: true,
      hmacSecret: legacyHmacSecret!
    })
    : undefined;
  return createRuntimeServer({
    outputGuard: createOutputGuardFromEnvironment(environment),
    commerceEventSink: await commerceEventSinkFromEnvironment(environment),
    creatorToolControlPlane: creatorToolControlPlaneFromEnvironment(environment),
    entitlementResolver: registryAuth ?? fileEntitlements,
    authIdentityResolver: registryAuth,
    agentCorpusResolver: agentCorpusRoot
      ? new AgentCorpusResolver(agentCorpusRoot)
      : undefined,
    conversationStore: createConversationStore(environment),
    clientToolTimeoutMs: clientToolTimeoutMs(environment.HATCH_CLIENT_TOOL_TIMEOUT_MS),
    clientHelloTimeoutMs: helloTimeoutMs,
    maxPendingHelloAuthorizations,
    maxPendingHelloAuthorizationsPerUser,
    maxPendingTurnAuthorizations,
    maxPendingTurnAuthorizationsPerUser,
    maxActiveRunsPerConnection,
    maxActiveRunsPerUser,
    maxActiveRunsGlobal,
    maxEstablishedConnectionsGlobal,
    maxEstablishedConnectionsPerUser,
    maxOpenConnectionsGlobal,
    maxOpenConnectionsPerSource,
    maxSocketBufferedBytes,
    connectionHeartbeatMs,
    connectionIdleTimeoutMs,
    serverToolTimeoutMs,
    maxHttpConnections,
    maxHttpRequestsGlobal,
    maxHttpRequestsPerSource,
    httpHeadersTimeoutMs,
    httpRequestTimeoutMs,
    maxHttpResponseBytes,
    trustedProxyPolicy: authTrustedProxyPolicyFromEnvironment(environment),
    enableLegacyHmacAuth: legacyHmacEnabled,
    legacyHmacSecret
  });
}

export function legacyHmacAuthEnabled(raw: string | undefined): boolean {
  return explicitBooleanEnvironmentFlag("HATCH_ENABLE_LEGACY_HMAC_AUTH", raw);
}

function explicitBooleanEnvironmentFlag(name: string, raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be exactly true or false`);
}

function isLoopbackRuntimeHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function clientToolTimeoutMs(raw = process.env.HATCH_CLIENT_TOOL_TIMEOUT_MS): number {
  // The Desktop keeps a pending write visible while the buyer reviews it.
  // Two minutes is shorter than a normal interruption, while an unbounded
  // pending call would retain a dead browser connection forever.
  if (raw === undefined || raw === "") return 300_000;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 30_000 || parsed > 1_800_000) {
    throw new Error("HATCH_CLIENT_TOOL_TIMEOUT_MS must be an integer between 30000 and 1800000");
  }
  return parsed;
}

export function runtimeClientHelloTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 10_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 60_000) {
    throw new Error("HATCH_RUNTIME_HELLO_TIMEOUT_MS must be an integer between 1000 and 60000");
  }
  return parsed;
}

export function runtimeMaxPendingHelloAuthorizations(raw: string | undefined): number {
  return runtimeCapacityLimit("HATCH_RUNTIME_MAX_PENDING_HELLO_AUTHORIZATIONS", raw, 8);
}

function runtimeCapacityLimit(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  maximum = 1_024
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

function runtimeDurationMs(
  name: string,
  raw: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number
): number {
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

type SessionBinding = {
  creatorId: string;
  userId: string;
  agentId: string;
  productId: string;
  corpusDigest: string;
  agentCorpus?: AgentCorpus;
  agentCorpusRoot?: string;
  entitlementId?: string;
  orderId?: string;
  explicit: boolean;
};

type PendingTurnAuthorization = {
  runId: string;
  conversationId: string;
  controller: AbortController;
  cancelled: boolean;
  detachConnectionAbort: () => void;
  releaseAuthorizationCapacity: () => void;
  releaseActiveRunCapacity: () => void;
};

class CapacityGate {
  private pending = 0;

  constructor(private readonly capacity: number, optionName: string) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error(`${optionName} must be a positive safe integer`);
    }
  }

  tryAcquire(): (() => void) | undefined {
    if (this.pending >= this.capacity) return undefined;
    this.pending += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pending -= 1;
    };
  }
}

class KeyedCapacityGate {
  private readonly pending = new Map<string, number>();

  constructor(private readonly capacityPerKey: number, optionName: string) {
    if (!Number.isSafeInteger(capacityPerKey) || capacityPerKey < 1) {
      throw new Error(`${optionName} must be a positive safe integer`);
    }
  }

  tryAcquire(key: string): (() => void) | undefined {
    const current = this.pending.get(key) ?? 0;
    if (current >= this.capacityPerKey) return undefined;
    this.pending.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.pending.get(key) ?? 1) - 1;
      if (next <= 0) this.pending.delete(key);
      else this.pending.set(key, next);
    };
  }
}

function combineCapacityReleases(...releases: Array<() => void>): () => void {
  return () => {
    for (const release of releases) release();
  };
}

type ActiveRunControl = {
  cancel: (reason: string) => Promise<void>;
};
export function createRuntimeServer(options: RuntimeServerOptions = {}): RuntimeServer {
  const activeConversationRuns = new Map<string, string>();
  const activeRunControls = new Map<string, ActiveRunControl>();
  const connectionTasks = new Set<Promise<void>>();
  const createRuntime = options.createRuntime ?? createAgentRuntime;
  const entitlementResolver = options.entitlementResolver;
  const authIdentityResolver = options.authIdentityResolver
    ?? (entitlementResolver instanceof RegistryEntitlementResolver ? entitlementResolver : undefined);
  const agentCorpusResolver = options.agentCorpusResolver;
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
  const helloAuthorizationGate = new CapacityGate(
    options.maxPendingHelloAuthorizations ?? 8,
    "maxPendingHelloAuthorizations"
  );
  const helloAuthorizationPerUserGate = new KeyedCapacityGate(
    options.maxPendingHelloAuthorizationsPerUser ?? 2,
    "maxPendingHelloAuthorizationsPerUser"
  );
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
  const establishedConnectionGate = new CapacityGate(
    options.maxEstablishedConnectionsGlobal ?? 256,
    "maxEstablishedConnectionsGlobal"
  );
  const openConnectionGate = new CapacityGate(
    options.maxOpenConnectionsGlobal ?? 512,
    "maxOpenConnectionsGlobal"
  );
  const openConnectionPerSourceGate = new KeyedCapacityGate(
    options.maxOpenConnectionsPerSource ?? 16,
    "maxOpenConnectionsPerSource"
  );
  const establishedConnectionPerUserGate = new KeyedCapacityGate(
    options.maxEstablishedConnectionsPerUser ?? 8,
    "maxEstablishedConnectionsPerUser"
  );
  const connectionHeartbeatMs = options.connectionHeartbeatMs ?? 30_000;
  if (!Number.isSafeInteger(connectionHeartbeatMs) || connectionHeartbeatMs < 1) {
    throw new Error("connectionHeartbeatMs must be a positive safe integer");
  }
  const connectionIdleTimeoutMs = options.connectionIdleTimeoutMs ?? 1_800_000;
  if (!Number.isSafeInteger(connectionIdleTimeoutMs) || connectionIdleTimeoutMs < 1) {
    throw new Error("connectionIdleTimeoutMs must be a positive safe integer");
  }
  const maxActiveRunsPerConnection = options.maxActiveRunsPerConnection ?? 1;
  if (!Number.isSafeInteger(maxActiveRunsPerConnection) || maxActiveRunsPerConnection < 1) {
    throw new Error("maxActiveRunsPerConnection must be a positive safe integer");
  }
  const conversationStore = options.conversationStore ?? createConversationStore();
  const conversationRepository = options.conversationRepository ?? createConversationRepository(conversationStore);
  // A restart never silently resumes a tool-effecting run. The durable status
  // becomes Interrupted before a new socket can create a replacement run.
  const repositoryReady = conversationRepository.initialize()
    .then(() => conversationRepository.interruptActiveRuns("Runtime restarted before the executor lease was reclaimed."));
  const outputGuard = options.outputGuard ?? new PassThroughOutputGuard();
  const httpRequestGate = new CapacityGate(
    options.maxHttpRequestsGlobal ?? 64,
    "maxHttpRequestsGlobal"
  );
  const httpRequestPerSourceGate = new KeyedCapacityGate(
    options.maxHttpRequestsPerSource ?? 8,
    "maxHttpRequestsPerSource"
  );
  const httpRequestTimeoutMs = options.httpRequestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(httpRequestTimeoutMs) || httpRequestTimeoutMs < 1) {
    throw new Error("httpRequestTimeoutMs must be a positive safe integer");
  }
  const maxHttpConnections = options.maxHttpConnections ?? 768;
  if (!Number.isSafeInteger(maxHttpConnections) || maxHttpConnections < 1) {
    throw new Error("maxHttpConnections must be a positive safe integer");
  }
  const httpHeadersTimeoutMs = options.httpHeadersTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(httpHeadersTimeoutMs) || httpHeadersTimeoutMs < 1) {
    throw new Error("httpHeadersTimeoutMs must be a positive safe integer");
  }
  const maxSocketBufferedBytes = options.maxSocketBufferedBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxSocketBufferedBytes) || maxSocketBufferedBytes < MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES) {
    throw new Error(`maxSocketBufferedBytes must be an integer of at least ${MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES}`);
  }
  const maxHttpResponseBytes = options.maxHttpResponseBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxHttpResponseBytes) || maxHttpResponseBytes < 1_024) {
    throw new Error("maxHttpResponseBytes must be an integer of at least 1024");
  }
  const server = http.createServer((req, res) => {
    const releaseGlobalRequest = httpRequestGate.tryAcquire();
    if (!releaseGlobalRequest) {
      writeJson(res, 503, {
        error: { code: "http_busy", message: "The Runtime is already handling the maximum number of requests." }
      });
      return;
    }
    const source = authRequestSourceIp(req, options.trustedProxyPolicy);
    const releaseSourceRequest = httpRequestPerSourceGate.tryAcquire(source);
    if (!releaseSourceRequest) {
      releaseGlobalRequest();
      writeJson(res, 429, {
        error: { code: "source_busy", message: "Too many requests are already in progress from this client." }
      });
      return;
    }
    const releaseRequest = combineCapacityReleases(releaseGlobalRequest, releaseSourceRequest);
    const requestAbortController = new AbortController();
    const abortDisconnectedRequest = () => {
      requestAbortController.abort(new Error("Runtime HTTP client disconnected"));
    };
    req.once("aborted", abortDisconnectedRequest);
    res.once("close", () => {
      if (!res.writableEnded) abortDisconnectedRequest();
    });
    const requestDeadline = setTimeout(() => {
      requestAbortController.abort(new Error("Runtime HTTP request deadline exceeded"));
      if (!res.headersSent && !res.writableEnded) {
        writeJson(res, 504, {
          error: { code: "request_timeout", message: "The Runtime request timed out." }
        });
      } else if (!res.writableEnded) {
        res.destroy();
      }
    }, httpRequestTimeoutMs);
    requestDeadline.unref();
    const requestTask = handleHttpRequest(
      req,
      res,
      entitlementResolver,
      agentCorpusResolver,
      conversationStore,
      authIdentityResolver,
      legacyHmacAuth,
      requestAbortController.signal,
      maxHttpResponseBytes,
      conversationRepository,
      repositoryReady,
      activeRunControls
    );
    void requestTask.catch((error) => {
      if (!res.destroyed && !res.writableEnded) handleHttpRequestFailure(res, error);
    }).finally(() => {
      clearTimeout(requestDeadline);
      req.off("aborted", abortDisconnectedRequest);
      releaseRequest();
    });
  });
  server.maxConnections = maxHttpConnections;
  server.headersTimeout = httpHeadersTimeoutMs;
  server.requestTimeout = httpRequestTimeoutMs;

  const wss = new WebSocketServer({
    server,
    path: "/runtime",
    maxPayload: MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES
  });
  wss.on("connection", (socket, request) => {
    // `ws` emits an error before close for malformed/oversized frames. Owning
    // the event prevents a process-level uncaught exception; close performs
    // the same reservation and broker cleanup as any other disconnect.
    socket.on("error", () => undefined);
    const releaseOpenConnection = openConnectionGate.tryAcquire();
    if (!releaseOpenConnection) {
      socket.terminate();
      return;
    }
    const source = authRequestSourceIp(request, options.trustedProxyPolicy);
    const releaseSourceOpenConnection = openConnectionPerSourceGate.tryAcquire(source);
    if (!releaseSourceOpenConnection) {
      releaseOpenConnection();
      socket.terminate();
      return;
    }
    socket.once("close", combineCapacityReleases(releaseOpenConnection, releaseSourceOpenConnection));
    const task = handleRuntimeSocket(
      socket,
      activeConversationRuns,
      helloAuthorizationGate,
      helloAuthorizationPerUserGate,
      turnAuthorizationGate,
      turnAuthorizationPerUserGate,
      activeRunGate,
      activeRunPerUserGate,
      establishedConnectionGate,
      establishedConnectionPerUserGate,
      maxActiveRunsPerConnection,
      helloTimeoutMs,
      connectionHeartbeatMs,
      connectionIdleTimeoutMs,
      activeRunControls,
      conversationStore,
      conversationRepository,
      repositoryReady,
      createRuntime,
      entitlementResolver,
      agentCorpusResolver,
      authIdentityResolver,
      legacyHmacAuth,
      options.creatorToolControlPlane,
      outputGuard,
      options.commerceEventSink,
      options.clientToolTimeoutMs ?? clientToolTimeoutMs(),
      options.serverToolTimeoutMs ?? 120_000,
      maxSocketBufferedBytes
    );
    connectionTasks.add(task);
    void task.then(
      () => connectionTasks.delete(task),
      () => connectionTasks.delete(task)
    );
  });

  return {
    server,
    wss,
    close: async () => {
      for (const client of wss.clients) {
        client.close();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.allSettled([...connectionTasks]);
      await conversationStore.close();
      await conversationRepository.close();
    }
  };
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  conversationStore?: RuntimeStore,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  signal?: AbortSignal,
  maxHttpResponseBytes = 8 * 1024 * 1024,
  conversationRepository?: ConversationRepository,
  repositoryReady?: Promise<unknown>,
  activeRunControls?: Map<string, ActiveRunControl>
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

  if (req.method === "GET" && url.pathname === "/v1/me/creator-agents") {
    const authToken = bearerToken(req);
    if (!authToken) {
      writeJson(res, 401, { error: { code: "authentication_required", message: "Sign in to view purchased Creator Agents." } });
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
      writeJson(res, 503, { error: { code: "entitlements_unavailable", message: "Creator Agent purchases are temporarily unavailable." } });
      return;
    }
    try {
      let creatorAgents: Array<Record<string, unknown>>;
      if (claims?.role === "creator" && agentCorpusResolver) {
        creatorAgents = (await agentCorpusResolver.list(claims.sub, signal)).map(({ corpus, digest }) => ({
          entitlement_id: `creator:${claims.sub}:${corpus.agent_id}`,
          creator_id: corpus.creator.id,
          agent_id: corpus.agent_id,
          corpus_digest: digest,
          creator: corpus.creator,
          product: {
            id: corpus.product.id,
            name: corpus.product.name,
            description: corpus.product.description ?? "",
            ...(corpus.product.promise ? { promise: corpus.product.promise } : {}),
            ...(corpus.product.boundaries.length ? { boundaries: corpus.product.boundaries } : {}),
            ...(corpus.product.offer ? { offer: corpus.product.offer } : {})
          },
          presentation: corpus.product.presentation
        }));
      } else {
        const entitlements = await entitlementResolver!.list({
          authToken,
          licenseToken: authToken,
          signal
        });
        creatorAgents = [];
        // Resolve Corpus digests sequentially. A buyer can own many grants and
        // each digest walks bounded assets; unbounded Promise.all multiplies
        // transient memory by the full grant count.
        for (const entitlement of entitlements) {
          signal?.throwIfAborted();
          assertEntitlementMatchesIdentity(claims, entitlement);
          if (!agentCorpusResolver) throw new Error("Current Agent Corpus resolver is unavailable");
          const resolved = await agentCorpusResolver.resolve(entitlement.creator_id, entitlement.agent_id, signal);
          if (resolved.corpus.product.id !== entitlement.product_id || resolved.corpus.creator.id !== entitlement.creator_id) {
            throw new Error(`Entitlement ${entitlement.entitlement_id} does not match its current Agent Corpus`);
          }
          creatorAgents.push({
            entitlement_id: entitlement.entitlement_id,
            creator_id: entitlement.creator_id,
            agent_id: entitlement.agent_id,
            corpus_digest: resolved.digest,
            creator: resolved.corpus.creator,
            product: {
              id: resolved.corpus.product.id,
              name: resolved.corpus.product.name,
              description: resolved.corpus.product.description ?? "",
              ...(resolved.corpus.product.promise ? { promise: resolved.corpus.product.promise } : {}),
              ...(resolved.corpus.product.boundaries.length ? { boundaries: resolved.corpus.product.boundaries } : {}),
              ...(resolved.corpus.product.offer ? { offer: resolved.corpus.product.offer } : {})
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
        entitlementResolver,
        agentCorpusResolver,
        authIdentityResolver,
        legacyHmacAuth,
        signal,
        activeRunControls,
        maxHttpResponseBytes
      );
    } catch (error) {
      writeConversationHttpError(res, error);
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
      agent_id: binding.agentId,
      messages: sanitizeBoundHistory(
        messages,
        binding.agentId
      ),
      history_truncated: historyTruncated
    }, maxHttpResponseBytes);
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

class ConversationHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ConversationHttpError";
  }
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
  entitlementResolver: EntitlementResolver | undefined,
  agentCorpusResolver: AgentCorpusResolver | undefined,
  authIdentityResolver: AuthIdentityResolver | undefined,
  legacyHmacAuth: LegacyHmacAuth,
  signal: AbortSignal | undefined,
  activeRunControls: Map<string, ActiveRunControl> | undefined,
  maxHttpResponseBytes: number
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
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {})
      });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["title", "client_request_id"]);
      const title = optionalString(body, "title", 500);
      const clientRequestId = optionalString(body, "client_request_id", 256);
      const publicId = `conv_${randomUUID().replaceAll("-", "")}`;
      const created = await repository.createConversation({
        ...repoBinding,
        id: durableConversationId(binding, publicId),
        publicId,
        ...(title ? { title } : {}),
        ...(clientRequestId ? { clientRequestId } : {})
      });
      writeResponse(created.created ? 201 : 200, { conversation: publicConversation(created.conversation), created: created.created });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET or POST for /v1/conversations.");
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

  const snapshotMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/(snapshot|events)$/);
  if (snapshotMatch && req.method === "GET") {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(snapshotMatch[1] ?? ""));
    const afterCursor = parseNonNegativeInteger(url.searchParams.get("after_cursor"), "after_cursor");
    const snapshot = await repository.snapshot(conversation.id, afterCursor ?? 0);
    const eventResponse = snapshot.events.map(publicJournalEvent);
    if (snapshotMatch[2] === "events") {
      writeResponse(200, { conversation_id: conversation.publicId, events: eventResponse, cursor: snapshot.cursor });
      return;
    }
    const messages = store
      ? sanitizeBoundHistory(await store.readVisibleConversation(conversation.id), binding.agentId)
      : [];
    writeResponse(200, {
      conversation: publicConversation(snapshot.conversation),
      runs: snapshot.runs.map(publicRun),
      messages,
      events: eventResponse,
      cursor: snapshot.cursor
    });
    return;
  }

  const runsMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs$/);
  if (runsMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(runsMatch[1] ?? ""));
    if (req.method === "GET") {
      writeResponse(200, { conversation_id: conversation.publicId, runs: (await repository.listRuns(conversation.id)).map(publicRun) });
      return;
    }
    if (req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["client_message_id"]);
      const clientMessageId = requiredString(body, "client_message_id", 256);
      const created = await repository.createRun({
        id: `run_${randomUUID().replaceAll("-", "")}`,
        conversationId: conversation.id,
        clientMessageId,
        corpusDigest: binding.corpusDigest
      });
      writeResponse(created.created ? 201 : 200, {
        run: publicRun(created.run),
        created: created.created,
        // A WebSocket executor attach/reclaim endpoint is intentionally not
        // implied by this reservation. It must explicitly own the executor
        // lease and never infer permission to replay a pending tool call.
        executor_attached: false
      });
      return;
    }
    throw new ConversationHttpError(405, "method_not_allowed", "Use GET or POST for runs.");
  }

  const runMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/runs\/([^/]+)(?:\/(cancel))?$/);
  if (runMatch) {
    const conversation = await requireBoundConversation(repository, binding, decodeURIComponent(runMatch[1] ?? ""));
    const runId = decodeURIComponent(runMatch[2] ?? "");
    if (runMatch[3] === "cancel" && req.method === "POST") {
      const body = await readJsonObject(req);
      rejectUnknownFields(body, ["reason"]);
      const reason = optionalString(body, "reason", 500) ?? "Run cancelled";
      const control = activeRunControls?.get(runControlKey(conversation.id, runId));
      if (control) {
        await control.cancel(reason);
      } else {
        await repository.transitionRun(runId, "cancelled", reason);
      }
      const run = await repository.getRun(conversation.id, runId);
      if (!run) throw new ConversationHttpError(404, "run_not_found", `Run ${runId} was not found.`);
      writeResponse(200, { run: publicRun(run) });
      return;
    }
    if (!runMatch[3] && req.method === "GET") {
      const run = await repository.getRun(conversation.id, runId);
      if (!run) throw new ConversationHttpError(404, "run_not_found", `Run ${runId} was not found.`);
      writeResponse(200, { run: publicRun(run) });
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
    if (!binding) throw new ConversationHttpError(400, "binding_required", "A signed-in Creator Agent binding is required.");
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

function conversationBinding(binding: SessionBinding): ConversationBinding {
  if (!binding.explicit) {
    // Resolver-free mode is an intentionally local fixture mode. It preserves
    // the historic raw conversation-id behavior across local installations;
    // production bindings always use the server-verified values below.
    return {
      ownerAccountId: "local-development",
      creatorId: "local-development",
      agentId: "local-agent",
      productId: "local-product",
      corpusDigest: binding.corpusDigest
    };
  }
  return {
    // Product mode always keeps the verified account as the owner.
    ownerAccountId: binding.userId,
    creatorId: binding.creatorId,
    agentId: binding.agentId,
    productId: binding.productId,
    corpusDigest: binding.corpusDigest
  };
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
    version: conversation.version
  };
}

function publicRun(run: ConversationRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    client_message_id: run.clientMessageId,
    status: run.status,
    corpus_digest: run.corpusDigest,
    created_at: run.createdAt,
    ...(run.startedAt ? { started_at: run.startedAt } : {}),
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
    ...(run.interruptedReason ? { interrupted_reason: run.interruptedReason } : {})
  };
}

function publicJournalEvent(event: ConversationJournalEvent): Record<string, unknown> {
  return {
    cursor: event.cursor,
    ...(event.runId ? { run_id: event.runId } : {}),
    type: event.type,
    payload: event.payload,
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

function writeConversationHttpError(res: http.ServerResponse, error: unknown): void {
  if (error instanceof ConversationHttpError) {
    writeJson(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ConversationRepositoryError) {
    const status = error.code === "conversation_not_found" || error.code === "run_not_found" ? 404
      : error.code === "conversation_busy" || error.code === "version_conflict" ? 409
        : error.code === "conversation_binding_mismatch" ? 403
          : 400;
    writeJson(res, status, { error: { code: error.code, message: error.message } });
    return;
  }
  writeJson(res, 500, { error: { code: "conversation_request_failed", message: errorMessage(error) } });
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
      error: { code: forbiddenCode, message: "This Creator Agent is not available for the signed-in account." }
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
  return new FileConversationRepository(store.dataDirectory);
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

function runControlKey(conversationId: string, runId: string): string {
  return `${conversationId}\u0000${runId}`;
}

function releaseConversationRun(
  activeConversationRuns: Map<string, string>,
  conversationId: string,
  runId: string
): void {
  if (activeConversationRuns.get(conversationId) === runId) {
    activeConversationRuns.delete(conversationId);
  }
}

async function handleRuntimeSocket(
  socket: WebSocket,
  activeConversationRuns: Map<string, string>,
  helloAuthorizationGate: CapacityGate,
  helloAuthorizationPerUserGate: KeyedCapacityGate,
  turnAuthorizationGate: CapacityGate,
  turnAuthorizationPerUserGate: KeyedCapacityGate,
  activeRunGate: CapacityGate,
  activeRunPerUserGate: KeyedCapacityGate,
  establishedConnectionGate: CapacityGate,
  establishedConnectionPerUserGate: KeyedCapacityGate,
  maxActiveRunsPerConnection: number,
  helloTimeoutMs: number,
  connectionHeartbeatMs: number,
  connectionIdleTimeoutMs: number,
  activeRunControls: Map<string, ActiveRunControl>,
  store: RuntimeStore,
  conversationRepository: ConversationRepository,
  repositoryReady: Promise<unknown>,
  createRuntime: () => AgentRuntime,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  legacyHmacAuth: LegacyHmacAuth = { enabled: false },
  configuredCreatorToolControlPlane?: CreatorToolControlPlane,
  outputGuard: OutputGuard = new PassThroughOutputGuard(),
  commerceEventSink?: CommerceEventSink,
  toolResultTimeoutMs = clientToolTimeoutMs(),
  serverToolTimeoutMs = 120_000,
  maxSocketBufferedBytes = 8 * 1024 * 1024
): Promise<void> {
  const connectionAbortController = new AbortController();
  let hello: ClientHello | undefined;
  const helloDeadline = setTimeout(() => {
    if (hello || socket.readyState === WebSocket.CLOSED) return;
    connectionAbortController.abort(new Error("Runtime client hello deadline exceeded"));
    socket.terminate();
  }, helloTimeoutMs);
  helloDeadline.unref();
  let binding: SessionBinding | undefined;
  let sessionSkills: RuntimeSessionSkills | undefined;
  const serverTools = new ServerToolExecutor(serverToolTimeoutMs);
  const creatorToolControlPlane = configuredCreatorToolControlPlane;
  const runtime = createRuntime();
  const activeRuns = new Set<Promise<void>>();
  const messageTasks = new Set<Promise<void>>();
  const activeRunStates = new Map<string, RunStateMachine>();
  const activeSkillRuntimes = new Map<string, SkillRuntime>();
  const activeRunAbortControllers = new Map<string, AbortController>();
  const pendingTurnAuthorizations = new Map<string, PendingTurnAuthorization>();
  const reservedRunIds = new Set<string>();
  const cancellingRunIds = new Set<string>();
  let helloPending = false;
  let authorizationSlotRunId: string | undefined;
  let releaseEstablishedConnection: (() => void) | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let awaitingPong = false;
  let lastClientActivityAt = Date.now();

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

  socket.once("close", () => {
    clearTimeout(helloDeadline);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    releaseEstablishedConnection?.();
    releaseEstablishedConnection = undefined;
    connectionAbortController.abort(new Error("Runtime socket closed"));
    for (const pending of pendingTurnAuthorizations.values()) {
      pending.cancelled = true;
      pending.controller.abort(new Error("Runtime socket closed"));
      releaseConversationRun(activeConversationRuns, pending.conversationId, pending.runId);
    }
    for (const controller of activeRunAbortControllers.values()) {
      controller.abort(new Error("Runtime socket closed"));
    }
    authorizationSlotRunId = undefined;
  });

  const send = async (message: OutboundMessage): Promise<void> => {
    const outbound = protectPrivateAgentBoundary(message, binding?.agentCorpusRoot, binding?.agentId);
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
  const broker = new ClientToolBroker(send, store, toolResultTimeoutMs);
  const toolBridge = new ToolBridge(broker, serverTools);

  socket.on("message", (data) => {
    lastClientActivityAt = Date.now();
    awaitingPong = false;
    const messageTask = (async () => {
      try {
        const message = parseInboundMessage(JSON.parse(String(data)));

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
          let releaseHelloAuthorization: (() => void) | undefined;
          let releaseUserHelloAuthorization: (() => void) | undefined;
          try {
            releaseHelloAuthorization = helloAuthorizationGate.tryAcquire();
            if (!releaseHelloAuthorization) {
              await send({
                type: "turn.failed",
                error: {
                  code: "authentication_busy",
                  message: "Hatch is already verifying the maximum number of new sessions. Try again shortly."
                }
              });
              socket.close(1013, "Authentication capacity reached");
              return;
            }
            const authClaims = await resolveHelloAuthClaims(
              message,
              authIdentityResolver,
              legacyHmacAuth,
              connectionAbortController.signal
            );
            const userKey = authClaims?.sub ?? message.user_id ?? message.installation_id;
            releaseUserHelloAuthorization = helloAuthorizationPerUserGate.tryAcquire(userKey);
            if (!releaseUserHelloAuthorization) {
              await send({
                type: "turn.failed",
                error: {
                  code: "user_authentication_busy",
                  message: "This account is already opening the maximum number of sessions. Try again shortly."
                }
              });
              socket.close(1013, "User authentication capacity reached");
              return;
            }
            binding = await resolveSessionBinding(
              message,
              entitlementResolver,
              agentCorpusResolver,
              authIdentityResolver,
              authClaims,
              connectionAbortController.signal
            );
            connectionAbortController.signal.throwIfAborted();
            const releaseGlobalConnection = establishedConnectionGate.tryAcquire();
            if (!releaseGlobalConnection) {
              await send({
                type: "turn.failed",
                error: {
                  code: "connection_capacity",
                  message: "Hatch is already serving the maximum number of connected sessions. Try again shortly."
                }
              });
              socket.close(1013, "Connection capacity reached");
              return;
            }
            const releaseUserConnection = establishedConnectionPerUserGate.tryAcquire(binding.userId);
            if (!releaseUserConnection) {
              releaseGlobalConnection();
              await send({
                type: "turn.failed",
                error: {
                  code: "user_connection_capacity",
                  message: "This account already has the maximum number of connected sessions."
                }
              });
              socket.close(1013, "User connection capacity reached");
              return;
            }
            releaseEstablishedConnection = combineCapacityReleases(
              releaseGlobalConnection,
              releaseUserConnection
            );
            if (binding.agentCorpus && binding.agentCorpusRoot) {
              serverTools.setKnowledgeScope({
                provider: createKnowledgeProvider(binding.agentCorpusRoot, binding.agentCorpus, binding.corpusDigest),
                creatorId: binding.agentCorpus.creator.id,
                agentId: binding.agentCorpus.agent_id,
                corpusDigest: binding.corpusDigest
              });
              serverTools.setResolvedCreatorTools(await resolveCreatorTools(
                creatorToolControlPlane,
                binding.agentCorpus.creator.id,
                binding.agentCorpus.agent_id,
                binding.agentCorpus,
                connectionAbortController.signal
              ));
              connectionAbortController.signal.throwIfAborted();
            }
            const nextSessionSkills = await buildSessionSkills(Boolean(binding.agentCorpusRoot));
            connectionAbortController.signal.throwIfAborted();
            await store.append({
              type: "session.started",
              installation_id: message.installation_id,
              creator_id: binding.creatorId,
              user_id: binding.userId,
              agent_id: binding.agentId,
              product_id: binding.productId,
              corpus_digest: binding.corpusDigest,
              ...(binding.entitlementId ? { entitlement_id: binding.entitlementId } : {}),
              client_version: message.client_version,
              local_tools: message.local_tools
            });
            connectionAbortController.signal.throwIfAborted();
            // Publish the connection binding only after all fallible session
            // setup is durable. A failed hello can then be retried without
            // leaving a half-ready socket that rejects every later hello.
            hello = message;
            sessionSkills = nextSessionSkills;
            clearTimeout(helloDeadline);
            await send({
              type: "session.ready",
              accepted_protocol_version: PROTOCOL_VERSION,
              creator_id: binding.creatorId,
              user_id: binding.userId,
              agent_id: binding.agentId,
              product_id: binding.productId,
              corpus_digest: binding.corpusDigest,
              ...(binding.entitlementId ? { entitlement_id: binding.entitlementId } : {}),
              ...(binding.agentCorpus ? {
                creator_agent: {
                  creator: binding.agentCorpus.creator,
                  product: {
                    id: binding.agentCorpus.product.id,
                    name: binding.agentCorpus.product.name,
                    description: binding.agentCorpus.product.description ?? "",
                    ...(binding.agentCorpus.product.promise ? { promise: binding.agentCorpus.product.promise } : {}),
                    ...(binding.agentCorpus.product.boundaries.length ? { boundaries: binding.agentCorpus.product.boundaries } : {}),
                    ...(binding.agentCorpus.product.offer ? { offer: binding.agentCorpus.product.offer } : {})
                  },
                  presentation: binding.agentCorpus.product.presentation
                }
              } : {})
            });
            startEstablishedConnectionHeartbeat();
          } finally {
            releaseUserHelloAuthorization?.();
            releaseHelloAuthorization?.();
            if (!hello) {
              releaseEstablishedConnection?.();
              releaseEstablishedConnection = undefined;
            }
            helloPending = false;
          }
          return;
        }

        if (!hello || !binding) {
          await send({
            type: "turn.failed",
            error: {
              code: "hello_required",
              message: "client.hello must be sent before run messages"
            }
          });
          return;
        }

        if (message.type === "tool_call.result") {
          if (!await broker.handleResult(message)) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "unknown_tool_call",
                message: `No pending tool request for ${message.tool_call_id}`
              }
            });
          }
          return;
        }

        if (message.type === "turn.cancel") {
          const pendingAuthorization = pendingTurnAuthorizations.get(message.run_id);
          if (pendingAuthorization) {
            if (!pendingAuthorization.cancelled) {
              const reason = message.reason ?? "Run canceled";
              pendingAuthorization.cancelled = true;
              pendingAuthorization.controller.abort(new Error(reason));
              releaseConversationRun(
                activeConversationRuns,
                pendingAuthorization.conversationId,
                pendingAuthorization.runId
              );
              await send({
                type: "turn.failed",
                run_id: message.run_id,
                error: { code: "run_cancelled", message: reason }
              });
            }
            return;
          }
          const state = activeRunStates.get(message.run_id);
          if (!state) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "unknown_run",
                message: `No active run for ${message.run_id}`
              }
            });
            return;
          }
          cancellingRunIds.add(message.run_id);
          const reason = message.reason ?? "Run canceled";
          activeRunAbortControllers.get(message.run_id)?.abort(new Error(reason));
          const control = activeRunControls.get(runControlKey(state.conversationId, message.run_id));
          try {
            if (control) {
              await control.cancel(reason);
            } else {
              // Defensive fallback for the tiny interval while a newly-created
              // run is being registered with the process-local control map.
              await state.cancel(reason).catch(() => undefined);
              await activeSkillRuntimes.get(message.run_id)?.cancelParentRun(message.run_id);
              await broker.cancelRun(message.run_id, reason);
              await send({ type: "turn.failed", run_id: message.run_id, error: { code: "run_cancelled", message: reason } });
            }
          } finally {
            cancellingRunIds.delete(message.run_id);
            if (!activeRunStates.has(message.run_id)) reservedRunIds.delete(message.run_id);
          }
          return;
        }

        if (message.type === "client.message") {
          if (!sessionSkills) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "session_not_ready",
                message: "session skills were not initialized"
              }
            });
            return;
          }
          // Durable identity deliberately excludes corpus_digest: an Agent
          // update must not orphan an existing Account/Creator/Agent thread.
          const storageConversationId = binding.explicit
            ? durableConversationId(binding, message.conversation_id)
            : message.conversation_id;
          const clientMessageId = message.client_message_id ?? message.run_id;
          if (reservedRunIds.has(message.run_id) || activeConversationRuns.has(storageConversationId)) {
            await repositoryReady;
            const existing = await conversationRepository.getRunByClientMessageId(storageConversationId, clientMessageId);
            if (existing) {
              await send({
                type: "turn.state",
                run_id: existing.id,
                status: existing.status,
                reason: "Idempotent client message replay"
              });
              return;
            }
          }
          if (reservedRunIds.has(message.run_id)) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "duplicate_run_id",
                message: `Run ID ${message.run_id} is already pending or active on this connection.`
              }
            });
            return;
          }
          const activeRunId = activeConversationRuns.get(storageConversationId);
          if (activeRunId) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "conversation_busy",
                message: `Conversation ${message.conversation_id} already has an active or pending run: ${activeRunId}`
              }
            });
            return;
          }
          if (authorizationSlotRunId) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "connection_busy",
                message: `This connection is already authorizing run ${authorizationSlotRunId}. Try again after it finishes.`
              }
            });
            return;
          }
          if (reservedRunIds.size >= maxActiveRunsPerConnection) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "connection_run_capacity",
                message: "This connection already has the maximum number of pending or active runs."
              }
            });
            return;
          }
          const releaseTurnAuthorizationCapacity = turnAuthorizationGate.tryAcquire();
          if (!releaseTurnAuthorizationCapacity) {
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "authorization_busy",
                message: "Hatch is already verifying the maximum number of turns. Try again shortly."
              }
            });
            return;
          }
          const releaseUserTurnAuthorizationCapacity = turnAuthorizationPerUserGate.tryAcquire(binding.userId);
          if (!releaseUserTurnAuthorizationCapacity) {
            releaseTurnAuthorizationCapacity();
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "user_authorization_busy",
                message: "This account is already verifying the maximum number of turns. Try again shortly."
              }
            });
            return;
          }
          const releaseActiveRunCapacity = activeRunGate.tryAcquire();
          if (!releaseActiveRunCapacity) {
            releaseTurnAuthorizationCapacity();
            releaseUserTurnAuthorizationCapacity();
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "runtime_run_capacity",
                message: "Hatch is already running the maximum number of tasks. Try again shortly."
              }
            });
            return;
          }
          const releaseUserActiveRunCapacity = activeRunPerUserGate.tryAcquire(binding.userId);
          if (!releaseUserActiveRunCapacity) {
            releaseActiveRunCapacity();
            releaseTurnAuthorizationCapacity();
            releaseUserTurnAuthorizationCapacity();
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "user_run_capacity",
                message: "This account already has the maximum number of pending or active tasks."
              }
            });
            return;
          }

          // Both reservations happen synchronously before the first Registry
          // await, so a burst cannot multiply identity/entitlement requests.
          const authorizationController = new AbortController();
          const abortFromConnection = () => authorizationController.abort(connectionAbortController.signal.reason);
          if (connectionAbortController.signal.aborted) abortFromConnection();
          else connectionAbortController.signal.addEventListener("abort", abortFromConnection, { once: true });
          const pendingAuthorization: PendingTurnAuthorization = {
            runId: message.run_id,
            conversationId: storageConversationId,
            controller: authorizationController,
            cancelled: false,
            detachConnectionAbort: () => connectionAbortController.signal.removeEventListener("abort", abortFromConnection),
            releaseAuthorizationCapacity: combineCapacityReleases(
              releaseTurnAuthorizationCapacity,
              releaseUserTurnAuthorizationCapacity
            ),
            releaseActiveRunCapacity: combineCapacityReleases(
              releaseActiveRunCapacity,
              releaseUserActiveRunCapacity
            )
          };
          authorizationSlotRunId = message.run_id;
          pendingTurnAuthorizations.set(message.run_id, pendingAuthorization);
          reservedRunIds.add(message.run_id);
          activeConversationRuns.set(storageConversationId, message.run_id);
          try {
            await revalidateTurnAuthorization(
              hello,
              binding,
              entitlementResolver,
              authIdentityResolver,
              agentCorpusResolver,
              authorizationController.signal
            );
            if (binding.agentCorpus) {
              try {
                serverTools.setResolvedCreatorTools(await resolveCreatorTools(
                  creatorToolControlPlane,
                  binding.creatorId,
                  binding.agentId,
                  binding.agentCorpus,
                  authorizationController.signal
                ));
              } catch (error) {
                authorizationController.signal.throwIfAborted();
                throw new EntitlementError(
                  "agent_updated",
                  `This Creator Agent's tool bindings changed. Reconnect before starting another turn: ${errorMessage(error)}`
                );
              }
            }
            if (authorizationController.signal.aborted || pendingAuthorization.cancelled) {
              throw new EntitlementError("authorization_cancelled", "Authorization verification was cancelled.");
            }
          } catch (error) {
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
            if (pendingTurnAuthorizations.get(message.run_id) === pendingAuthorization) {
              pendingTurnAuthorizations.delete(message.run_id);
            }
            reservedRunIds.delete(message.run_id);
            pendingAuthorization.detachConnectionAbort();
            pendingAuthorization.releaseAuthorizationCapacity();
            pendingAuthorization.releaseActiveRunCapacity();
            if (authorizationSlotRunId === message.run_id) authorizationSlotRunId = undefined;
            if (!pendingAuthorization.cancelled && !connectionAbortController.signal.aborted) {
              await send({
                type: "turn.failed",
                run_id: message.run_id,
                error: controlledTurnAuthorizationError(error)
              });
            }
            return;
          }
          // Transition pending -> active without an await. A cancel can now
          // observe exactly one owner and a late resolver can never resurrect
          // a tombstoned authorization.
          if (pendingAuthorization.cancelled
            || authorizationController.signal.aborted
            || pendingTurnAuthorizations.get(message.run_id) !== pendingAuthorization) {
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
            reservedRunIds.delete(message.run_id);
            pendingAuthorization.detachConnectionAbort();
            pendingAuthorization.releaseAuthorizationCapacity();
            pendingAuthorization.releaseActiveRunCapacity();
            if (authorizationSlotRunId === message.run_id) authorizationSlotRunId = undefined;
            return;
          }
          pendingTurnAuthorizations.delete(message.run_id);
          pendingAuthorization.detachConnectionAbort();
          pendingAuthorization.releaseAuthorizationCapacity();
          if (authorizationSlotRunId === message.run_id) authorizationSlotRunId = undefined;

          let durableRun: { run: ConversationRunRecord; created: boolean };
          try {
            await repositoryReady;
            await conversationRepository.createConversation({
              ...conversationBinding(binding),
              id: storageConversationId,
              publicId: message.conversation_id
            });
            durableRun = await conversationRepository.createRun({
              id: message.run_id,
              conversationId: storageConversationId,
              // Existing clients use run_id as their stable retry key until
              // they send client_message_id from this protocol extension.
              clientMessageId,
              corpusDigest: binding.corpusDigest,
              executorId: hello.installation_id,
              executorLeaseExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
            });
          } catch (error) {
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
            reservedRunIds.delete(message.run_id);
            pendingAuthorization.releaseActiveRunCapacity();
            if (error instanceof ConversationRepositoryError && error.code === "conversation_busy") {
              await send({
                type: "turn.failed",
                run_id: message.run_id,
                error: { code: "conversation_busy", message: error.message }
              });
              return;
            }
            throw error;
          }
          if (!durableRun.created) {
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
            reservedRunIds.delete(message.run_id);
            pendingAuthorization.releaseActiveRunCapacity();
            await send({
              type: "turn.state",
              run_id: durableRun.run.id,
              status: durableRun.run.status,
              reason: "Idempotent client message replay"
            });
            return;
          }

          const boundMessage: RunStart = { ...message, conversation_id: storageConversationId };
          const runAbortController = new AbortController();
          activeRunAbortControllers.set(message.run_id, runAbortController);
          const state = new RunStateMachine(message.run_id, storageConversationId, store, async (status, reason) => {
            await conversationRepository.transitionRun(message.run_id, status, reason);
            await send({
              type: "turn.state",
              run_id: message.run_id,
              status,
              reason
            });
          });
          activeRunStates.set(message.run_id, state);
          const cancelActiveRun = async (reason: string): Promise<void> => {
            runAbortController.abort(new Error(reason));
            await state.cancel(reason).catch(() => undefined);
            await activeSkillRuntimes.get(message.run_id)?.cancelParentRun(message.run_id);
            await broker.cancelRun(message.run_id, reason);
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: { code: "run_cancelled", message: reason }
            });
          };
          activeRunControls.set(runControlKey(storageConversationId, message.run_id), { cancel: cancelActiveRun });
          try {
            await state.queued();
          } catch {
            activeRunStates.delete(message.run_id);
            activeRunAbortControllers.delete(message.run_id);
            activeRunControls.delete(runControlKey(storageConversationId, message.run_id));
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
            reservedRunIds.delete(message.run_id);
            pendingAuthorization.releaseActiveRunCapacity();
            await conversationRepository.transitionRun(message.run_id, "failed", "Run setup failed").catch(() => undefined);
            await send({
              type: "turn.failed",
              run_id: message.run_id,
              error: {
                code: "run_setup_failed",
                message: "The turn could not be started. Try again."
              }
            });
            return;
          }
          const task = runOneTurn(
            boundMessage,
            hello,
            sessionSkills,
            binding,
            broker,
            serverTools,
            toolBridge,
            runtime,
            createRuntime,
            store,
            conversationRepository,
            state,
            send,
            activeSkillRuntimes,
            outputGuard,
            runAbortController.signal,
            commerceEventSink
          );
          activeRuns.add(task);
          const releaseActiveRun = () => {
            activeRuns.delete(task);
            activeRunStates.delete(message.run_id);
            activeRunAbortControllers.delete(message.run_id);
            if (!cancellingRunIds.has(message.run_id)) reservedRunIds.delete(message.run_id);
            activeRunControls.delete(runControlKey(storageConversationId, message.run_id));
            releaseConversationRun(activeConversationRuns, storageConversationId, message.run_id);
            pendingAuthorization.releaseActiveRunCapacity();
          };
          void task.then(releaseActiveRun, releaseActiveRun);
        }
      } catch (error) {
        await send({
          type: "turn.failed",
          error: {
            code: error instanceof EntitlementError ? error.code : "protocol_error",
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
      void (async () => {
        try {
          const reason = "Client disconnected";
          const states = [...activeRunStates.values()];
          for (const state of states) {
            activeRunControls.delete(runControlKey(state.conversationId, state.runId));
          }
          await Promise.allSettled(states.map((state) => state.cancel(reason)));
          await broker.cancelAll(reason).catch(() => undefined);
          await Promise.allSettled([...messageTasks]);
          await Promise.allSettled([...activeRuns]);
        } finally {
          resolve();
        }
      })().catch(() => resolve());
    });
  });
}

export function protectPrivateAgentBoundary(
  message: OutboundMessage,
  agentCorpusRoot?: string,
  agentId = "creator-agent"
): OutboundMessage {
  if (!agentCorpusRoot) return message;
  if (message.type === "skill.activated" || message.type === "skill.invoked") {
    return {
      ...message,
      path: `agent://${encodeURIComponent(agentId)}/protected-skill/${encodeURIComponent(message.name)}`,
      ...(message.type === "skill.activated" ? { resource_paths: [], resource_manifest_truncated: false } : {}),
      ...(message.type === "skill.invoked" ? { trigger: { ...message.trigger, path: message.trigger.path ? "agent://private" : undefined } } : {})
    } as OutboundMessage;
  }
  if (message.type === "tool_call.delta" && message.locality === "server") {
    const serializedArguments = JSON.stringify(message.arguments ?? {});
    if (serializedArguments.includes(agentCorpusRoot)) {
      return { ...message, arguments: {}, result: message.result ? { private_result_redacted: true } : undefined };
    }
  }
  return message;
}

async function runOneTurn(
  input: RunStart,
  hello: ClientHello,
  sessionSkills: RuntimeSessionSkills,
  binding: SessionBinding,
  broker: ClientToolBroker,
  serverTools: ServerToolExecutor,
  toolBridge: ToolBridge,
  runtime: AgentRuntime,
  createRuntime: () => AgentRuntime,
  store: RuntimeStore,
  conversationRepository: ConversationRepository,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>,
  activeSkillRuntimes: Map<string, SkillRuntime>,
  outputGuard: OutputGuard,
  abortSignal: AbortSignal,
  commerceEventSink?: CommerceEventSink
): Promise<void> {
  const turnStarted = performance.now();
  let setupCompleted = turnStarted;
  let modelFirstText: number | undefined;
  let firstSafeSegment: number | undefined;
  const guardTiming: Array<import("./outputGuard.js").OutputGuardTiming & { released_ms?: number }> = [];
  let skillRuntime: SkillRuntime | undefined;
  let deliveredArtifact: DeliveryArtifact | undefined;
  try {
    abortSignal.throwIfAborted();
    await state.start();
    const priorMessages = await store.readConversation(input.conversation_id);
    const materializedAgent = binding.agentCorpusRoot
      ? await materializeAgentCorpus(
        binding.agentCorpusRoot,
        input.message.content,
        hello.local_tools,
        binding.corpusDigest,
        abortSignal
      )
      : undefined;
    const persistUserMessage = async (): Promise<void> => {
      await store.append({
        type: "conversation.model_message",
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        message: input.message
      });
      await conversationRepository.appendEvent({
        conversationId: input.conversation_id,
        runId: input.run_id,
        type: "message.created",
        payload: { role: "user", content: input.message.content }
      });
    };
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
    const deliveryBinding = deliveryBindingFromSession(binding);
    let approvedAssistantText = "";
    const emitReleased = async (result: GuardedOutputResult): Promise<void> => {
      for (const content of result.released) {
        approvedAssistantText += content;
        const releasedAt = performance.now();
        firstSafeSegment ??= releasedAt;
        await send({
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
      const content = finishReason === "content_filter"
        ? OUTPUT_GUARD_BLOCKED_MODEL_MESSAGE
        : approvedAssistantText;
      await store.append({
        type: "conversation.model_message",
        conversation_id: input.conversation_id,
        run_id: input.run_id,
        message: { role: "assistant", content },
        finish_reason: finishReason
      });
      await conversationRepository.appendEvent({
        conversationId: input.conversation_id,
        runId: input.run_id,
        type: "message.created",
        payload: {
          role: "assistant",
          content: finishReason === "content_filter" ? "" : approvedAssistantText,
          ...(finishReason === "content_filter" ? { finish_reason: finishReason } : {})
        }
      });
      if (finishReason === "stop" && recordDelivery && commerceEventSink && deliveryBinding) {
        const receipt = await recordCompletedDelivery(
          commerceEventSink,
          deliveryBinding,
          input.conversation_id,
          input.run_id,
          deliveredArtifact ?? { type: "message", content: approvedAssistantText }
        );
        await send({ type: "delivery.ready", run_id: input.run_id, ...receipt });
      }
      const completedAt = performance.now();
      await send({
        type: "turn.completed",
        run_id: input.run_id,
        finish_reason: finishReason,
        timing: {
          total_ms: completedAt - turnStarted,
          setup_ms: setupCompleted - turnStarted,
          ...(modelFirstText === undefined ? {} : { model_first_text_ms: modelFirstText - turnStarted }),
          ...(firstSafeSegment === undefined ? {} : { first_safe_segment_ms: firstSafeSegment - turnStarted }),
          guard: guardTiming
        }
      });
      await state.complete();
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
        await persistUserMessage();
        await send({ type: "delivery.ready", run_id: input.run_id, ...completedDelivery });
        await sendFixedAssistant("This delivery was already completed. The existing artifact has not been changed.");
        return;
      }
    }
    if (input.message.content.trim() === "/compact") {
      await compactAndEmit(input, store, state, send, priorMessages, {
        trigger: "manual",
        phase: "standalone_turn",
        reason: "user_requested"
      });
      await persistUserMessage();
      await sendFixedAssistant("Compaction complete.");
      return;
    }

    const preTurnCompaction = await compactIfNeeded(input, store, state, send, priorMessages, "pre_turn");
    let runtimeMessages = priorMessages;
    if (preTurnCompaction) {
      runtimeMessages = preTurnCompaction.replacement_history;
    }
    await persistUserMessage();

    setupCompleted = performance.now();
    skillRuntime = new SkillRuntime({
      parentInput: input,
      parentState: state,
      sessionSkills,
      clientBroker: broker,
      serverTools,
      toolBridge,
      clientTools: materializedAgent?.localTools ?? hello.local_tools,
      allowedExternalTools: materializedAgent?.externalTools,
      agentSystemPrompt: materializedAgent?.systemPrompt,
      deliveryAuditContext: materializedAgent?.deliveryAuditContext,
      store,
      emit: send,
      createWorkerRuntime: () => createRuntime()
    });
    activeSkillRuntimes.set(input.run_id, skillRuntime);
    const messages = [...runtimeMessages, input.message];

    // Store/materialization work may race with a disconnect. Never start a
    // provider request after the owning run has already been aborted.
    abortSignal.throwIfAborted();
    for await (const event of runtime.run(input, {
      clientBroker: broker,
      serverTools,
      state,
      messages,
      sessionSkills,
      activatedSkills: [],
      clientTools: materializedAgent?.localTools ?? hello.local_tools,
      allowedExternalTools: materializedAgent?.externalTools,
      externalToolDefinitions: materializedAgent?.externalToolDefinitions,
      // An Agent Corpus has already materialized matching protected Skills
      // into the server-private prompt. Product execution remains one Agent
      // session rather than a generic parent delegating to another worker.
      allowSkillRun: !binding.agentCorpusRoot,
      persistModelMessage: async (message) => {
        await store.append({
          type: "conversation.model_message",
          conversation_id: input.conversation_id,
          run_id: input.run_id,
          message
        });
      },
      compactMessagesIfNeeded: async (runtimeMessages: RuntimeCompactionMessage[], phase) => {
        const compacted = await compactIfNeeded(input, store, state, send, runtimeMessages, phase);
        return compacted?.replacement_history;
      },
      toolBridge,
      skillRuntime,
      toolScope: "main",
      agentSystemPrompt: materializedAgent?.systemPrompt,
      deliveryAuditContext: materializedAgent?.deliveryAuditContext,
      knowledgeAvailable: Boolean(
        binding.agentCorpus?.knowledge.documents.length
        && knowledgeProviderConfigured()
      ),
      abortSignal
    })) {
      if (state.status === "cancelled") {
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
          content: event.arguments.content,
          ...(typeof event.arguments.path === "string" ? { path: event.arguments.path } : {})
        };
      }
      if (event.type === "turn.completed") {
        const final = await guardedOutput.finish();
        await emitReleased(final);
        await commitTerminal(
          event.finish_reason === "content_filter" || final.blocked
            ? "content_filter"
            : "stop"
        );
        return;
      }
      await send(event);
    }
  } catch (error) {
    if (state.status === "cancelled") {
      return;
    }
    await state.fail(errorMessage(error)).catch(() => undefined);
    await send({
      type: "turn.failed",
      run_id: input.run_id,
      error: {
        code: error instanceof AgentCorpusChangedError ? "agent_updated" : "run_failed",
        message: errorMessage(error)
      }
    });
  } finally {
    await skillRuntime?.cancelParentRun(input.run_id);
    activeSkillRuntimes.delete(input.run_id);
  }
}

async function buildSessionSkills(protectedCorpus = false): Promise<RuntimeSessionSkills> {
  // The Agent Corpus materializer loads matching protected SKILL.md files into the
  // direct server Agent. Do not also expose it as a model-selectable catalog
  // entry: that creates an unnecessary nested skill worker and lets the same
  // method run through two different delivery paths.
  const records = protectedCorpus ? [] : await discoverSkills();
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

async function resolveSessionBinding(
  hello: ClientHello,
  entitlementResolver?: EntitlementResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  authIdentityResolver?: AuthIdentityResolver,
  authClaims?: AuthIdentity,
  signal?: AbortSignal
): Promise<SessionBinding> {
  const authToken = hello.auth_token ?? hello.license_token;
  if (authIdentityResolver && !authClaims) {
    throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
  }
  if (hello.agent_id) {
    if (!agentCorpusResolver) {
      throw new EntitlementError(
        "agent_corpus_unavailable",
        "The requested Creator Agent is not available on this Runtime."
      );
    }
    const selectedCreatorId = authClaims?.role === "creator"
      ? authClaims.sub
      : hello.creator_id;
    if (!selectedCreatorId) {
      throw new EntitlementError("creator_required", "creator_id is required when selecting a Creator Agent.");
    }
    const resolved = await agentCorpusResolver.resolve(selectedCreatorId, hello.agent_id, signal);
    let corpusEntitlement: Awaited<ReturnType<EntitlementResolver["resolve"]>> | undefined;
    if (authClaims?.role !== "creator" && !entitlementResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Creator Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (authClaims?.role !== "creator" && entitlementResolver) {
      if (!hello.entitlement_id) {
        throw new EntitlementError("entitlement_required", "A valid Creator Agent entitlement is required.");
      }
      const entitlement = await entitlementResolver.resolve({
        authToken,
        licenseToken: authToken,
        entitlementId: hello.entitlement_id,
        installationId: hello.installation_id,
        signal
      });
      assertEntitlementMatchesIdentity(authClaims, entitlement);
      if (entitlement.agent_id !== hello.agent_id
        || entitlement.creator_id !== resolved.corpus.creator.id
        || entitlement.product_id !== resolved.corpus.product.id) {
        throw new EntitlementError("agent_entitlement_mismatch", "This Creator Agent is not available for the signed-in account.");
      }
      corpusEntitlement = entitlement;
    }
    if (hello.product_id && hello.product_id !== resolved.corpus.product.id) {
      throw new Error("Agent Corpus product binding mismatch");
    }
    return {
      creatorId: resolved.corpus.creator.id,
      userId: authClaims?.sub ?? corpusEntitlement?.user_id ?? hello.user_id ?? hello.installation_id,
      agentId: resolved.corpus.agent_id,
      productId: resolved.corpus.product.id,
      corpusDigest: resolved.digest,
      agentCorpus: resolved.corpus,
      agentCorpusRoot: resolved.root,
      ...(corpusEntitlement ? { entitlementId: corpusEntitlement.entitlement_id, orderId: corpusEntitlement.order_id } : {}),
      explicit: true
    };
  }
  const productMode = Boolean(entitlementResolver || agentCorpusResolver);
  if (productMode) {
    if (!entitlementResolver || !agentCorpusResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Creator Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!hello.entitlement_id) {
      throw new EntitlementError("entitlement_required", "A valid Creator Agent entitlement is required.");
    }
    const entitlement = await entitlementResolver.resolve({
      authToken,
      licenseToken: authToken,
      entitlementId: hello.entitlement_id,
      installationId: hello.installation_id,
      signal
    });
    assertEntitlementMatchesIdentity(authClaims, entitlement);
    const resolved = await agentCorpusResolver.resolve(entitlement.creator_id, entitlement.agent_id, signal);
    if (resolved.corpus.product.id !== entitlement.product_id || resolved.corpus.creator.id !== entitlement.creator_id) {
      throw new Error("Entitlement does not match its current Agent Corpus");
    }
    return {
      creatorId: entitlement.creator_id,
      userId: entitlement.user_id,
      agentId: entitlement.agent_id,
      productId: entitlement.product_id,
      corpusDigest: resolved.digest,
      entitlementId: entitlement.entitlement_id,
      orderId: entitlement.order_id,
      agentCorpus: resolved.corpus,
      agentCorpusRoot: resolved.root,
      explicit: true
    };
  }

  // Resolver-free mode is intentionally limited to local development and tests.
  // In product mode all scope is derived from a server-verified entitlement above.
  const creatorId = hello.creator_id ?? `local-${shortHash(authToken ?? hello.installation_id)}`;
  const userId = authClaims?.sub ?? hello.user_id ?? hello.installation_id;
  const agentId = hello.agent_id ?? "local-agent";
  const productId = hello.product_id ?? "local-product";
  return {
    creatorId,
    userId,
    agentId,
    productId,
    corpusDigest: `sha256:${"0".repeat(64)}`,
    explicit: Boolean(hello.creator_id || hello.user_id || hello.agent_id || hello.product_id)
  };
}

async function resolveHelloAuthClaims(
  hello: ClientHello,
  authIdentityResolver: AuthIdentityResolver | undefined,
  legacyHmacAuth: LegacyHmacAuth,
  signal?: AbortSignal
): Promise<AuthIdentity | undefined> {
  const authToken = hello.auth_token ?? hello.license_token;
  const authIdentity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  const authClaims = authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth);
  if (authIdentityResolver && !authIdentity) {
    throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
  }
  return authClaims;
}

async function resolveAuthIdentity(
  authToken: string | undefined,
  authIdentityResolver?: AuthIdentityResolver,
  signal?: AbortSignal
): Promise<AuthIdentity | undefined> {
  if (!authIdentityResolver) return undefined;
  return authIdentityResolver.resolveIdentity(authToken, { signal });
}

function legacyAuthClaims(
  authToken: string | undefined,
  authIdentityResolver: AuthIdentityResolver | undefined,
  legacyHmacAuth: LegacyHmacAuth
): AuthIdentity | undefined {
  // HMAC verification is retained only for local fixture/migration mode. A
  // Runtime configured with the Registry verifier never reaches this branch.
  if (authIdentityResolver || !legacyHmacAuth.enabled) return undefined;
  return verifyHatchAuthToken(authToken, legacyHmacAuth.signingSecret);
}

function assertEntitlementMatchesIdentity(
  identity: AuthIdentity | undefined,
  entitlement: { user_id: string }
): void {
  if (identity && (identity.role !== "user" || entitlement.user_id !== identity.sub)) {
    throw new EntitlementError("agent_entitlement_mismatch", "This Creator Agent is not available for the signed-in account.");
  }
}

/**
 * A successful hello authorizes a connection, not all future turns. Opaque
 * Registry sessions and access grants are revocable, so production-backed
 * sessions must cross both boundaries again before any run state is created.
 */
async function revalidateTurnAuthorization(
  hello: ClientHello,
  binding: SessionBinding,
  entitlementResolver?: EntitlementResolver,
  authIdentityResolver?: AuthIdentityResolver,
  agentCorpusResolver?: AgentCorpusResolver,
  signal?: AbortSignal
): Promise<void> {
  const authToken = hello.auth_token ?? hello.license_token;
  const identity = await resolveAuthIdentity(authToken, authIdentityResolver, signal);
  if (authIdentityResolver && (!identity || identity.sub !== binding.userId)) {
    throw new EntitlementError("authentication_required", "The Hatch session binding is no longer valid.");
  }

  if (!binding.entitlementId) {
    // A Creator operates their own Agent Corpus without a buyer entitlement,
    // but their opaque session is still re-introspected on every turn.
    if (authIdentityResolver
      && binding.agentCorpus
      && (identity?.role !== "creator" || identity.sub !== binding.creatorId)) {
      throw new EntitlementError("authentication_required", "The Hatch session binding is no longer valid.");
    }
  } else {
    if ((authIdentityResolver && identity?.role !== "user") || !entitlementResolver) {
      throw new EntitlementError("entitlement_required", "The Creator Agent access binding is no longer valid.");
    }
    const entitlement = await entitlementResolver.resolve({
      authToken,
      licenseToken: authToken,
      entitlementId: binding.entitlementId,
      installationId: hello.installation_id,
      signal
    });
    assertEntitlementMatchesIdentity(identity, entitlement);
    if (entitlement.entitlement_id !== binding.entitlementId
      || entitlement.user_id !== binding.userId
      || entitlement.creator_id !== binding.creatorId
      || entitlement.agent_id !== binding.agentId
      || entitlement.product_id !== binding.productId) {
      throw new EntitlementError("entitlement_required", "The Creator Agent access binding is no longer valid.");
    }
  }

  if (binding.agentCorpus) {
    if (!agentCorpusResolver) {
      throw new EntitlementError("agent_updated", "This Creator Agent changed. Reconnect before starting another turn.");
    }
    const current = await agentCorpusResolver.resolve(binding.creatorId, binding.agentId, signal);
    if (current.digest !== binding.corpusDigest
      || current.corpus.creator.id !== binding.creatorId
      || current.corpus.agent_id !== binding.agentId
      || current.corpus.product.id !== binding.productId) {
      throw new EntitlementError("agent_updated", "This Creator Agent changed. Reconnect before starting another turn.");
    }
  }
}

function controlledTurnAuthorizationError(error: unknown): { code: string; message: string } {
  const code = error instanceof EntitlementError ? error.code : "authorization_unavailable";
  if (code === "authentication_required" || code === "auth_invalid") {
    return {
      code: "authentication_required",
      message: "Your Hatch session is no longer valid. Sign in again."
    };
  }
  if (code === "entitlement_required"
    || code === "entitlement_not_found"
    || code === "agent_entitlement_mismatch") {
    return {
      code: "entitlement_required",
      message: "Access to this Creator Agent is no longer available. Refresh your Creator Agents and choose an available Agent."
    };
  }
  if (code === "agent_updated") {
    return {
      code: "agent_updated",
      message: "This Creator Agent was updated. Reconnect to load the current version before continuing."
    };
  }
  return {
    code: "authorization_unavailable",
    message: "Hatch could not verify access for this turn. Check your connection and try again."
  };
}

export function scopedConversationId(binding: Pick<SessionBinding, "creatorId" | "userId" | "agentId" | "productId" | "corpusDigest">, conversationId: string): string {
  return `scope:${shortHash([binding.creatorId, binding.userId, binding.agentId, binding.productId, binding.corpusDigest].join("\u0000"))}:${conversationId}`;
}

/**
 * P2 durable Conversation identity. Unlike the legacy transcript scope above,
 * this intentionally excludes corpusDigest: corpus revision is recorded on
 * each Run, while a Conversation remains bound to the same Account and Creator
 * Agent across Agent Corpus updates.
 */
export function durableConversationId(
  binding: Pick<SessionBinding, "creatorId" | "userId" | "agentId" | "productId">,
  conversationId: string
): string {
  return `conversation:${shortHash([binding.creatorId, binding.userId, binding.agentId, binding.productId].join("\u0000"))}:${conversationId}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
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
  const productMode = Boolean(entitlementResolver || agentCorpusResolver);
  if (productMode) {
    if (!entitlementResolver || !agentCorpusResolver) {
      throw new EntitlementError(
        "entitlement_configuration_incomplete",
        "Creator Agent access is unavailable because entitlement verification is not fully configured."
      );
    }
    if (!entitlementId || !authToken) {
      throw new EntitlementError("entitlement_required", "A Bearer token and Creator Agent entitlement are required.");
    }
    if (authIdentityResolver && !authIdentity) {
      throw new EntitlementError("authentication_required", "A valid Hatch session is required.");
    }
    const entitlement = await entitlementResolver.resolve({ authToken, licenseToken: authToken, entitlementId, signal });
    assertEntitlementMatchesIdentity(
      authIdentity ?? legacyAuthClaims(authToken, authIdentityResolver, legacyHmacAuth),
      entitlement
    );
    const creatorId = url.searchParams.get("creator_id");
    const agentId = url.searchParams.get("agent_id");
    if (creatorId !== entitlement.creator_id || agentId !== entitlement.agent_id) {
      throw new EntitlementError("agent_entitlement_mismatch", "Conversation history is outside the purchased Agent scope.");
    }
    const resolved = await agentCorpusResolver.resolve(entitlement.creator_id, entitlement.agent_id, signal);
    if (resolved.corpus.product.id !== entitlement.product_id || resolved.corpus.creator.id !== entitlement.creator_id) {
      throw new Error("Entitlement does not match its current Agent Corpus");
    }
    return {
      creatorId: entitlement.creator_id,
      userId: entitlement.user_id,
      agentId: entitlement.agent_id,
      productId: entitlement.product_id,
      corpusDigest: resolved.digest,
      entitlementId: entitlement.entitlement_id,
      orderId: entitlement.order_id,
      agentCorpus: resolved.corpus,
      agentCorpusRoot: resolved.root,
      explicit: true
    };
  }

  // Self-reported scope is accepted only when no product resolver is configured.
  // This keeps resolver-free local development usable without creating a
  // production authorization bypass.
  const value = (name: string): string | undefined => url.searchParams.get(name) ?? (typeof req.headers[`x-hatch-${name.replaceAll("_", "-")}`] === "string" ? String(req.headers[`x-hatch-${name.replaceAll("_", "-")}`]) : undefined);
  const [creatorId, userId, agentId, productId, corpusDigestValue] = [value("creator_id"), value("user_id"), value("agent_id"), value("product_id"), value("corpus_digest")];
  if (!creatorId || !userId || !agentId || !productId || !corpusDigestValue || !/^sha256:[a-f0-9]{64}$/.test(corpusDigestValue)) return undefined;
  return { creatorId, userId, agentId, productId, corpusDigest: corpusDigestValue, explicit: true };
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function deliveryBindingFromSession(binding: SessionBinding): DeliveryBinding | undefined {
  if (!binding.entitlementId || !binding.orderId) return undefined;
  return {
    entitlementId: binding.entitlementId,
    orderId: binding.orderId,
    userId: binding.userId,
    creatorId: binding.creatorId,
    agentId: binding.agentId,
    productId: binding.productId,
    corpusDigest: binding.corpusDigest
  };
}

function sanitizeBoundHistory(messages: Awaited<ReturnType<RuntimeStore["readVisibleConversation"]>>, agentId: string): Awaited<ReturnType<RuntimeStore["readVisibleConversation"]>> {
  return messages.map((message) => ({
    ...message,
    ...(message.skill_events ? {
      skill_events: message.skill_events.map((event) => ({
        ...event,
        path: `agent://${encodeURIComponent(agentId)}/protected-skill/${encodeURIComponent(event.name)}`,
        resource_paths: event.resource_paths ? [] : undefined,
        resource_manifest_truncated: event.resource_manifest_truncated === undefined ? undefined : false,
        trigger: event.trigger ? { ...event.trigger, path: event.trigger.path ? "agent://private" : undefined } : undefined
      }))
    } : {}),
    ...(message.tool_calls ? {
      tool_calls: message.tool_calls.map((tool) => tool.locality === "server" && /^file[._]/.test(tool.name)
        ? { ...tool, arguments: {}, result: tool.result === undefined ? undefined : { private_result_redacted: true } }
        : tool)
    } : {})
  }));
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

async function persistSkillEvent(
  event: OutboundMessage,
  input: RunStart,
  store: RuntimeStore
): Promise<void> {
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
    locality: event.locality,
    approval: event.approval,
    ...(event.result ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {})
  });
}

async function compactIfNeeded(
  input: RunStart,
  store: RuntimeStore,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>,
  messages: RuntimeCompactionMessage[],
  phase: "pre_turn" | "mid_turn"
): Promise<CompactionCheckpoint | undefined> {
  if (!shouldAutoCompactMessages(messages)) {
    return undefined;
  }
  return compactAndEmit(input, store, state, send, messages, {
    trigger: "auto",
    phase,
    reason: "context_limit"
  });
}

async function compactAndEmit(
  input: RunStart,
  store: RuntimeStore,
  state: RunStateMachine,
  send: (message: OutboundMessage) => Promise<void>,
  messages: RuntimeCompactionMessage[],
  options: {
    trigger: "auto" | "manual";
    phase: "pre_turn" | "mid_turn" | "standalone_turn";
    reason: "context_limit" | "user_requested";
  }
): Promise<CompactionCheckpoint> {
  await state.compact(options.phase);
  const checkpoint = await compactRuntimeMessages(messages, {
    ...options,
    windowState: await store.readCompactionState(input.conversation_id)
  });
  await store.append({
    type: "conversation.compacted",
    conversation_id: input.conversation_id,
    run_id: input.run_id,
    ...checkpoint
  });
  await send({
    type: "session.compacted",
    run_id: input.run_id,
    ...checkpoint
  });
  await state.start();
  return checkpoint;
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8400);
  const host = process.env.HATCH_RUNTIME_HOST?.trim() || "127.0.0.1";
  void createRuntimeServerFromEnvironment().then((runtimeServer) => {
    runtimeServer.server.listen(port, host, () => {
      const commerce = process.env.HATCH_COMMERCE_LEDGER_FILE ? " with commerce ledger" : "";
      console.log(`Hatch TS runtime listening on ws://${host}:${port}/runtime${commerce}`);
    });
  }).catch((error: unknown) => {
    console.error("Unable to start Hatch Runtime:", error);
    process.exitCode = 1;
  });
}
