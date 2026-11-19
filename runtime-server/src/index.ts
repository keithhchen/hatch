import "dotenv/config";

import { randomUUID } from "node:crypto";
import http from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { createAgentRuntime, type AgentRuntime, type RuntimeSessionSkills } from "./agentRuntime.js";
import { InMemoryModelRoleResolver, PostgresModelRoleResolver, type ModelRoleResolver } from "./modelRoles.js";
import { MAX_RICH_TOOL_RESULT_BYTES } from "./protocol.js";
import { failures } from "./errors/failures.js";
import { PostgresFailureLedger } from "./errors/postgresFailureLedger.js";
import { ServerToolExecutor } from "./serverTools.js";
import { RuntimeStore } from "./store.js";
import { PostgresStore } from "./postgresStore.js";
import {
  InMemoryConversationRepository,
  PostgresConversationRepository,
  type ConversationRecord,
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
import { creatorToolControlPlaneFromEnvironment, resolveCreatorTools, type CreatorToolControlPlane } from "./creatorTools.js";
import { AgentCorpusResolver as FilesystemAgentCorpusResolver, type AgentCorpusResolverLike } from "./agentCorpus.js";
import { RuntimeReleaseAgentCorpusResolver } from "./runtimeCorpusResolver.js";
import {
  discoverSkills,
  includeSkillInstructions,
  renderSkillsSection,
  visibleSkillsForSession
} from "./skills.js";
import { briefAccessCode, briefAnswer, briefEmail, type BriefSpec } from "./brief.js";
import { readCorpusEmailTemplate } from "./agentBox/reportEmail.js";
import type { ReportEmailContext } from "./agentBox/tools.js";
import { createOutputGuardFromEnvironment, PassThroughOutputGuard, type OutputGuard } from "./outputGuard.js";
import { RuntimeAssetStore, runtimeAssetStoreFromEnvironment } from "./assetStore.js";
import { flushLangfuseObservability, initializeLangfuseObservability } from "./langfuse.js";
import { ChatRuntime, type ChatRuntimeOptions } from "./chat/chatRuntime.js";
import { PostgresEventRelay } from "./chat/eventRelay.js";
import { PostgresStopRelay } from "./chat/stopRelay.js";
import { ChatError, principalKey } from "./chat/principal.js";
import { GuestAwareIdentityResolver, GuestTokens } from "./guestToken.js";
import { GuestCarryOver, HttpLibrary, RetryingLibrary, type Library } from "./chat/library.js";
import type { PrincipalLimits, RunAdmission } from "./chat/chatService.js";
import { ContactBinder, SentMessageLimits, type ConnectionDirectory } from "./chat/contactBinding.js";
import { SelfBinder } from "./chat/selfBinding.js";
import type { ChatGateway } from "./chat/gateway.js";
import { checkUpgrade } from "./chat/originPolicy.js";
import { ServiceChatGateway } from "./chat/serviceGateway.js";
import { ChatServiceApi } from "./chat/serviceApi.js";
import { ChatAssets, TextPartsReader, type PartsReader } from "./chat/assets.js";
import { accountPrincipal } from "./chat/principal.js";
import { RestartRetrier } from "./chat/restartRetry.js";
import { TASK_START_MESSAGE_CONTENT, clientMessageInputDigest } from "./protocol.js";
import { CodePages } from "./codePages/codePages.js";
import { ArtifactRetrier } from "./artifact/retrier.js";
import { ARTIFACT_FULL_MESSAGE, ARTIFACT_RETRY_MESSAGE } from "./artifact/prompt.js";
import { openArtifactMode } from "./artifact/open.js";
import { ConversationTitles, type TitleModel } from "./chat/conversationTitles.js";
import { roleTitleModel } from "./chat/titleModel.js";
import { FilePrompts, PostgresPrompts } from "./prompts.js";
import { REPORT_CONTEXT_BUDGET, type ArtifactMode } from "./artifact/mode.js";
import type { ReportRecord } from "./artifact/ports.js";
import { artifactToolDefinitions } from "./artifact/toolDefinitions.js";
import { ChromiumReportRenderer } from "./artifact/chromiumRenderer.js";
import { chatCompactionStrategy } from "./compaction.js";
import { configuredSearch } from "./factoryAgents/search.js";
import { attachmentToolDefinitions } from "./chat/attachmentTools.js";
import { failRun, runModelTurn } from "./chat/modelTurn.js";
import { toolRegistry } from "./tools.js";
import { attributeByScope, monthlyTokenCap, payerByScope, type UsageReader, type UsageRecorder } from "./usage/usage.js";
import { UsageCap } from "./usage/usageCap.js";
import { createProductAnalytics, type ProductAnalytics } from "./analytics/index.js";
import { ChatAnalytics } from "./chat/chatAnalytics.js";
import { PostgresUsageLedger } from "./usage/postgresUsage.js";
import { RegistryConnectionDirectory } from "./chat/registryConnections.js";
import { openChatAssets } from "./chat/openChatAssets.js";
import { openAgentBoxMode } from "./agentBox/open.js";
import { AccessGate } from "./accessGate.js";
import { PostgresProductCapabilities, type ProductCapabilities } from "./agentBox/capabilities.js";
import { DeliverableFollowups } from "./chat/deliverableFollowup.js";
import { BOX_TOOL_CALL_LIMIT, type AgentBoxMode } from "./agentBox/tools.js";
import type { HtmlPages } from "./agentBox/htmlPages.js";
import { briefContactOf, type ContactOf, type ReportLeads } from "./agentBox/reportLeads.js";
import type { BuyerFiles } from "./agentBox/files.js";
import { openHatchPay } from "./hatchPay/open.js";
import type { HatchPay } from "./hatchPay/routes.js";
import type { AccessCodes } from "./accessCodes/accessCodes.js";
import { openSiteResearchMode } from "./siteTools/open.js";
import type { SiteResearchMode } from "./siteTools/tools.js";
import { GUEST_PREFIX } from "./chat/principal.js";
import { objectStoreFromEnvironment } from "./creatorLearning/objectStore.js";
import { MAX_CONSUMER_BUFFERED_BYTES } from "./chat/sinks.js";
import { productRequiresLocalTools } from "./chat/toolSurface.js";
import type { ScopeResolver, TurnRunner } from "./chat/turnExecutor.js";
import { KIMI_HOSTED_ENGINE_CAPABILITY, SwitchedEngine } from "./chat/runEngine.js";
import { KimiHostedEngine } from "./kimiHosted/engine.js";
import { HtmlPagesPublisher, openKimiHostedMode, type KimiHostedMode } from "./kimiHosted/open.js";
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
  type LegacyHmacAuth,
  type SessionBinding
} from "./chat/sessionBinding.js";
import type { ChatEdge } from "./chat/turnSubmission.js";
import { bearerToken, handleHttpRequestFailure, httpDeadlineMs, writeJson } from "./http/httpSupport.js";
import { handleHttpRequest, type RuntimeReadiness } from "./http/runtimeRouter.js";
import { DEFAULT_ACCOUNT_FILES_QUOTA_BYTES, PostgresAccountFiles } from "./responses/accountFiles.js";
import { ResponsesHttpApi } from "./responses/router.js";
import { handleRuntimeSocket } from "./ws/runtimeSocket.js";

// The Runtime's public surface stays here: callers import these from index.js.
export { clientToolTimeoutMs, legacyHmacAuthEnabled, runtimeClientHelloTimeoutMs } from "./runtimeConfig.js";
export {
  durableConversationId, privateBoundaryProjection, protectPrivateAgentBoundary
} from "./chat/sessionBinding.js";

type AgentCorpusResolver = AgentCorpusResolverLike;

export type RuntimeServer = {
  server: http.Server;
  wss: WebSocketServer;
  /** What the channel layer calls to talk to the Chat API without a transport. */
  chat: ChatGateway;
  close: () => Promise<void>;
  /** Looks now for Runs a restart interrupted and starts their retries (otherwise done on a timer). */
  retryInterrupted: () => Promise<void>;
  /** Leaves production traffic to the next instance: unready, stop intake, finish the Runs held, then close. */
  shutdown: (deadlineMs: number) => Promise<{ drained: boolean }>;
};

// A rich asset is base64-encoded on the client-to-Runtime frame. The protocol
// keeps one asset/message at 100 MiB; 160 MiB leaves room for the ~133 MiB
// base64 body, structured metadata, and a rich local-tool result envelope.
export const MAX_RUNTIME_WEBSOCKET_PAYLOAD_BYTES = MAX_RICH_TOOL_RESULT_BYTES;

/** The longest shutdown waits to send the events still queued. */
const ANALYTICS_FLUSH_MS = 3_000;

export type RuntimeServerOptions = {
  /** Where each role's model is chosen. Defaults to the Runtime database's `hatch_model_roles`, or the seed choices without one. */
  models?: ModelRoleResolver;
  createRuntime?: () => AgentRuntime;
  /** Writes a conversation's title; tests inject one. By default the model of the `title` role. */
  titleModel?: TitleModel;
  /** Chat's compaction strategy; tests inject one with a test-only summarizer. */
  compactionStrategy?: ChatRuntimeOptions<SessionBinding>["compactionStrategy"];
  conversationStore?: RuntimeStore;
  /** Where model calls are recorded for the account that pays for them. Without one nothing is metered. */
  usage?: UsageRecorder;
  /** Refuses a new Run, on any surface, when the account that pays for it has spent its month. Without one nothing is capped. */
  usageCap?: UsageCap;
  /** Product analytics: buyer messages and failed replies. Without one nothing is sent. */
  analytics?: ProductAnalytics;
  /** Optional injected store for tests; production defaults beside transcripts. */
  assetStore?: RuntimeAssetStore;
  /** Durable Conversation/Run control-plane. Defaults to Postgres or local app-data. */
  conversationRepository?: ConversationRepository;
  entitlementResolver?: EntitlementResolver;
  /** Signs the guests the Dashboard issues; without it nobody chats without an account. */
  guestTokens?: GuestTokens;
  /** Where an Agent is saved when an account chats with it. */
  library?: Library;
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
  /** How often Runs a restart interrupted are looked for, to be answered again. */
  restartRetryPollMs?: number;
  /** The channel layer's Connections, which a customer's messages arrive through. */
  connectionDirectory?: ConnectionDirectory;
  /** Uploads, attachments in messages, and the ls/grep/read tools over them. Without it a message takes text only. */
  chatAssets?: ChatAssets;
  /** Report mode: products that offer it, and conversations that are reports. */
  artifact?: ArtifactMode;
  /** The Agent's own computer and the pages it publishes, for the Products that have it. */
  agentBox?: { mode: AgentBoxMode; pages: HtmlPages; files: BuyerFiles; origin?: string; reportLeads?: (contactOf: ContactOf) => ReportLeads };
  /** Site research tools (page speed, places, IP and URL lookups), for the Products that have them. */
  siteResearch?: SiteResearchMode;
  /** The Products with the engine_kimi_hosted row run on Kimi Hosted Agents. */
  kimiHosted?: KimiHostedMode;
  /** Products with the `access_code` capability take a Run only for a conversation that redeemed the Brief's code. */
  accessGate?: AccessGate;
  /** Which Products have which capabilities; with it, `deliverable_html` Products are followed up until they publish an HTML report. */
  productCapabilities?: ProductCapabilities;
  /** Access codes (redeemed when a chat starts) and the WeChat Pay pages that sell them (/hatch-pay/). */
  accessCodes?: AccessCodes;
  /** The same codes as one client sees them (rate-limited by its address): the chat start redeems and looks up through this, answering a TooManyAttempts with its 429. */
  accessCodesFor?: (headers: http.IncomingHttpHeaders) => AccessCodes;
  hatchPay?: HatchPay;
  /** The token the channel layer presents to reach Chat from another process; without it that door stays shut. */
  chatServiceToken?: string;
  /** Pending and active runs admitted for one authenticated user. */
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
  /** Test seams of the Responses API: how URLs are fetched, how long a request is held, the keep-alive interval. */
  responsesApi?: Pick<ConstructorParameters<typeof ResponsesHttpApi>[0], "urls" | "accountFiles" | "features" | "holdMs" | "keepAliveMs">;
};

/** Where a conversation's report is mailed, from its Brief's email answer, and what the mail says; undefined when the Brief has none. */
export async function reportEmailContext(conversation: ConversationRecord, binding: SessionBinding, origin = "https://gethatchapp.com"): Promise<ReportEmailContext | undefined> {
  const recipient = briefEmail(conversation.briefSnapshot);
  if (!recipient) return undefined;
  const expert = binding.agentCorpus?.creator.name;
  // The code's own page is where the report is found again: the mail carries it, with the code.
  const code = briefAccessCode(conversation.briefSnapshot);
  return {
    recipient,
    chatUrl: `${origin}/chat/product/${binding.productId}/conversation/${conversation.publicId}`,
    ...code ? { code, codeUrl: `${origin}/c/${encodeURIComponent(code)}` } : {},
    productName: binding.agentCorpus?.product.name ?? "Hatch",
    ...expert && expert !== "Expert" ? { expertName: expert } : {},
    ...briefAnswer(conversation.briefSnapshot, "name") ? { name: briefAnswer(conversation.briefSnapshot, "name")! } : {},
    ...briefAnswer(conversation.briefSnapshot, "website") ? { website: briefAnswer(conversation.briefSnapshot, "website")! } : {},
    ...(template => template ? { template } : {})(await readCorpusEmailTemplate(binding.agentCorpusRoot))
  };
}

/** The report email is for the Products with the access code capability only: any other Product mails nothing. */
export async function gatedReportEmailContext(gate: Pick<AccessGate, "required"> | undefined, conversation: ConversationRecord, binding: SessionBinding, origin?: string): Promise<ReportEmailContext | undefined> {
  return await gate?.required(binding.productId) ? reportEmailContext(conversation, binding, origin) : undefined;
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
  // Guest ids are signed with their own secret, shared by the Dashboard and the Runtime; the library is reached with the Commerce service token.
  const guestSecret = environment.HATCH_GUEST_TOKEN_SECRET?.trim();
  const commerceServiceToken = environment.HATCH_COMMERCE_RUNTIME_SERVICE_TOKEN?.trim();
  const entitlementFile = environment.HATCH_ENTITLEMENTS_FILE?.trim();
  const fileEntitlements = config.legacyHmacEnabled && entitlementFile
    ? new FileEntitlementResolver(entitlementFile, {
      enableLegacyHmacAuth: true,
      hmacSecret: config.legacyHmacSecret!
    })
    : undefined;
  const analytics = createProductAnalytics(environment);
  const conversationStore = createConversationStore(environment);
  // Attachments need records that outlive a restart: without a Runtime database a message takes text only.
  const chatBlobs = conversationStore instanceof PostgresStore ? objectStoreFromEnvironment(environment, path.join(runtimeDataDir, "chat-assets"))! : undefined;
  const chatAssets = conversationStore instanceof PostgresStore
    ? await openChatAssets({ pool: conversationStore.pool, blobs: chatBlobs!, environment })
    : undefined;
  // Report files live beside chat assets. The hosted renderer says "not configured" itself when it has no key.
  const artifact = conversationStore instanceof PostgresStore && chatAssets
    ? await openArtifactMode({ pool: conversationStore.pool, blobs: chatBlobs!, assets: chatAssets, renderer: new ChromiumReportRenderer(), analytics, search: configuredSearch(environment) })
    : undefined;
  // The Agent's own computer, for the Products that have it switched on: off without a BoxLite key.
  const agentBox = conversationStore instanceof PostgresStore ? await openAgentBoxMode({ pool: conversationStore.pool, blobs: chatBlobs!, environment }) : undefined;
  // Site research, for the Products that have it switched on: off without any of its keys.
  const siteResearch = conversationStore instanceof PostgresStore ? await openSiteResearchMode({ pool: conversationStore.pool, environment }) : undefined;
  // The Products that run on Kimi Hosted Agents, by a row: the others are not touched.
  const kimiHosted = conversationStore instanceof PostgresStore ? await openKimiHostedMode({ pool: conversationStore.pool, environment }) : undefined;
  const productCapabilities = conversationStore instanceof PostgresStore ? new PostgresProductCapabilities(conversationStore.pool) : undefined;
  await productCapabilities?.initialize();
  const agentCorpusResolver = runtimeRegistryToken && registryUrl
      ? new RuntimeReleaseAgentCorpusResolver({
        registryUrl,
        serviceToken: runtimeRegistryToken,
        corpusRoot: runtimeCorpusRoot || path.join(runtimeDataDir, "corpora"),
        timeoutMs: registryAuthorizationTimeoutMs(environment)
      })
      : runtimeCorpusRoot
        ? new FilesystemAgentCorpusResolver(runtimeCorpusRoot)
        : undefined;
  // Access codes and, when fully configured, WeChat Pay.
  const hatchPay = conversationStore instanceof PostgresStore ? await openHatchPay({ pool: conversationStore.pool, environment, ...agentCorpusResolver ? { corpora: agentCorpusResolver } : {} }) : undefined;
  // The access code gate reads the codes through the limiter that counts a client's failed attempts by its address.
  const accessGate = productCapabilities ? new AccessGate(productCapabilities, hatchPay ? (headers) => hatchPay.accessCodesFor(headers ?? {}) : undefined) : undefined;
  // The Files API stores an account's files in the same database; without one it answers 501.
  const accountFiles = conversationStore instanceof PostgresStore ? new PostgresAccountFiles(conversationStore.pool as never, Number(environment.HATCH_ACCOUNT_FILES_QUOTA_BYTES) || DEFAULT_ACCOUNT_FILES_QUOTA_BYTES) : undefined;
  await accountFiles?.initialize();
  return createRuntimeServer({
    outputGuard: createOutputGuardFromEnvironment(environment),
    creatorToolControlPlane: creatorToolControlPlaneFromEnvironment(environment),
    entitlementResolver: registryAuth ?? fileEntitlements,
    ...(guestSecret ? { guestTokens: new GuestTokens(guestSecret) } : {}),
    ...(commerceServiceToken && environment.HATCH_COMMERCE_URL?.trim() ? { library: new HttpLibrary(environment.HATCH_COMMERCE_URL.trim(), commerceServiceToken) } : {}),
    insecureLocalMode: config.insecureLocalMode,
    authIdentityResolver: registryAuth,
    agentCorpusResolver,
    conversationStore,
    analytics,
    ...(conversationStore instanceof PostgresStore ? (() => { const ledger = new PostgresUsageLedger(conversationStore.pool as never); return { usage: ledger, usageCap: new UsageCap(ledger, monthlyTokenCap(environment), { analytics }) }; })() : {}),
    ...(chatAssets ? { chatAssets } : {}),
    ...(artifact ? { artifact } : {}),
    ...(agentBox ? { agentBox } : {}),
    ...(siteResearch ? { siteResearch } : {}),
    ...(kimiHosted ? { kimiHosted } : {}),
    ...(accessGate ? { accessGate } : {}),
    ...(productCapabilities ? { productCapabilities } : {}),
    ...(hatchPay ? { accessCodes: hatchPay.codes, accessCodesFor: hatchPay.accessCodesFor, ...hatchPay.pay ? { hatchPay: hatchPay.pay } : {} } : {}),
    /** Image and file input and the Files API are built but not public yet. */
    responsesApi: { ...(accountFiles ? { accountFiles } : {}), features: { attachments: environment.HATCH_RESPONSES_ATTACHMENTS === "on" } },
    assetStore: runtimeAssetStoreFromEnvironment(environment, runtimeDataDir),
    chatServiceToken: config.chatServiceToken,
    maxContactMessages: config.maxContactMessages,
    ...(registryUrl && runtimeRegistryToken ? { connectionDirectory: new RegistryConnectionDirectory({ registryUrl, serviceToken: runtimeRegistryToken, timeoutMs: registryAuthorizationTimeoutMs(environment) }) } : {}),
    clientToolTimeoutMs: config.clientToolTimeoutMs,
    clientHelloTimeoutMs: config.helloTimeoutMs,
    maxPendingTurnAuthorizations: config.maxPendingTurnAuthorizations,
    maxPendingTurnAuthorizationsPerUser: config.maxPendingTurnAuthorizationsPerUser,
    allowedOrigins: config.allowedOrigins,
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
  const unconfigured = !options.entitlementResolver && !options.agentCorpusResolver && options.insecureLocalMode !== true;
  const entitlementResolver = options.entitlementResolver;
  const accountIdentities = options.authIdentityResolver
    ?? (entitlementResolver instanceof RegistryEntitlementResolver ? entitlementResolver : undefined);
  // A guest is told apart by its signed token; every other token is an account's, and the Registry decides.
  const authIdentityResolver = accountIdentities && options.guestTokens
    ? new GuestAwareIdentityResolver(options.guestTokens, accountIdentities)
    : accountIdentities;
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
  // A report's price-tier clicks: the buyer is read from the Brief of the conversation the page's access code opened.
  const reportLeads = options.agentBox?.reportLeads?.(briefContactOf(options.accessCodes ?? { lookup: async () => null }, conversationRepository));
  const models = options.models ?? (conversationStore instanceof PostgresStore ? new PostgresModelRoleResolver(conversationStore.pool) : new InMemoryModelRoleResolver());
  const createRuntime = options.createRuntime ?? (() => createAgentRuntime(models));
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
  const repositoryReady = conversationRepository.initialize();
  const readiness: RuntimeReadiness = {
    repository: "starting"
  };
  void repositoryReady.then(
    () => { readiness.repository = "ready"; },
    () => { readiness.repository = "failed"; }
  );
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
  const artifact = options.artifact;
  if (artifact) for (const definition of artifactToolDefinitions()) toolRegistry.set(definition.name, definition);
  const agentBox = options.agentBox;
  if (agentBox) for (const definition of agentBox.mode.definitions()) toolRegistry.set(definition.name, definition);
  if (options.siteResearch) for (const definition of options.siteResearch.definitions()) toolRegistry.set(definition.name, definition);
  const parts: PartsReader = chatAssets ?? new TextPartsReader();

  const admission: RunAdmission = {
    reserve(principal) {
      const releaseGlobal = activeRunGate.tryAcquire();
      if (!releaseGlobal) throw new ChatError("runtime_run_capacity", "Hatch is already running the maximum number of tasks. Try again shortly.", 503);
      // No per-account cap: one account may run as many tasks at once as the Runtime has room for.
      return once(releaseGlobal);
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
  const piEngine: TurnRunner<SessionBinding> = {
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
        // A report conversation sees its files flat and has the report tools; a chat conversation has neither.
        const report = await artifact?.turnFor(turn.conversation, turn.run);
        if (chatAssets) serverTools.setAttachments(chatAssets.toolsFor(turn.conversation, report ? "flat" : "messages"));
        if (report) { serverTools.setArtifact(report.tools); serverTools.observe(report.onTool); }
        const box = report ? undefined : await agentBox?.mode.turnFor({
          productId: binding.productId, userId: binding.userId, guest: binding.userId.startsWith(GUEST_PREFIX),
          email: await gatedReportEmailContext(options.accessGate, turn.conversation, binding, agentBox.origin)
        });
        serverTools.setBox(box?.tools);
        const site = report ? undefined : await options.siteResearch?.turnFor(binding.productId);
        serverTools.setSite(site?.tools);
        const productTools = [...box?.extraTools ?? [], ...site?.extraTools ?? []];
        const sessionSkills = await buildSessionSkills(binding.agentCorpusRoot, Boolean(box));
        await runModelTurn(
          turn.input, turn.persistedUser, sessionSkills, binding, turn.broker, serverTools,
          new ToolBridge(turn.broker, serverTools, () => turn.clientOf().client),
          createRuntime(), conversationStore, conversationRepository, assetStore, turn.state,
          async (message) => turn.publish(message), outputGuard, turn.signal,
          turn.clientOf, turn.claimSteered, turn.onSteer, turn.compaction,
          { usage: turn.usage, ...productTools.length ? { extraTools: productTools } : {}, ...box ? { toolCallLimit: BOX_TOOL_CALL_LIMIT } : {}, ...report ? { extraTools: report.extraTools, promptSuffix: report.promptSuffix, turnReminder: report.turnReminder, toolCallLimit: report.toolCallLimit } : {} }
        );
      } catch (error) {
        await failRun(turn, error);
      }
    }
  };
  // The one dispatch point of a Product Run: a Product with the engine_kimi_hosted row runs on Kimi Hosted Agents, every other one on piEngine as before.
  const kimiHosted = options.kimiHosted;
  const runner: TurnRunner<SessionBinding> = kimiHosted
    ? new SwitchedEngine<SessionBinding>({
      capabilities: kimiHosted.capabilities, capability: KIMI_HOSTED_ENGINE_CAPABILITY, standard: piEngine,
      alternative: new KimiHostedEngine<SessionBinding>({ api: kimiHosted.api, sessions: kimiHosted.sessions, store: conversationStore, publisher: agentBox && new HtmlPagesPublisher(agentBox.files, agentBox.pages) })
    })
    : piEngine;
  const chat = new ChatRuntime<SessionBinding>({
    repository: conversationRepository,
    store: conversationStore,
    runner,
    scopes,
    admission,
    limits: options.principalLimits ?? new SentMessageLimits(conversationRepository, options.maxContactMessages ?? DEFAULT_MAX_CONTACT_MESSAGES),
    toolTimeoutMs: options.clientToolTimeoutMs ?? clientToolTimeoutMs(),
    ...(options.compactionStrategy
      ? { compactionStrategy: options.compactionStrategy }
      : { compactionStrategy: async (conversationId: string) => {
        const profile = await models.resolve("chat", { productId: (await conversationRepository.getConversation(conversationId))?.productId });
        // A report conversation summarizes early: its notes file keeps what matters (see REPORT_CONTEXT_BUDGET).
        const report = artifact ? await artifact.reports.get(conversationId) : undefined;
        return chatCompactionStrategy(profile, report ? { budget: REPORT_CONTEXT_BUDGET } : {});
      } }),
    ...(options.usage ? { usage: { recorder: options.usage, attribute: attributeByScope } } : {}),
    ...(options.usageCap ? { cap: options.usageCap.guard(payerByScope) } : {}),
    ...(options.analytics ? { analytics: new ChatAnalytics(options.analytics, conversationRepository) } : {}),
    ...(options.library ? { library: new RetryingLibrary(options.library) } : {}),
    ...(artifact ? { artifacts: artifact.lifecycle } : {}),
    titles: new ConversationTitles({
      repository: conversationRepository, history: conversationStore,
      prompts: conversationStore instanceof PostgresStore ? new PostgresPrompts(conversationStore.pool) : new FilePrompts(),
      model: options.titleModel ?? roleTitleModel(models),
      skip: async conversationId => Boolean(await artifact?.reports.get(conversationId))
    }),
    afterInterrupted: (run) => { void restartRetrier.afterInterrupted(run); },
    afterReply: (run) => { void deliverableFollowups?.afterReply(run); },
    // With a shared database every instance sees every Run's live events.
    ...(conversationStore instanceof PostgresStore ? { relay: new PostgresEventRelay(conversationStore.pool as never), stops: new PostgresStopRelay(conversationStore.pool as never), steers: new PostgresStopRelay(conversationStore.pool as never, { channel: "hatch_run_steers" }) } : {})
  });
  // A restart is not the buyer's problem: the reply it interrupted is started again from their latest message (see RestartRetrier).
  const restartRetrier = new RestartRetrier({
    pollMs: options.restartRetryPollMs,
    repository: conversationRepository,
    skip: async (conversationId) => Boolean(await artifact?.reports.get(conversationId)),
    start: async (run, key, runId) => {
      const conversation = await conversationRepository.getConversation(run.conversationId);
      if (!conversation) throw new Error(`Conversation ${run.conversationId} was not found`);
      const scope = await scopes.resolve(conversation, new AbortController().signal);
      return chat.service.retry({
        principal: accountPrincipal(conversation.ownerAccountId), conversation, scope, client: { client: "web" },
        key, runId, corpusDigest: scope.corpusDigest, requiresLocalTools: false
      });
    }
  });
  // A Product that must end with an HTML report asks, in the conversation, for it when a Run ends without one.
  const deliverableFollowups = options.productCapabilities && agentBox ? new DeliverableFollowups({
    capabilities: options.productCapabilities, repository: conversationRepository,
    prompts: conversationStore instanceof PostgresStore ? new PostgresPrompts(conversationStore.pool) : new FilePrompts(),
    hasPage: async conversation => Boolean(await agentBox.pages.latestUrlSince(conversation.productId, conversation.ownerAccountId, new Date(conversation.createdAt))),
    start: async (conversation, key, content) => {
      const scope = await scopes.resolve(conversation, new AbortController().signal);
      return chat.service.submit({
        principal: accountPrincipal(conversation.ownerAccountId), conversation, scope, client: { client: "web" },
        clientMessageId: key, message: async () => ({ role: "user", content }), digest: clientMessageInputDigest({ content }),
        runId: `run_${randomUUID().replaceAll("-", "")}`, corpusDigest: scope.corpusDigest, requiresLocalTools: false, mode: "start_only"
      });
    }
  }) : undefined;
  // The page of an access code: its intake starts the Run of the Brief, its status reads that Run and the report.
  const codePages = options.accessGate && agentBox && agentCorpusResolver ? new CodePages({
    gate: options.accessGate, corpora: agentCorpusResolver, repository: conversationRepository, store: conversationStore,
    ...Number(process.env.HATCH_PAY_PRICE_FEN) > 0 ? { priceFen: Number(process.env.HATCH_PAY_PRICE_FEN) } : {},
    reportUrl: conversation => agentBox.pages.latestUrlSince(conversation.productId, conversation.ownerAccountId, new Date(conversation.createdAt)),
    start: async (conversation, key) => {
      const scope = await scopes.resolve(conversation, new AbortController().signal);
      return chat.service.submit({
        principal: accountPrincipal(conversation.ownerAccountId), conversation, scope, client: { client: "web" },
        clientMessageId: key, message: async () => ({ role: "user", content: TASK_START_MESSAGE_CONTENT, kind: "task_start" }),
        digest: clientMessageInputDigest({ content: "", task_start: true }), runId: `run_${randomUUID().replaceAll("-", "")}`,
        corpusDigest: scope.corpusDigest, requiresLocalTools: false
      });
    }
  }) : undefined;
  const startArtifactRun = async (record: ReportRecord, runId: string, content: string, clientMessageId: string) => {
    const conversation = await conversationRepository.getConversation(record.conversationId);
    if (!conversation) throw new Error(`Conversation ${record.conversationId} was not found`);
    const scope = await scopes.resolve(conversation, new AbortController().signal);
    await chat.service.submit({
      principal: accountPrincipal(conversation.ownerAccountId), conversation, scope, client: { client: "web" },
      clientMessageId, message: async () => ({ role: "user", content }), digest: clientMessageInputDigest({ content }),
      runId, corpusDigest: scope.corpusDigest, requiresLocalTools: false, mode: "start_only"
    });
  };
  if (artifact) artifact.startFullRun = (record, runId) => startArtifactRun(record, runId, ARTIFACT_FULL_MESSAGE, `artifact-full-${runId}`);
  // Nobody types again in a report conversation: an attempt that ended with no report (failure, restart) is started again.
  const artifactRetrier = artifact ? new ArtifactRetrier({
    reports: artifact.reports, lifecycle: artifact.lifecycle,
    start: (record, runId) => startArtifactRun(record, runId, ARTIFACT_RETRY_MESSAGE, `artifact-retry-${runId}`)
  }) : undefined;
  void repositoryReady.then(() => { void chat.start(); artifactRetrier?.start(); restartRetrier.start(); }).catch(() => undefined);
  const edge: ChatEdge = {
    chat, parts, chatAssets, turnAuthorizationGate, turnAuthorizationPerUserGate,
    entitlementResolver, authIdentityResolver, agentCorpusResolver,
    creatorToolControlPlane: options.creatorToolControlPlane,
    ...(options.accessGate ? { accessGate: options.accessGate } : {}),
    consumerBufferedBytes: options.maxConsumerBufferedBytes ?? MAX_CONSUMER_BUFFERED_BYTES
  };
  const gateway = chatGatewayFor(options, chat, scopes, conversationRepository, conversationStore, agentCorpusResolver, parts, chatAssets);
  edge.serviceApi = new ChatServiceApi({ token: options.chatServiceToken, gateway });
  const responses = new ResponsesHttpApi({
    repository: conversationRepository, store: conversationStore, edge,
    corpora: agentCorpusResolver, identities: authIdentityResolver, ready: repositoryReady,
    ...(options.usage && "forRun" in options.usage ? { usage: options.usage as unknown as Pick<UsageReader, "forRun"> } : {}),
    ...(options.responsesApi ?? {})
  });

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
      responses,
      readiness,
      allowedOrigins,
      artifact,
      htmlPages: agentBox?.pages,
      reportLeads,
      hatchPay: options.hatchPay,
      codePages,
      buyerFiles: agentBox?.files,
      guests: options.guestTokens,
      ...(options.library ? { carryOver: new GuestCarryOver({ repository: conversationRepository, library: options.library }) } : {})
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
    close: () => close(),
    retryInterrupted: () => restartRetrier.tick()
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
    artifactRetrier?.stop();
    restartRetrier.stop();
    await chat.stop();
    await conversationStore.close();
    await conversationRepository.close();
    await flushLangfuseObservability();
    await options.analytics?.shutdown(ANALYTICS_FLUSH_MS);
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
        },
        async restart(principal, ref, key) {
          if (principal.kind !== "contact" || !contactBinder) return unavailable("Customer");
          return contactBinder.restart(principal, ref, key);
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
        },
        async restart(principal, ref, key) {
          if (principal.kind !== "account" || !selfBinder) return unavailable("Self-use");
          return selfBinder.restart(principal.accountId, ref, key);
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

export async function buildSessionSkills(corpusRoot?: string, hasBox = false): Promise<RuntimeSessionSkills> {
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
    // The platform's document Skills run scripts on the Runtime host, which a box turn cannot reach.
    : hasBox ? [] : await discoverSkills();
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
      console.log(`Hatch TS runtime listening on ws://${host}:${port}/runtime`);
    });
  }).catch((error: unknown) => {
    log.error("runtime_startup_failed", { error });
    process.exitCode = 1;
  });
}
