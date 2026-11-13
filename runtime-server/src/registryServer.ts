import { HistoryCursorError } from "./conversationHistory.js";
import { FactoryAgentsService } from "./factoryAgents/service.js";
import { PostgresAgentDefinitionRepository } from "./factoryAgents/definitions.js";
import { PostgresWorkbenchBackend } from "./factoryAgents/store.js";
import { FirecrawlSearchProvider } from "./factoryAgents/webProviders.js";
import { AssistantService, assistantPrompt } from "./assistant/assistant.js";
import { AssistantChat } from "./assistant/chat.js";
import { InMemoryUsageLedger } from "./usage/memoryUsage.js";
import { PostgresUsageLedger } from "./usage/postgresUsage.js";
import { monthlyTokenCap, usageReport, utcDay, type UsageReader } from "./usage/usage.js";
import { UsageCap } from "./usage/usageCap.js";
import { studioTools, studioToolDefinitions } from "./assistant/studioTools.js";
import { LegacyAssistantHistory } from "./assistant/history.js";
import { PostgresAssistantState } from "./assistant/state.js";
import { PostgresDeliveries } from "./assistant/deliveries.js";
import { ExpertMaterials } from "./assistant/materials.js";
import { PostgresStore } from "./postgresStore.js";
import { PostgresConversationRepository } from "./conversationRepository.js";
import { RuntimeAssetStore } from "./assetStore.js";
import { openChatAssets } from "./chat/openChatAssets.js";
import { attachmentToolDefinitions } from "./chat/attachmentTools.js";
import { ChatError } from "./chat/principal.js";
import { toolRegistry } from "./tools.js";
import { RoutedChatGateway } from "./channels/routedGateway.js";
import { follow, resumePoint } from "./conversations/follow.js";
import { ConversationError } from "./conversations/conversation.js";
import { failures } from "./errors/failures.js";
import { UpstreamError } from "./errors/upstream.js";
import { Dictation } from "./assets/dictation.js";
import { FfmpegAudioNormalizer, transcriberFromEnvironment } from "./assets/adapters.js";
import { AssetError } from "./assets/domain.js";
import { VoiceProcessor } from "./assets/processors.js";
import { PostgresFailureLedger } from "./errors/postgresFailureLedger.js";
import { ConversationRoutes, keyOrNew, type ConversationRouteDeps } from "./conversations/routes.js";
import { EventLogJournal } from "./conversations/journal.js";
import { openProductAssets } from "./conversations/productAssets.js";
import { openConversationPorts, type ConversationPorts } from "./conversations/ports.js";
import { Studio, type StudioDeps } from "./conversations/studio.js";
import { StudioSockets, STUDIO_SOCKET_PATH } from "./conversations/socket.js";
import { createIngestService } from "./ingest/boot.js";
import { InflightResponses, drainMsFromEnvironment, exitOnSignal, gracefulShutdown } from "./gracefulShutdown.js";
import { INGEST_BODY_MAX_BYTES, IngestError, IngestService } from "./ingest/service.js";
import { publicJob } from "./ingest/job.js";
import { IdempotencyKeyReused, idempotencyKey } from "./idempotency.js";
import { AccountReach, validTimezone } from "./assistant/reach.js";
import { StudioPanel } from "./conversations/panel.js";
import { AssistantTarget } from "./assistant/assistantTarget.js";
import { CHANNEL_KINDS, CHANNEL_LABELS, isChannelKind, type ChannelAdapter, type ChannelKind } from "./channels/types.js";
import { ChannelListeners } from "./channels/listeners.js";
import { CredentialRefresher } from "./channels/credentialRefresh.js";
import { ChannelHub } from "./channels/hub.js";
import { ChannelService } from "./channels/service.js";
import { GuardedTarget, liveOwnProduct } from "./channels/guardedTarget.js";
import { ChatFlow } from "./channels/chatTarget.js";
import { ProductTarget } from "./channels/productTarget.js";
import { HttpChatGateway } from "./channels/runtimeChat.js";
import { safeError } from "./factoryAgents/runtime.js";
import { CredentialSeal } from "./assistant/channelCredentials.js";
import { IMessageChannel } from "./channels/imessageChannel.js";
import { CREDENTIAL_FORMS, isPerProduct, isTenantForm, readCredentials } from "./channels/credentialForms.js";
import { LineChannel } from "./channels/lineChannel.js";
import { guarded } from "./channels/eligibility.js";
import { STUDIO_TARGET } from "./channels/connections.js";
import { openChannelStores } from "./channels/postgres/stores.js";
import type { AgentTarget } from "./surfaces/contract.js";
import { InstagramChannel } from "./channels/instagramChannel.js";
import { MessengerChannel } from "./channels/messengerChannel.js";
import { SlackChannel } from "./channels/slackChannel.js";
import { sealedTokens } from "./channels/tenantTokens.js";
import { WhatsAppChannel, whatsappEligibility } from "./channels/whatsappChannel.js";
import { TelegramChannel } from "./channels/telegramChannel.js";
import { OwnApps } from "./channels/ownApps.js";
import { LoginError, OidcClient } from "./auth/oidc.js";
import { DiscordIdentity, lineIdentity, lineOidc, telegramIdentity, telegramOidc } from "./auth/identities.js";
import { PlatformLogin, PostgresLoginStore, type IdentityProvider } from "./auth/platformLogin.js";
import { DiscordChannel } from "./channels/discordChannel.js";
import { PostgresTaskRepository } from "./assistant/tasks.js";
import type { AgentCatalog, AgentChange, CatalogAgent } from "./assistant/catalog.js";
import "dotenv/config";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { URL } from "node:url";
import {
  TrustedProxyPolicy,
  authRequestSourceIp,
  authTrustedProxyPolicyFromEnvironment
} from "./trustedProxy.js";
import {
  AccountStoreTs,
  PasswordHasher,
  PasswordWorkCapacityError,
  accountPublic,
  passwordWorkOptionsFromEnvironment,
  validateSigninCredentials,
  validateSignupCredentials,
  verifyAuthToken,
  type Account,
  type AuthenticatedSession
} from "./registryAuth.js";
import { RegistryStoreTs } from "./registryStore.js";
import { RegistryDeploymentConflictError } from "./registryStore.js";
import { BriefValidationError, normalizeBriefSpec, type BriefSpec } from "./brief.js";
import { ProductPricingError, type ProductPricing } from "./creatorLearning/pricing.js";
import { handleCreatorFactoryHttp } from "./creatorLearning/httpApi.js";
import { isUuidV4 } from "./identity.js";
import {
  CreatorFactoryRepositoryError,
  InMemoryCreatorFactoryRepository,
  PostgresCreatorFactoryRepository,
  type CreatorFactoryRepository
} from "./creatorLearning/repository.js";
import { CreatorFactoryService } from "./creatorLearning/service.js";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { factoryModelRecord, factoryPromptRunner } from "./creatorLearning/piGateway.js";
import { InMemoryModelRoleResolver, PostgresModelRoleResolver } from "./modelRoles.js";
import { createHatchCliCandidateExecutor } from "./creatorLearning/cliCandidateExecutor.js";
import { CreatorFactoryWorker } from "./creatorLearning/worker.js";
import type { CreatorProductRecord } from "./creatorLearning/products.js";
import { objectStoreFromEnvironment } from "./creatorLearning/objectStore.js";
import { ProductFileStore, ProductFilesError, type ProductFileView } from "./creatorLearning/productFiles.js";
import { NodeRuntime } from "./nodeRuntime.js";
import { PostgresNodeStore } from "./nodeSession.js";
import {
  FactoryNodeService,
  FactoryNodeServiceError,
  type FactoryNodeExecutionView,
  type FactoryNodeRunView
} from "./creatorLearning/nodeService.js";
import type { AboutYouAnswerPair } from "./creatorLearning/aboutYouNode.js";
import { PostgresDistillationGraphStore } from "./creatorLearning/distillationGraphStore.js";
import { CorpusPublisher, CorpusPublishError } from "./creatorLearning/corpusPublisher.js";
import { imageMime } from "./factoryAgents/imageRefs.js";
import { createProductLive, ExpertProduct, SystemMissing, type ProductLiveService } from "./creatorLearning/productLive/index.js";
import { CreatorRegistryReleaseStore, type CreatorRegistryRelease } from "./creatorLearning/creatorRegistryRelease.js";
import { corpusOutputSchema } from "./creatorLearning/corpusNode.js";
import { flushLangfuseObservability, initializeLangfuseObservability } from "./langfuse.js";
import { accountAvatarApplicationServiceFromEnvironment, MAX_ACCOUNT_AVATAR_BYTES } from "./accountAvatar.js";
import {
  httpRequestLimitOptionsFromEnvironment,
} from "./registryRequestLimits.js";
import { bindContext, currentContext } from "./observability/context.js";
import { startObservability } from "./observability/start.js";
import { observed } from "./observability/http.js";
import { log } from "./observability/log.js";

export type RegistryServer = {
  server: http.Server;
  close: () => Promise<void>;
  /** Leaves production traffic to the next instance: unready, stop intake, finish what is held, then close. */
  shutdown: (deadlineMs: number) => Promise<{ drained: boolean }>;
};
export const CREATOR_FACTORY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;
type RegistryContext = {
  conversationPorts: ConversationPorts;
  /** What every Expert has spent, and the monthly cap if one is set. */
  usage: UsageReader;
  monthlyTokenCap: number | null;
  /** Attachments for Studio; with the Registry database. */
  studioAssets?: StudioDeps["assets"];
  assistant?: AssistantService;
  /** The Assistant's conversation, on Chat's runtime. */
  assistantChat?: AssistantChat;
  /** What the Assistant's conversation reads and writes: made here, so closed here once the conversation has stopped. */
  assistantStorage?: Array<{ close(): Promise<void> }>;
  /** Speech to text for the composers of Studio and web chat. */
  dictation: Dictation;
  ingest?: IngestService;
  /** Set once shutdown begins: readiness fails so the proxy sends nothing new. */
  draining?: boolean;
  channels?: ChannelService;
  /** Why Product channels cannot handle messages, when they cannot. Absent: they can, or are deliberately off. */
  productChannelsUnavailable?: string;
  credentialSeal?: CredentialSeal;
  ownApps?: OwnApps;
  /** The platforms a person signs in with; absent without the Registry database. */
  platformLogin?: PlatformLogin;
  publicOrigin?: string;
  studioUrl?: string;
  reach?: AccountReach;
  store: RegistryStoreTs;
  accounts: AccountStoreTs;
  accountAvatars?: ReturnType<typeof accountAvatarApplicationServiceFromEnvironment>;
  trustedProxies: TrustedProxyPolicy;
  publishToken: string;
  runtimeServiceToken: string;
  deploymentServiceToken: string;
  factoryService: CreatorFactoryService;
  factoryAgents: FactoryAgentsService;
  factoryAgentDefinitions?: PostgresAgentDefinitionRepository;
  productFileStore: ProductFileStore;
  factoryNodeService?: FactoryNodeService;
  corpusPublisher?: CorpusPublisher;
  productLive?: ProductLiveService;
  nodeObjectStore?: ReturnType<typeof objectStoreFromEnvironment>;
  releaseStore: CreatorRegistryReleaseStore;
  authSecret: string;
};

export async function createRegistryServerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<RegistryServer> {
  initializeLangfuseObservability(environment);
  const passwordWorkOptions = passwordWorkOptionsFromEnvironment(environment);
  const trustedProxies = authTrustedProxyPolicyFromEnvironment(environment);
  const store = await RegistryStoreTs.open({ environment });
  const accounts = new AccountStoreTs(store.databasePool(), new PasswordHasher(passwordWorkOptions));
  await accounts.ensureSchema();
  const accountAvatars = accountAvatarApplicationServiceFromEnvironment(accounts, environment);
  const factoryRepository = creatorFactoryRepositoryForRegistry(environment, store.databasePool());
  await factoryRepository.initialize();
  const factoryRoot = path.resolve(environment.HATCH_CREATOR_FACTORY_ROOT ?? "creator-factory-runs");
  const registryPool = store.databasePool();
  const factoryAgentDefinitions = registryPool ? await PostgresAgentDefinitionRepository.open(registryPool) : undefined;
  const conversationPorts = await openConversationPorts(registryPool);
  // With a database every Product workspace journals each Run from its start; without one Studio has no conversations to record.
  // One ledger for every Studio model call, and the source of the usage the Expert reads back.
  const usage = registryPool ? new PostgresUsageLedger(registryPool) : new InMemoryUsageLedger();
  const usageCap = UsageCap.fromEnvironment(usage, environment);
  // Which model each role runs on lives in the database; without one (local development) the seed choices apply.
  const models = registryPool ? new PostgresModelRoleResolver(registryPool) : new InMemoryModelRoleResolver();
  const factoryAgents = new FactoryAgentsService(path.join(factoryRoot, "agent-chats"), environment, models, factoryAgentDefinitions, registryPool ? () => new EventLogJournal(conversationPorts.eventLog, event => event.sessionId) : undefined, usage, usageCap);
  const objectStore = objectStoreFromEnvironment(environment);
  const productObjectStore = objectStoreFromEnvironment(environment, path.join(factoryRoot, "product-files"));
  if (!productObjectStore) throw new Error("Product File object storage is not configured");
  const productFileStore = new ProductFileStore(
    productObjectStore,
    environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products"
  );
  const nodeObjectStore = objectStore ?? productObjectStore;
  const nodePool = registryPool;
  const nodePersistence = nodePool ? new PostgresNodeStore({ pool: nodePool }) : undefined;
  const factoryNodeService = nodePersistence && nodeObjectStore
    ? new FactoryNodeService(
      new NodeRuntime({
        models,
        sessionStore: nodePersistence,
        executionStore: nodePersistence,
        storage: { objectStore: nodeObjectStore },
        maxRounds: integerEnvironment(environment.HATCH_FACTORY_NODE_MAX_ROUNDS, 10),
        maxAgentTurns: integerEnvironment(environment.HATCH_FACTORY_NODE_MAX_AGENT_TURNS, 16)
      }),
      nodePersistence,
      { objectStore: nodeObjectStore },
      productFileStore,
      environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products",
      { recorder: usage, cap: usageCap }
    )
    : undefined;
  const graphPool = store.databasePool();
  // Registry releases are the cross-process publish authority. Bind this
  // store directly to the configured production Postgres URL so a release
  // can never silently fall back to process memory.
  const releaseDatabaseUrl = environment.HATCH_REGISTRY_DATABASE_URL?.trim();
  const releaseDatabaseTimeoutMs = Math.max(250, Number(environment.HATCH_REGISTRY_DB_TIMEOUT_MS ?? 5_000));
  const releasePool = releaseDatabaseUrl
    ? new (await import("pg")).Pool({
      connectionString: releaseDatabaseUrl,
      max: 5,
      connectionTimeoutMillis: releaseDatabaseTimeoutMs,
      query_timeout: releaseDatabaseTimeoutMs,
      statement_timeout: releaseDatabaseTimeoutMs,
      idleTimeoutMillis: 30_000,
    })
    : graphPool;
  const ownsReleasePool = Boolean(releaseDatabaseUrl);
  const releaseStore = new CreatorRegistryReleaseStore(releasePool);
  await releaseStore.ensureSchema();
  const corpusPublisher = nodeObjectStore
    ? new CorpusPublisher(factoryNodeService, nodeObjectStore, store, releaseStore, environment.HATCH_RUNTIME_CORPUS_ROOT?.trim() || "runtime-corpora")
    : undefined;
  const studioUrl = environment.HATCH_STUDIO_ASSISTANT_URL?.trim() || "https://gethatchapp.com/studio/assistant";
  // The site its users know: the alias domain. Products and the Telegram bots are reached here.
  const siteOrigin = environment.HATCH_DOMAIN_ALIAS?.trim() ? `https://${environment.HATCH_DOMAIN_ALIAS.trim()}` : new URL(studioUrl).origin;
  const productLive = corpusPublisher && nodeObjectStore
    ? createProductLive({ factoryRoot, publisher: corpusPublisher, releases: releaseStore, objectStore: nodeObjectStore, publicOrigin: siteOrigin })
    : undefined;
  const graphStore = graphPool ? new PostgresDistillationGraphStore(graphPool) : undefined;
  await graphStore?.initialize();
  // User commands start the Factory directly in the registry process. The
  // standalone worker remains a durable restart/recovery consumer, but a new
  // Product revision no longer waits for its polling loop to notice a row.
  const immediateFactoryWorker = new CreatorFactoryWorker(
    factoryRepository,
    new CreatorFactory(
      factoryRoot,
      factoryPromptRunner(models, environment),
      createHatchCliCandidateExecutor({
        models,
        timeoutMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_HATCH_TIMEOUT_MS, 15 * 60_000),
        environment
      }),
      { model: factoryModelRecord(models), objectStore, graphStore }
    ),
    {
      workerId: `factory-http-${process.pid}-${randomUUID()}`,
      usage,
      // The direct HTTP starter and the durable recovery worker share this
      // lease. It must exceed the Factory LLM's 15-minute hard deadline so a
      // slow prompt is not reclaimed while the request is still executing.
      leaseMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_LEASE_MS, 20 * 60_000),
      heartbeatMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_HEARTBEAT_MS, 60_000)
    }
  );
  const immediateFactoryStop = new AbortController();
  const factoryService = new CreatorFactoryService(
    factoryRepository,
    factoryRoot,
    undefined,
    objectStore,
    graphStore,
    productFileStore,
    (runId) => immediateFactoryWorker.startRun(runId, immediateFactoryStop.signal),
    usageCap
  );
  const publishToken = environment.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN?.trim() || "";
  const runtimeServiceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim() || "";
  const deploymentServiceToken = environment.HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN?.trim() || "";
  const legacyHmacEnabled = environment.HATCH_ENABLE_LEGACY_HMAC_AUTH?.trim().toLowerCase() === "true";
  const authSecret = legacyHmacEnabled ? environment.HATCH_AUTH_SIGNING_SECRET?.trim() || "" : "";
  const httpLimits = httpRequestLimitOptionsFromEnvironment(environment);
  const registryContext: RegistryContext = { usage, monthlyTokenCap: monthlyTokenCap(environment), dictation: new Dictation(new VoiceProcessor(new FfmpegAudioNormalizer(), transcriberFromEnvironment(environment))), store, accounts, accountAvatars, trustedProxies, publishToken, runtimeServiceToken, deploymentServiceToken, factoryService, factoryAgents, factoryAgentDefinitions, productFileStore, factoryNodeService, corpusPublisher, productLive, nodeObjectStore, releaseStore, authSecret, conversationPorts, studioAssets: registryPool ? await openProductAssets(registryPool, productObjectStore, environment) : undefined };
  const studio = new Studio(studioDeps(registryContext));
  const studioSockets = new StudioSockets({ studio, identify: token => identifyToken(registryContext, token) });
  let assistantTick: NodeJS.Timeout | undefined;
  let channelListeners: ChannelListeners | undefined;
  let credentialRefresher: CredentialRefresher | undefined;
  if (registryPool) {
    const reach = new AccountReach(registryPool);
    await reach.ensureSchema();
    await PostgresWorkbenchBackend.ensureSchema(registryPool);
    const tasks = await PostgresTaskRepository.open(registryPool);
    // Lark has no shared bot, so its tenant is the Expert's account; every other platform is one shared tenant.
    // Where each Expert brings their own app, the adapter is built from their sealed credentials and the scope is their account id.
    const scopeOf = (accountId: string, kind: ChannelKind) => { const form = CREDENTIAL_FORMS[kind]; return form && !isTenantForm(form) && !isPerProduct(form) ? accountId : ""; };
    const stores = await openChannelStores(registryPool, scopeOf);
    // Our one bot answers the Assistant, and signs people in. Telegram sends people back to the site its users know: the alias domain.
    const telegramOrigin = environment.HATCH_TELEGRAM_PUBLIC_ORIGIN?.trim() || siteOrigin;
    const telegram = new TelegramChannel({
      token: environment.HATCH_TELEGRAM_BOT_TOKEN?.trim() || undefined,
      username: environment.HATCH_TELEGRAM_BOT_USERNAME?.trim() || undefined,
      webhookSecret: environment.HATCH_TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
    });
    // The bot posts here, and only here: set at every start, so a changed origin or secret needs no other step.
    if (telegram.available()) void telegram.setWebhook(`${telegramOrigin}/v1/channels/telegram/webhook`, environment.HATCH_TELEGRAM_WEBHOOK_SECRET!.trim()).catch(error => log.error("telegram_webhook_failed", { error: safeError(error) }));
    const line = new LineChannel({
      channelSecret: environment.HATCH_LINE_CHANNEL_SECRET?.trim() || undefined,
      accessToken: environment.HATCH_LINE_CHANNEL_ACCESS_TOKEN?.trim() || undefined,
      basicId: environment.HATCH_LINE_BASIC_ID?.trim() || undefined,
    });
    // Discord's shared bot answers direct messages only: without its own id (from a probe) a mention in a server is not recognised.
    const discord = new DiscordChannel({ token: environment.HATCH_DISCORD_BOT_TOKEN?.trim() ?? "", applicationId: environment.HATCH_DISCORD_APPLICATION_ID?.trim() ?? "" }, "");
    const imessage = new IMessageChannel({
      projectId: environment.HATCH_PHOTON_PROJECT_ID?.trim() || undefined,
      projectSecret: environment.HATCH_PHOTON_PROJECT_SECRET?.trim() || undefined,
      address: environment.HATCH_IMESSAGE_ADDRESS?.trim() || undefined,
    });
    // One app serves many tenants (workspaces, Pages, business accounts). A tenant's token is a sealed credential on its Connection,
    // so without the sealing key no tenant can be configured and these adapters are unavailable.
    const sealKey = environment.HATCH_CREDENTIALS_KEY?.trim();
    const seal = sealKey ? new CredentialSeal(sealKey) : undefined;
    const env = (name: string) => environment[name]?.trim() || undefined;
    const tokens = (kind: ChannelKind) => seal ? sealedTokens(stores.connections, seal, kind) : undefined;
    const callback = (kind: ChannelKind) => `${new URL(studioUrl).origin}/v1/channels/${kind}/oauth/callback`;
    const slack = new SlackChannel({
      signingSecret: env("HATCH_SLACK_SIGNING_SECRET"), clientId: env("HATCH_SLACK_CLIENT_ID"), clientSecret: env("HATCH_SLACK_CLIENT_SECRET"), redirectUri: callback("slack"), tokens: tokens("slack"),
    });
    const whatsapp = new WhatsAppChannel({ appSecret: env("HATCH_WHATSAPP_APP_SECRET"), verifyToken: env("HATCH_WHATSAPP_VERIFY_TOKEN"), tokens: tokens("whatsapp") });
    const instagram = new InstagramChannel({
      appSecret: env("HATCH_INSTAGRAM_APP_SECRET"), verifyToken: env("HATCH_INSTAGRAM_VERIFY_TOKEN"), clientId: env("HATCH_INSTAGRAM_APP_ID"), clientSecret: env("HATCH_INSTAGRAM_APP_SECRET"), redirectUri: callback("instagram"), tokens: tokens("instagram"),
    });
    const messenger = new MessengerChannel({ appSecret: env("HATCH_MESSENGER_APP_SECRET"), verifyToken: env("HATCH_MESSENGER_VERIFY_TOKEN"), tokens: tokens("messenger") });
    // Platform rules sit in front of every Agent. WhatsApp serves only Connections an operator marked task-specific.
    const eligibility = { whatsapp: whatsappEligibility };
    const apps = new Map<string, { sealed: string; adapter: ChannelAdapter }>();
    // An Expert's own app: found by the account for one app per account, by the id of the bot for one bot per Product.
    const hub = new ChannelHub([telegram, line, discord, imessage, slack, whatsapp, instagram, messenger], async (kind, scope) => {
      const form = CREDENTIAL_FORMS[kind];
      if (!form || isTenantForm(form) || !seal) return undefined;
      const sealed = form.perProduct ? await stores.connections.credentialsOf(kind, scope) : await stores.connections.credentials(scope, kind);
      if (!sealed) return undefined;
      const cached = apps.get(`${kind}:${scope}`);
      if (cached?.sealed === sealed) return cached.adapter;
      const adapter = form.build(seal.open(sealed), scope);
      apps.set(`${kind}:${scope}`, { sealed, adapter });
      return adapter;
    }, kind => { const form = CREDENTIAL_FORMS[kind]; return Boolean(form && isTenantForm(form)); });
    // Each platform's own sign-in: one Hatch account per platform id. A chat that started it is bound to the Assistant once the sign-in names the same sender.
    const clientOf = (prefix: string) => { const clientId = env(`${prefix}_CLIENT_ID`); const clientSecret = env(`${prefix}_CLIENT_SECRET`); return clientId && clientSecret ? { clientId, clientSecret } : undefined; };
    // The platforms that are identity providers on our shared bot, each with how its provider is built from the environment.
    const identityProviders: Partial<Record<ChannelKind, () => IdentityProvider | undefined>> = {
      telegram: () => { const client = clientOf("HATCH_TELEGRAM_LOGIN"); return client && telegramIdentity(new OidcClient(telegramOidc(client, env("HATCH_TELEGRAM_LOGIN_BASE")))); },
      line: () => { const client = clientOf("HATCH_LINE_LOGIN"); return client && lineIdentity(new OidcClient(lineOidc(client))); },
      discord: () => { const client = clientOf("HATCH_DISCORD"); return client && new DiscordIdentity(client); },
    };
    const providers: Partial<Record<ChannelKind, IdentityProvider>> = {};
    for (const [kind, build] of Object.entries(identityProviders)) { const provider = build(); if (provider) providers[kind as ChannelKind] = provider; }
    // Signing in with a platform is closed for now: on its own it creates a Hatch account per platform id, and an account that
    // later unbinds the platform has no way back in yet, which leaves ghost accounts and platform ids that cannot be bound.
    // Binding a chat to an existing account (a link code from Studio) is not affected. Reopen when binding is account-level.
    const PLATFORM_SIGN_IN_OPEN = false;
    const platformLogin = new PlatformLogin({
      providers: PLATFORM_SIGN_IN_OPEN ? providers : {}, store: await PostgresLoginStore.open(registryPool), accounts, limiter: stores.limiter, origin: telegramOrigin,
      // `channels` is built just below from this login, and is only called once a person signs in.
      admit: (kind, account, subject, claim) => channels.admit(kind, { senderId: subject, threadId: subject }, account.id),
    });
    const catalog = registryAgentCatalog(registryContext);
    // Chat runs in the Runtime process: the channel layer reaches it with its own service token, and never otherwise.
    const chatUrl = environment.HATCH_RUNTIME_CHAT_URL?.trim();
    const chatToken = environment.HATCH_RUNTIME_CHAT_SERVICE_TOKEN?.trim();
    const gateway = chatUrl && chatToken ? new HttpChatGateway({ baseUrl: chatUrl, serviceToken: chatToken }) : undefined;
    // A Product's Runs are held by the Runtime; the Assistant's are held here. A reply is sent once for either.
    const routed = new RoutedChatGateway(gateway);
    const ownsProduct = async (accountId: string, productId: string) => Boolean(await productForCreator(registryContext, accountId, productId));
    const channels: ChannelService = new ChannelService({
      ...stores, hub, scopeOf, ownsProduct, gateway: routed,
      audienceOf: (kind, target) => target.kind === "product" && isPerProduct(CREDENTIAL_FORMS[kind]) ? "public" : "self",
      signIn: (kind, senderId) => platformLogin.claimLink(kind, senderId),
      // A platform id on our shared bot belongs to one Hatch account: linking from an account that is not its own is refused.
      claim: async (kind, scope, accountId, senderId) => !Object.hasOwn(identityProviders, kind) || scope !== "" || await accounts.linkIdentity(accountId, kind, senderId),
    });
    const assistantState = await PostgresAssistantState.open(registryPool);
    const productsPrefix = environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products";
    const ingest = await createIngestService({
      environment, pool: registryPool, seal, models, objects: productObjectStore,
      manual: async (accountId, productId) => {
        const { backend } = (await factoryAgents.workspace({ creatorId: accountId, productId }, await catalog.token(accountId))).store;
        return { list: async () => (await backend.listManual()).map(file => file.path), read: name => backend.readManual(name), write: (name, bytes) => backend.writeManual(name, bytes) };
      },
      productPrefix: (accountId, productId) => `${productsPrefix}/${accountId}/${productId}`,
      owns: ownsProduct,
      usageCap,
    });
    const assistant = new AssistantService({
      tasks, reach, channels,
      products: factoryAgents,
      catalog,
      backend: accountId => new PostgresWorkbenchBackend(registryPool, `assistant:${accountId}`),
      state: assistantState,
      deliveries: await PostgresDeliveries.open(registryPool),
      exclusive: postgresExclusive(registryPool),
      search: new FirecrawlSearchProvider({ apiKey: environment.FIRECRAWL_API_KEY }),
      env: environment, models, ingest, usage, usageCap,
    });
    ingest.onSettled(job => assistant.ingested(job));
    // The Assistant is a conversation on Chat's runtime, with its own transcript in this database and the Studio tools.
    failures.attach(new PostgresFailureLedger(registryPool as never));
    const transcripts = new PostgresStore({ pool: registryPool, maxConversationEvents: 1_000_000, maxConversationBytes: 1024 * 1024 * 1024 });
    const conversations = new PostgresConversationRepository({ pool: registryPool });
    conversations.bindSubmissionStore(transcripts);
    await conversations.initialize();
    const chatAssets = await openChatAssets({ pool: registryPool, blobs: productObjectStore, environment });
    for (const definition of attachmentToolDefinitions(chatAssets.tools())) toolRegistry.set(definition.name, definition);
    const tools = studioTools(assistant);
    for (const definition of studioToolDefinitions(tools)) toolRegistry.set(definition.name, definition);
    const assistantChat = new AssistantChat({
      repository: conversations, store: transcripts, chatAssets, state: assistantState, tools,
      assetStore: new RuntimeAssetStore(path.join(factoryRoot, "assistant-assets")),
      history: new LegacyAssistantHistory({ backend: accountId => new PostgresWorkbenchBackend(registryPool, `assistant:${accountId}`), state: assistantState, store: transcripts }),
      prompt: assistantPrompt, liveState: accountId => assistant.liveState(accountId), env: environment, models, usage, usageCap,
    });
    assistant.bind(assistantChat, new ExpertMaterials({ assets: chatAssets, conversation: accountId => assistantChat.conversation(accountId) }));
    routed.bindLocal(assistantChat.gateway);
    // Studio observers read the Assistant's events from its Run's journal; every other conversation keeps its log.
    conversationPorts.eventLog.bind("assistant:", assistantChat.feed);
    await assistantChat.start();
    channels.register("assistant", guarded(new ChatFlow(new AssistantTarget(assistant)), eligibility));
    // Without a Chat gateway Product Connections have no handler: readiness says so, and their webhooks are refused. HATCH_PRODUCT_CHANNELS=off makes that deliberate.
    const productChannelsOff = environment.HATCH_PRODUCT_CHANNELS?.trim() === "off";
    const productChannelsUnavailable = gateway || productChannelsOff ? undefined : "Product channels need HATCH_RUNTIME_CHAT_URL and HATCH_RUNTIME_CHAT_SERVICE_TOKEN; set both, or set HATCH_PRODUCT_CHANNELS=off.";
    if (gateway) channels.register("product", guarded(new GuardedTarget(new ChatFlow(new ProductTarget({ gateway, limiter: stores.limiter })), [liveOwnProduct(releaseStore)]), eligibility));
    channels.start();
    Object.assign(registryContext, { productChannelsUnavailable, assistant, assistantChat, assistantStorage: [transcripts, conversations], ingest, channels, reach, credentialSeal: seal, publicOrigin: new URL(studioUrl).origin, studioUrl, platformLogin,...(seal ? { ownApps: new OwnApps({ connections: stores.connections, seal, forms: CREDENTIAL_FORMS, origin: telegramOrigin, ownsProduct }) } : {}) });
    // A platform that pushes over its own connection runs here, in one process at a time. A dropped connection comes back; credentials added or removed are picked up.
    channelListeners = new ChannelListeners({
      hub, connections: stores.connections, exclusive: postgresExclusive(registryPool),
      accept: (adapter, events) => channels.accept(adapter, events),
      onError: (key, error) => log.error("channel_listener_failed", { channel: key, error: safeError(error) }),
    });
    channelListeners.start();
    // Credentials that expire (Instagram's 60-day tokens) are renewed before they do.
    if (seal) { credentialRefresher = new CredentialRefresher({ hub, connections: stores.connections, seal, onError: (key, error) => log.error("credential_refresh_failed", { connection: key, error: safeError(error) }) }); credentialRefresher.start(); }
    assistantTick = setInterval(() => void assistant.tick().catch(error => log.error("assistant_tick_failed", { error })), 60_000);
    assistantTick.unref();
  }
  const inflight = new InflightResponses();
  const server = http.createServer(observed((request, response) => {
    inflight.track(response);
    void route(request, response, registryContext)
      .catch((error) => {
        const status = errorStatus(error);
        if (status >= 500) log.error("Registry request failed", { error, status });
        if (error instanceof ProductFilesError) {
          sendJson(response, status, {
            error: { code: error.code, message: error.message },
            detail: error.message
          });
          return;
        }
        if (error instanceof FactoryNodeServiceError) {
          sendJson(response, status, {
            error: { code: error.code, message: error.message },
            detail: error.message
          });
          return;
        }
        if (error instanceof BriefValidationError) {
          sendJson(response, status, {
            error: { code: error.code, message: error.message },
            detail: error.message
          });
          return;
        }
        if (error instanceof CreatorFactoryRepositoryError) {
          sendJson(response, status, {
            error: { code: error.code, message: error.message },
            detail: error.message
          });
          return;
        }
        if (error instanceof CorpusPublishError) {
          sendJson(response, status, {
            error: { code: error.code, message: error.message },
            detail: error.message
          });
          return;
        }
        // A 5xx hides its cause from the client (it is logged above); only a definitions failure may say what it is.
        if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
          && (status < 500 || (error as { code: string }).code === "agent_definitions_invalid")) {
          const structured = error as { code: string; message?: string; details?: unknown };
          const message = status >= 500 ? "Factory Agent definitions are unavailable." : structured.message ?? "Request failed.";
          sendJson(response, status, { error: { code: structured.code, message, ...(structured.details === undefined ? {} : { details: structured.details }) }, detail: message });
          return;
        }
        sendJson(response, status, {
          detail: status >= 500
            ? "Registry request failed."
            : error instanceof SyntaxError
              ? "Request body must be valid JSON."
              : error instanceof Error ? error.message : String(error)
        });
      });
  }));
  server.headersTimeout = httpLimits.headersTimeoutMs;
  server.requestTimeout = httpLimits.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.on("upgrade", (request, socket, head) => {
    socket.on("error", () => undefined);
    void (async () => {
      const url = new URL(request.url ?? "/", "http://registry.local");
      if (url.pathname === STUDIO_SOCKET_PATH) {
        const token = bearer(request);
        const identity = token ? await identifyToken(registryContext, token) : undefined;
        if (token && !identity) throw Object.assign(new Error("A valid account token is required."), { status: 401 });
        studioSockets.upgrade(request, socket, head, identity);
        return;
      }
      throw Object.assign(new Error("Unknown WebSocket route"), { status: 404 });
    })().catch(error => {
      if (socket.destroyed) return;
      const status = errorStatus(error);
      const label = status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : "Bad Request";
      socket.write(`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    });
  });
  const port = Number(environment.REGISTRY_PORT ?? 8100);
  const host = environment.REGISTRY_HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  // Nothing new is claimed or accepted from here on; the other instance takes the work over.
  let intakeStopped: Promise<void> | undefined;
  let serverClosed: Promise<void> | undefined;
  const stopIntake = () => intakeStopped ??= (async () => {
    registryContext.draining = true;
    serverClosed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    serverClosed.catch(() => undefined);
    if (assistantTick) clearInterval(assistantTick);
    await channelListeners?.stop();
    credentialRefresher?.stop();
    await registryContext.channels?.close();
  })();
  const close = async () => {
    await stopIntake();
    await registryContext.assistant?.close();
    await registryContext.assistantChat?.close();
    for (const storage of registryContext.assistantStorage ?? []) await storage.close();
    immediateFactoryStop.abort();
    await factoryAgents.close();
    inflight.endAll();
    studioSockets.close();
    server.closeAllConnections();
    await serverClosed;
    await factoryRepository.close();
    await store.close();
    await flushLangfuseObservability();
    if (ownsReleasePool) await releasePool?.end();
  };
  return { server, close, shutdown: deadlineMs => gracefulShutdown({
    deadlineMs,
    markUnready: () => { registryContext.draining = true; },
    stopIntake,
    // Studio Runs, the Assistant's Runs (leased, so a Run left over is handed to the next instance), ingest jobs, and requests in flight.
    drain: async () => { await Promise.all([registryContext.assistantChat?.drain(), registryContext.assistant?.drain(), factoryAgents.drain(), registryContext.ingest?.drain(), inflight.requestsDone()]); },
    closeConnections: async () => { inflight.endAll(); studioSockets.close(); },
    closeStorage: close,
    onError: (step, error) => log.error("registry_shutdown_step_failed", { step, error }),
  }) };
}

function integerEnvironment(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Expected a positive integer, received ${raw}`);
  return value;
}

export function creatorFactoryRepositoryForRegistry(
  environment: NodeJS.ProcessEnv,
  registryPool?: NonNullable<ReturnType<RegistryStoreTs["databasePool"]>>
): CreatorFactoryRepository {
  const factoryDatabaseUrl = environment.HATCH_FACTORY_DATABASE_URL?.trim();
  if (factoryDatabaseUrl) return new PostgresCreatorFactoryRepository({ connectionString: factoryDatabaseUrl });
  return registryPool
    ? new PostgresCreatorFactoryRepository({ pool: registryPool })
    : new InMemoryCreatorFactoryRepository();
}

async function route(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): Promise<void> {
  if (request.method === "OPTIONS") { response.writeHead(204, corsHeaders()); response.end(); return; }
  const url = new URL(request.url ?? "/", "http://registry.local");
  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/internal/creator-accounts") {
    requireDeploymentServiceAuth(request, context.deploymentServiceToken);
    const rawIds = url.searchParams.get("ids") ?? "";
    const ids = rawIds ? [...new Set(rawIds.split(",").map((id) => id.trim()))] : [];
    if (ids.length > 100 || ids.some((id) => !isUuidV4(id))) {
      const error = Object.assign(new Error("ids must contain up to 100 Expert account UUIDs."), { status: 400 });
      throw error;
    }
    sendJson(response, 200, { accounts: await context.accounts.getCreatorPublicByIds(ids) }, { "cache-control": "no-store" });
    return;
  }

  if (url.pathname === "/v1/internal/factory-agent-definitions" && ["GET", "PUT"].includes(request.method ?? "")) {
    requireDeploymentServiceAuth(request, context.deploymentServiceToken);
    if (!context.factoryAgentDefinitions) {
      const error = Object.assign(new Error("Factory Agent definitions require Registry database configuration"), { status: 503 });
      throw error;
    }
    if (request.method === "GET") { sendJson(response, 200, { agents: await context.factoryAgentDefinitions.list() }); return; }
    const payload = await readJson(request);
    sendJson(response, 200, { agents: await context.factoryAgentDefinitions.replace(payload.agents) });
    return;
  }

  // Conversation API: Product workers and the Assistant, one message shape.
  if (await new ConversationRoutes(conversationDeps(response, context)).handle(request, response, url)) return;

  if (url.pathname === "/v1/transcriptions" && request.method === "POST") { await transcribe(request, response, context); return; }

  if (url.pathname.startsWith("/v1/channels/") || url.pathname.startsWith("/v1/creator/assistant") || url.pathname.startsWith("/v1/creator/connections")) {
    await assistantRoute(request, response, url, context);
    return;
  }

  const factoryAgentsMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/factory-agents(?:\/|$)/);
  if (factoryAgentsMatch) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(factoryAgentsMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    await context.factoryAgents.handle({ creatorId: account.id, productId, briefSpec: product.brief_spec }, bearer(request)!, request, response);
    return;
  }

  const registryPublishMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/registry$/);
  if (registryPublishMatch && request.method === "POST") {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    if (!context.corpusPublisher) {
      sendJson(response, 503, { error: { code: "publish_unavailable", message: "Corpus Publisher is unavailable." } });
      return;
    }
    const productId = decodeURIComponent(registryPublishMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    let result: Awaited<ReturnType<CorpusPublisher["publishUploaded"]>>;
    try {
      const publishInput = {
        creatorId: account.id,
        productId,
        productName: product.name,
        productPromise: product.promise,
        briefSpec: body.brief_spec ?? product.brief_spec
      };
      if (!Object.prototype.hasOwnProperty.call(body, "corpus")) {
        throw new CorpusPublishError("corpus_required", "Agent Generation must submit its System and Skills as corpus.", 422);
      }
      // Publication never runs a Factory Node or selects an older generated candidate.
      result = await context.corpusPublisher.publishUploaded({
        ...publishInput,
        corpus: body.corpus,
      });
    } catch (error) {
      if (error instanceof CorpusPublishError) throw error;
      const wrapped = new CorpusPublishError(
        "publish_failed",
        error instanceof Error ? `Registry publish failed: ${error.message}` : `Registry publish failed: ${String(error)}`,
        422,
        { cause: error instanceof Error ? error : undefined }
      );
      throw wrapped;
    }
    sendJson(response, 201, {
      product_id: productId,
      corpus_ref: result.output_ref,
      corpus_digest: result.corpus_digest,
      release_digest: result.release.release_digest,
      status: "published",
      published_at: result.published.published_at
    });
    return;
  }

  // Expert publish: GET = live status, POST = publish System + Skills from the
  // Agent Builder workspace. Only SYSTEM.md is required.
  // Legacy /registry (Agent Builder corpus upload) is left unchanged.
  const productLiveMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/live$/);
  if (productLiveMatch && (request.method === "GET" || request.method === "POST")) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    if (!context.productLive) {
      sendJson(response, 503, { error: { code: "publish_unavailable", message: "Corpus Publisher is unavailable." } });
      return;
    }
    const productId = decodeURIComponent(productLiveMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    const publishable = new ExpertProduct(account.id, productId, product.name, product.promise, product.brief_spec);
    if (request.method === "GET") {
      sendJson(response, 200, { ...(await context.productLive.status(publishable)), listed: await context.releaseStore.isListed(productId) });
      return;
    }
    try {
      sendJson(response, 201, await context.productLive.publish(publishable));
    } catch (error) {
      if (error instanceof CorpusPublishError) throw error;
      if (error instanceof SystemMissing) throw new CorpusPublishError(error.code, error.message, 409);
      throw new CorpusPublishError(
        "publish_failed",
        error instanceof Error ? `Registry publish failed: ${error.message}` : `Registry publish failed: ${String(error)}`,
        422,
        { cause: error instanceof Error ? error : undefined }
      );
    }
    return;
  }

  const runtimeReleaseMatch = url.pathname.match(/^\/v1\/runtime\/products\/([^/]+)\/release$/);
  if (runtimeReleaseMatch && request.method === "GET") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const productId = decodeURIComponent(runtimeReleaseMatch[1]!);
    const release = await context.releaseStore.getLive(productId);
    if (!release) { sendJson(response, 404, { detail: "No live release exists for this Product." }); return; }
    // Keep the transport-only manifest reference at the response boundary.
    // `release` is also persisted and used by public catalog projections, but
    // Runtime's read contract deliberately exposes the manifest ref beside
    // the release object rather than duplicating it inside that object.
    const { runtime_manifest_ref: runtimeManifestRef, ...releasePayload } = release;
    sendJson(response, 200, {
      release: releasePayload,
      runtime_manifest_ref: runtimeManifestRef
    });
    return;
  }
  const runtimeConnectionMatch = url.pathname.match(/^\/v1\/runtime\/connections\/([^/]+)$/);
  if (runtimeConnectionMatch && request.method === "GET") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const connection = await context.channels?.connections.get(decodeURIComponent(runtimeConnectionMatch[1]!));
    if (!connection) { sendJson(response, 404, { detail: "No such Connection." }); return; }
    // The platform tenant is the channel layer's business; Chat is told who owns the Connection, whom it answers as, and for whom.
    const { scope: _scope, ...shared } = connection;
    sendJson(response, 200, { connection: shared });
    return;
  }
  const runtimeCreatorReleasesMatch = url.pathname.match(/^\/v1\/runtime\/creators\/([^/]+)\/releases$/);
  if (runtimeCreatorReleasesMatch && request.method === "GET") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const creatorId = decodeURIComponent(runtimeCreatorReleasesMatch[1]!);
    if (!isUuidV4(creatorId)) { sendJson(response, 400, { detail: "creator_id must be an account UUID." }); return; }
    const releases = await context.releaseStore.listLiveByCreator(creatorId);
    sendJson(response, 200, {
      releases: releases.map(({ runtime_manifest_ref: runtimeManifestRef, ...release }) => ({
        release,
        runtime_manifest_ref: runtimeManifestRef
      }))
    });
    return;
  }
  if (request.method === "GET" && (url.pathname === "/readyz" || url.pathname === "/health")) {
    try {
      if (context.draining) throw new Error("Registry is shutting down");
      await context.store.checkReady();
      if (context.productChannelsUnavailable) { sendJson(response, 503, { status: "unavailable", checks: { registry_store: "ready", product_channels: context.productChannelsUnavailable } }); return; }
      sendJson(response, 200, {
        status: "ok",
        checks: {
          registry_store: "ready",
          release_store: context.releaseStore.persistenceMode(),
        }
      });
    } catch {
      sendJson(response, 503, { status: "unavailable", checks: { registry_store: "failed" } });
    }
    return;
  }

  // A platform signs people in (OpenID Connect or OAuth2, authorization code with PKCE). The site starts it and finishes it; the browser never sees a token here.
  if (url.pathname === "/v1/auth/providers" && request.method === "GET") {
    sendAuthJson(response, 200, { providers: context.platformLogin?.kinds() ?? [] });
    return;
  }
  const login = url.pathname.match(/^\/v1\/auth\/([a-z]+)(?:\/(start|callback))?$/);
  const loginKind = login && isChannelKind(login[1]!) ? login[1] : undefined;
  if (loginKind && !login![2] && request.method === "GET") {
    sendAuthJson(response, 200, { enabled: Boolean(context.platformLogin?.enabled(loginKind)) });
    return;
  }
  if (loginKind && login![2] === "start" && request.method === "POST") {
    const body = await readJson(request);
    const { authorizeUrl, state } = await platformLoginOf(context).start(loginKind, { claim: typeof body.claim === "string" ? body.claim : undefined, returnTo: typeof body.return_to === "string" ? body.return_to : undefined });
    sendAuthJson(response, 200, { authorize_url: authorizeUrl, state });
    return;
  }
  if (loginKind && login![2] === "callback" && request.method === "POST") {
    const body = await readJson(request);
    // A request that carries a session is a person already signed in: the platform id is bound to their account, never made a new one.
    const signedIn = bearer(request) ? await authenticate(request, response, context) : undefined;
    const { account, created, returnTo } = await platformLoginOf(context).finish(loginKind, { code: String(body.code ?? ""), state: String(body.state ?? ""), ...(signedIn ? { signedIn } : {}) });
    sendAuthJson(response, created ? 201 : 200, { ...sessionResponse(account, await context.accounts.createSession(account)), created, return_to: returnTo });
    return;
  }
  if (url.pathname === "/v1/auth/signup" && request.method === "POST") {
    const body = await readJson(request);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    const displayName = String(body.display_name ?? "");
    try {
      validateSignupCredentials(email, password, displayName);
    } catch (error) {
      sendAuthInputError(response, error);
      return;
    }
    let account: Account;
    try {
      account = await context.accounts.create(email, password, displayName);
    } catch (error) {
      if (error instanceof PasswordWorkCapacityError) {
        sendAuthBusy(response);
        return;
      }
      sendError(response, error, { email_already_registered: [409, "Email is already registered."] });
      return;
    }
    sendAuthJson(response, 201, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/signin" && request.method === "POST") {
    const body = await readJson(request);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    let identity: string;
    try {
      identity = validateSigninCredentials(email, password);
    } catch (error) {
      sendAuthInputError(response, error);
      return;
    }
    const account = await context.accounts.getByEmail(identity);
    let passwordMatches: boolean;
    try {
      passwordMatches = await context.accounts.verifyPassword(password, account);
    } catch (error) {
      if (error instanceof PasswordWorkCapacityError) {
        sendAuthBusy(response);
        return;
      }
      throw error;
    }
    if (!passwordMatches || !account) {
      sendAuthJson(response, 401, { detail: "Email or password is incorrect." });
      return;
    }
    sendAuthJson(response, 200, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/me/avatar" && (request.method === "PUT" || request.method === "DELETE")) {
    const account = await authenticate(request, response, context);
    if (!account) { sendAuthJson(response, 401, { detail: "A valid account token is required." }); return; }
    if (!context.accountAvatars) {
      sendAuthJson(response, 503, { error: { code: "avatar_storage_unavailable", message: "Avatar storage is not configured." } });
      return;
    }
    const updated = request.method === "DELETE"
      ? await context.accountAvatars.remove(account.id)
      : await context.accountAvatars.replace(
        account.id,
        Buffer.from(await readBytes(request, MAX_ACCOUNT_AVATAR_BYTES)),
        String(request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase()
      );
    sendAuthJson(response, 200, accountPublic(updated));
    return;
  }
  if (url.pathname === "/v1/auth/me" && request.method === "PATCH") {
    const account = await authenticate(request, response, context);
    if (!account) { sendAuthJson(response, 401, { detail: "A valid account token is required." }); return; }
    const body = await readJson(request);
    let updated: Account = account;
    try {
      if (body.early_access !== undefined) {
        if (typeof body.early_access !== "boolean") throw new Error("early_access_invalid");
        updated = await context.accounts.setEarlyAccess(account.id, body.early_access);
      }
      if (body.display_name !== undefined) updated = await context.accounts.setDisplayName(account.id, String(body.display_name));
    } catch (error) {
      sendAuthInputError(response, error);
      return;
    }
    sendAuthJson(response, 200, accountPublic(updated));
    return;
  }
  if (url.pathname === "/v1/auth/me" && request.method === "GET") {
    const token = bearer(request);
    const session = await context.accounts.resolveSession(token);
    if (session) {
      sendAuthJson(response, 200, { ...accountPublic(session.account), session_expires_at: session.session.absolute_expires_at, session_id: session.session.id, client_type: session.session.client_type });
      return;
    }
    const account = await authenticateLegacy(token, context.accounts, context.authSecret);
    if (!account) { sendAuthJson(response, 401, { detail: "A valid account token is required." }); return; }
    sendAuthJson(response, 200, accountPublic(account));
    return;
  }
  if (url.pathname === "/v1/auth/me/avatar" && (request.method === "PUT" || request.method === "DELETE")) {
    const account = await authenticate(request, response, context);
    if (!account) { sendAuthJson(response, 401, { detail: "A valid account token is required." }); return; }
    if (!context.accountAvatars) {
      sendAuthJson(response, 503, { error: { code: "avatar_storage_unavailable", message: "Avatar storage is not configured." } });
      return;
    }
    const updated = request.method === "DELETE"
      ? await context.accountAvatars.remove(account.id)
      : await context.accountAvatars.replace(
        account.id,
        Buffer.from(await readBytes(request, MAX_ACCOUNT_AVATAR_BYTES)),
        String(request.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase()
      );
    sendAuthJson(response, 200, accountPublic(updated));
    return;
  }
  // A signed-in client mints an independent session for another device
  // (the Dashboard hands one to Desktop after browser sign-in). Revoking
  // either session never ends the other. Only a live session can do this.
  if (url.pathname === "/v1/auth/sessions" && request.method === "POST") {
    await requireInteractive(context, async (current) => {
      const requested = (await optionalJson(request)).client_type ?? "desktop";
      if (requested !== "desktop" && requested !== "cli") { sendAuthJson(response, 400, { detail: "client_type must be desktop or cli." }); return; }
      sendAuthJson(response, 201, sessionResponse(current.account, await context.accounts.createSession(current.account, Date.now(), { clientType: requested })));
    })(request, response);
    return;
  }
  // API keys are minted and listed only from an interactive session; a key can revoke itself or others but never mint.
  if (url.pathname === "/v1/auth/api-keys" && request.method === "POST") {
    await requireInteractive(context, async (current) => {
      const name = String((await optionalJson(request)).name ?? "").trim();
      if (!name || name.length > 80) { sendAuthJson(response, 400, { detail: "name is required (1-80 characters)." }); return; }
      const issued = await context.accounts.createSession(current.account, Date.now(), { clientType: "api_key", name });
      sendAuthJson(response, 201, { id: issued.session.id, name, token: issued.token, created_at: issued.session.created_at, expires_at: issued.session.absolute_expires_at });
    })(request, response);
    return;
  }
  if (url.pathname === "/v1/auth/api-keys" && request.method === "GET") {
    await requireInteractive(context, async (current) => {
      sendAuthJson(response, 200, { api_keys: await context.accounts.listApiKeys(current.account.id) });
    })(request, response);
    return;
  }
  // What the signed-in Expert has spent this month and each day of a range (default: the last 30 days), by surface.
  if (url.pathname === "/v1/creator/usage" && request.method === "GET") {
    await requireInteractive(context, async (current) => {
      const today = utcDay(new Date());
      const from = url.searchParams.get("from") ?? utcDay(new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86_400_000));
      const to = url.searchParams.get("to") ?? today;
      const valid = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));
      if (!valid(from) || !valid(to) || from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86_400_000) { sendAuthJson(response, 400, { detail: "from and to must be YYYY-MM-DD dates, at most a year apart." }); return; }
      sendAuthJson(response, 200, await usageReport(context.usage, current.account.id, from, to, context.monthlyTokenCap));
    })(request, response);
    return;
  }
  const apiKeyMatch = url.pathname.match(/^\/v1\/auth\/api-keys\/([^/]+)$/);
  if (apiKeyMatch && request.method === "DELETE") {
    const current = await context.accounts.resolveSession(bearer(request));
    if (!current) { sendAuthJson(response, 401, { detail: "A valid account session is required." }); return; }
    if (!await context.accounts.revokeApiKey(current.account.id, decodeURIComponent(apiKeyMatch[1]!))) { sendAuthJson(response, 404, { detail: "API key not found." }); return; }
    response.writeHead(204, { ...corsHeaders(), "cache-control": "no-store" });
    response.end();
    return;
  }
  if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
    await context.accounts.revokeSession(bearer(request));
    response.writeHead(204, { ...corsHeaders(), "cache-control": "no-store" });
    response.end();
    return;
  }

  const internalFactoryStageMatch = url.pathname.match(/^\/v1\/internal\/deployments\/factory-runs\/([^/]+)\/stage$/);
  if (internalFactoryStageMatch && request.method === "POST") {
    requireDeploymentServiceAuth(request, context.deploymentServiceToken);
    const body = await readJson(request);
    const creatorId = requiredDeploymentField(body, "creator_id");
    const operationId = requiredDeploymentField(body, "operation_id");
    const corpusDigest = requiredDeploymentField(body, "corpus_digest");
    const productId = requiredDeploymentField(body, "product_id");
    const runId = decodeURIComponent(internalFactoryStageMatch[1]!);
    const candidate = await context.factoryService.publishableCorpus(creatorId, runId);
    if (candidate.corpusDigest !== corpusDigest) {
      sendJson(response, 409, {
        code: "candidate_changed",
        detail: "The Factory candidate changed. Review it again.",
        expected_corpus_digest: corpusDigest,
        current_corpus_digest: candidate.corpusDigest
      });
      return;
    }
    if (candidate.agentId !== productId) throw new Error("product_id does not match the Factory candidate");
    const product = await productForCreator(context, creatorId, productId);
    const briefSpec = product?.brief_spec ? normalizeBriefSpec(product.brief_spec) : undefined;
    if (!briefSpec) {
      const error = new Error("brief_spec_required");
      (error as Error & { status?: number }).status = 422;
      throw error;
    }
    const staged = await context.store.stageAgentCorpusDirectory(
      creatorId,
      candidate.agentId,
      candidate.corpusRoot,
      candidate.corpusDigest,
      briefSpec
    );
    sendJson(response, 201, { ...staged, factory_run_id: runId, operation_id: operationId, current: false });
    return;
  }

  const internalActivationMatch = url.pathname.match(/^\/v1\/internal\/deployments\/agent-corpora\/([^/]+)\/releases\/([^/]+)\/activate$/);
  if (internalActivationMatch && request.method === "POST") {
    requireDeploymentServiceAuth(request, context.deploymentServiceToken);
    const body = await readJson(request);
    const creatorId = requiredDeploymentField(body, "creator_id");
    const operationId = requiredDeploymentField(body, "operation_id");
    if (!Object.hasOwn(body, "expected_current_digest")) throw new Error("expected_current_digest is required");
    const expectedCurrentDigest = body.expected_current_digest === null
      ? null
      : requiredDeploymentField(body, "expected_current_digest");
    const agentId = decodeURIComponent(internalActivationMatch[1]!);
    const corpusDigest = decodeURIComponent(internalActivationMatch[2]!);
    try {
      const productId = typeof body.product_id === "string" ? body.product_id.trim() : agentId;
      const product = await productForCreator(context, creatorId, productId);
      const briefSpec = body.brief_spec && typeof body.brief_spec === "object"
        ? normalizeBriefSpec(body.brief_spec as BriefSpec)
        : product?.brief_spec;
      if (!briefSpec) {
        const error = new Error("brief_spec_required");
        (error as Error & { status?: number }).status = 422;
        throw error;
      }
      const activated = await context.store.activateAgentCorpusRelease(
        creatorId,
        agentId,
        corpusDigest,
        { operationId, expectedCurrentDigest, briefSpec }
      );
      const release = typeof body.factory_run_id === "string" && typeof body.product_id === "string"
        ? await context.factoryService.recordRelease(creatorId, body.factory_run_id, body.product_id)
        : undefined;
      sendJson(response, 200, { agent_corpus: activated, current: true, operation_id: operationId, ...(release ? { release } : {}) });
    } catch (error) {
      if (error instanceof RegistryDeploymentConflictError) {
        sendJson(response, 409, {
          code: error.code,
          detail: error.message,
          expected_current_digest: error.expectedCurrentDigest,
          current_corpus_digest: error.currentCorpusDigest,
          target_corpus_digest: error.targetCorpusDigest
        });
      } else {
        throw error;
      }
    }
    return;
  }

  const factoryNodeMatch = url.pathname.match(
    /^\/v1\/creator\/products\/([^/]+)\/nodes\/(about-you|corpus)\/executions(?:\/([^/]+))?(\/answers)?$/
  );
  if (factoryNodeMatch) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    if (!context.factoryNodeService) {
      sendJson(response, 503, { error: { code: "node_unavailable", message: "Factory Node runtime is unavailable." } });
      return;
    }
    const productId = decodeURIComponent(factoryNodeMatch[1]!);
    const node = factoryNodeMatch[2] as "about-you" | "corpus";
    const executionId = factoryNodeMatch[3] ? decodeURIComponent(factoryNodeMatch[3]) : undefined;
    const isAnswers = Boolean(factoryNodeMatch[4]);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    const nodeProduct = {
      productId,
      name: product.name,
      promise: product.promise,
      ...(product.brief_spec ? { briefSpec: product.brief_spec } : {})
    };

    if (request.method === "GET" && executionId && !isAnswers) {
      const execution = await context.factoryNodeService.getExecution(productId, node, executionId, account.id, currentContext()?.api_key_id);
      if (!execution) { sendJson(response, 404, { error: { code: "execution_not_found", message: "Node execution was not found." } }); return; }
      sendJson(response, 200, publicFactoryNodeExecution(execution));
      return;
    }
    if (request.method === "GET" && !executionId && !isAnswers) {
      const execution = await context.factoryNodeService.getLatestExecution(productId, node, account.id, currentContext()?.api_key_id);
      sendJson(response, 200, execution
        ? publicFactoryNodeExecution(execution)
        : { node, product_id: productId, status: "not_started" });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { detail: "Factory Node route supports POST and execution GET only." });
      return;
    }
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    if (isAnswers) {
      if (node !== "about-you" || !executionId) {
        sendJson(response, 404, { error: { code: "execution_not_found", message: "Expert answers belong to an About You execution." } });
        return;
      }
      const answers = parseAboutYouAnswers(body.answers);
      const saved = await context.factoryNodeService.saveAboutYouAnswers({
        productId,
        executionId,
        answers
      });
      sendJson(response, 201, {
        node,
        product_id: productId,
        execution_id: executionId,
        about_you_ref: saved.answersRef
      });
      return;
    }

    const fileIds = stringArrayField(body.file_ids);
    const filePaths = stringArrayField(body.files ?? body.file_paths);
    const requestedExecutionId = executionId
      ?? (typeof body.execution_id === "string" ? body.execution_id : undefined);
    const result = node === "about-you"
      ? await context.factoryNodeService.startAboutYou({
        creatorId: account.id,
        ...apiKeyOfRequest(),
        product: nodeProduct,
        ...(fileIds === undefined ? {} : { fileIds }),
        ...(filePaths === undefined ? {} : { filePaths }),
        ...(requestedExecutionId === undefined ? {} : { executionId: requestedExecutionId })
      })
      : await context.factoryNodeService.startCorpus({
        creatorId: account.id,
        ...apiKeyOfRequest(),
        product: nodeProduct,
        aboutYouRef: requiredNodeBodyText(body.about_you_ref ?? body.about_you, "about_you_ref"),
        ...(fileIds === undefined ? {} : { fileIds }),
        ...(filePaths === undefined ? {} : { filePaths }),
        ...(requestedExecutionId === undefined ? {} : { executionId: requestedExecutionId })
      });
    sendJson(response, 202, publicFactoryNodeExecution(result));
    return;
  }

  if (url.pathname.startsWith("/v1/creator/factory-runs")
    || url.pathname.startsWith("/v1/creator/source-documents")
    || url.pathname.startsWith("/v1/creator/source-snapshots")
    // Product Graph is implemented by the Factory service and must use the
    // same authenticated Product-scoped boundary as the other Factory views.
    // Keep the route explicit here so it is not swallowed by the Registry's
    // Product/File/Snapshot compatibility handlers below.
    || /^\/v1\/creator\/products\/[^/]+\/graph$/.test(url.pathname)) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const result = await handleCreatorFactoryHttp({
      method: request.method ?? "GET",
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: { "idempotency-key": request.headers["idempotency-key"]?.toString() },
      ...(request.method === "GET" ? {} : { body: await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES) }),
      creator: account,
      ...apiKeyOfRequest()
    }, context.factoryService);
    if (result) { sendJson(response, result.status, result.body); return; }
  }

  // Product is the only user-facing authoring boundary. Files and Snapshots
  // live below Product; a Version/Run only records the immutable Snapshot it
  // used. The legacy product repository remains an internal read-time migration
  // boundary for existing Factory rows and is never returned by these routes.
  if (url.pathname === "/v1/creator/products" && (request.method === "GET" || request.method === "POST")) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    if (request.method === "GET") {
      const products = mergeCreatorProductListings(
        await context.store.listAgentCorpora(account.id),
        await context.factoryService.listProducts(account.id),
        account.id
      );
      // The new Registry release pointer is the publish authority. Project it
      // into the Creator listing as well as the detail route; the legacy
      // agent_corpora table is only a read-time migration source.
      await Promise.all(products.map(async (product) => {
        const productId = String(product.product_id ?? "");
        if (!isUuidV4(productId)) return;
        const release = await context.releaseStore.getLive(productId);
        if (!release || String(product.creator_id ?? account.id) !== account.id) return;
        product.status = "published";
        product.release = release;
      }));
      sendJson(response, 200, {
        products: products.map((product) => ({
          ...product,
          ...(Object.hasOwn(product, "creator_name") ? { creator_name: account.display_name } : {}),
          ...(Object.hasOwn(product, "creator_display_name") ? { creator_display_name: account.display_name } : {})
        }))
      });
      return;
    }
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    const name = requiredProductText(body.name ?? body.product_name, "name", 240);
    const promise = requiredProductText(body.promise ?? body.product_promise ?? body.description ?? body.brief, "promise", 100_000);
    const product = await context.factoryService.createProduct(account.id, {
      name,
      brief: promise,
      idempotencyKey: request.headers["idempotency-key"]?.toString()
    });
    sendJson(response, 201, {
      product: {
        product_id: publicProductId(product),
        name: product.name,
        promise: publicProductPromise(product),
        status: "draft",
        ...(product.briefSpec ? { brief_spec: product.briefSpec } : {}),
        created_at: product.createdAt,
        updated_at: product.updatedAt
      }
    });
    return;
  }

  const productRootMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)$/);
  if (productRootMatch && (request.method === "GET" || request.method === "PATCH" || request.method === "DELETE")) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(productRootMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    if (request.method === "PATCH") {
      if (!product.repositoryId) {
        sendJson(response, 409, { error: { code: "product_not_editable", message: "Published Products are edited by creating a new Version." } });
        return;
      }
      const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
      const promise = body.promise ?? body.description ?? body.brief;
      const updated = await context.factoryService.updateProductPromise(
        account.id,
        product.repositoryId,
        {
          ...(body.name !== undefined ? { name: requiredProductText(body.name, "name", 240) } : {}),
          promise: requiredProductText(promise, "promise", 100_000),
          ...(typeof body.expected_updated_at === "string" ? { expectedUpdatedAt: body.expected_updated_at } : {})
        }
      );
      sendJson(response, 200, publicCreatorProduct(updated));
      return;
    }
    if (request.method === "DELETE") {
      if (!product.repositoryId) {
        sendJson(response, 409, { error: { code: "product_not_editable", message: "Published Products cannot be deleted from the authoring workspace." } });
        return;
      }
      // Call on the service itself: a detached method loses `this`.
      const service = context.factoryService as unknown as {
        deleteProduct?: (creatorId: string, productId: string) => Promise<unknown>;
      };
      if (!service.deleteProduct) throw new Error("Product deletion is not configured");
      await service.deleteProduct(account.id, product.repositoryId);
      response.writeHead(204, { ...corsHeaders(), "cache-control": "no-store" });
      response.end();
      return;
    }
    sendJson(response, 200, {
      product: {
        product_id: product.productId,
        name: product.name,
        promise: product.promise,
        status: product.status,
        ...(product.brief_spec ? { brief_spec: product.brief_spec } : {}),
        ...(product.pricing ? { pricing: product.pricing } : {}),
        ...(product.release ? { release: product.release } : {}),
        ...(product.createdAt ? { created_at: product.createdAt } : {}),
        ...(product.updatedAt ? { updated_at: product.updatedAt } : {})
      }
    });
    return;
  }

  const productListingMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/listing$/);
  if (productListingMatch && request.method === "PUT") {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(productListingMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    if (typeof body.listed !== "boolean") { sendJson(response, 422, { error: { code: "listed_required", message: "listed must be a boolean." } }); return; }
    await context.releaseStore.setListed(account.id, productId, body.listed);
    sendJson(response, 200, { product_id: productId, listed: body.listed });
    return;
  }

  const productWithdrawMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/withdraw$/);
  if (productWithdrawMatch && request.method === "POST") {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(productWithdrawMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    await context.releaseStore.withdraw(account.id, productId);
    const updated = await productForCreator(context, account.id, productId);
    sendJson(response, 200, { product: { product_id: productId, name: updated?.name ?? product.name, promise: updated?.promise ?? product.promise, status: "draft" } });
    return;
  }

  const productBriefSpecMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/brief-spec$/);
  if (productBriefSpecMatch && request.method === "PUT") {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(productBriefSpecMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product?.repositoryId) {
      sendJson(response, 409, { error: { code: "product_not_editable", message: "Published Products are changed by creating a new Version." } });
      return;
    }
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    const updated = await context.factoryService.saveProductBriefSpec(
      account.id,
      product.repositoryId,
      normalizeBriefSpec(body.brief_spec as BriefSpec),
      typeof body.expected_updated_at === "string" ? body.expected_updated_at : undefined
    );
    sendJson(response, 200, publicCreatorProduct(updated));
    return;
  }

  const productPricingMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/pricing$/);
  if (productPricingMatch && request.method === "PUT") {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(productPricingMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product?.repositoryId) {
      sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } });
      return;
    }
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    const updated = await context.factoryService.saveProductPricing(
      account.id,
      product.repositoryId,
      body.pricing,
      typeof body.expected_updated_at === "string" ? body.expected_updated_at : undefined
    );
    sendJson(response, 200, publicCreatorProduct(updated));
    return;
  }

  const ingestMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/ingest(?:\/([^/]+))?$/);
  if (ingestMatch) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(ingestMatch[1]!);
    const jobId = ingestMatch[2] ? decodeURIComponent(ingestMatch[2]) : undefined;
    if (!await productForCreator(context, account.id, productId)) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    if (!context.ingest) { sendJson(response, 503, { error: { code: "ingest_unavailable", message: "Ingest requires the Registry database." } }); return; }
    if (request.method === "POST" && !jobId) {
      const body = await readJson(request, INGEST_BODY_MAX_BYTES);
      const key = idempotencyKey(request.headers["idempotency-key"]);
      await context.ingest.submit(account.id, productId, body.items, body.context, key).then(
        job => sendJson(response, 202, { job: publicJob(job) }),
        error => {
          const failure = error instanceof IdempotencyKeyReused ? new IngestError(422, "idempotency_key_reused", error.message) : error;
          if (!(failure instanceof IngestError || failure instanceof ChatError)) throw failure;
          sendJson(response, failure.status, { error: { code: failure.code, message: failure.message }, detail: failure.message });
        });
      return;
    }
    if (request.method === "GET" && !jobId) {
      sendJson(response, 200, { jobs: (await context.ingest.recent(account.id, productId)).map(publicJob) });
      return;
    }
    if (request.method === "GET" && jobId) {
      const job = await context.ingest.get(account.id, productId, jobId);
      if (!job) { sendJson(response, 404, { error: { code: "ingest_job_not_found", message: "Ingest job was not found." } }); return; }
      sendJson(response, 200, { job: publicJob(job) });
      return;
    }
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed." } });
    return;
  }

  if (url.pathname === "/v1/public/products" && request.method === "GET") {
    const limit = boundedQueryInteger(url, "limit", 20, 1, 20);
    const offset = boundedQueryInteger(url, "offset", 0, 0, 100_000);
    const rows = await publicCatalogRows(context);
    const page = rows.slice(offset, offset + limit);
    sendJson(response, 200, page.map(publicProductRow), {
      "x-hatch-page-limit": String(limit),
      "x-hatch-page-offset": String(offset),
      ...(rows.length > limit ? { "x-hatch-next-offset": String(offset + limit) } : {}),
    });
    return;
  }

  if (url.pathname === "/v1/public/creators" && request.method === "GET") {
    const limit = boundedQueryInteger(url, "limit", 20, 1, 20);
    const offset = boundedQueryInteger(url, "offset", 0, 0, 100_000);
    const rows = (await publicCatalogRows(context)).filter((row) => row.listed !== false).slice(0, Math.min(20_001, offset + limit + 1));
    const creators = new Map<string, { id: string; name: string; avatar_url: string | null; product_count: number }>();
    for (const row of rows) {
      const creatorId = String(row.creator_id ?? "");
      const current = creators.get(creatorId) ?? {
        id: creatorId,
        name: String(row.creator_name),
        avatar_url: typeof row.creator_avatar_url === "string" ? row.creator_avatar_url : null,
        product_count: 0
      };
      current.product_count += 1;
      creators.set(creatorId, current);
    }
    const page = [...creators.values()].slice(offset, offset + limit);
    sendJson(response, 200, page, {
      "x-hatch-page-limit": String(limit),
      "x-hatch-page-offset": String(offset),
      ...(creators.size > offset + limit ? { "x-hatch-next-offset": String(offset + limit) } : {}),
    });
    return;
  }

  const publicProductMatch = url.pathname.match(/^\/v1\/public\/products\/([^/]+)$/);
  if (publicProductMatch && request.method === "GET") {
    const productId = decodeURIComponent(publicProductMatch[1]!);
    if (!isUuidV4(productId)) { sendJson(response, 404, { detail: "Product not found." }); return; }
    const row = (await publicCatalogRows(context)).find((entry) => entry.product_id === productId);
    if (!row) { sendJson(response, 404, { detail: "Product not found." }); return; }
    sendJson(response, 200, publicProductRow(row));
    return;
  }

  const publicCreatorMatch = url.pathname.match(/^\/v1\/public\/creators\/([^/]+)$/);
  if (publicCreatorMatch && request.method === "GET") {
    const creatorId = decodeURIComponent(publicCreatorMatch[1]!);
    if (!isUuidV4(creatorId)) { sendJson(response, 404, { detail: "Expert not found." }); return; }
    const rows = (await publicCatalogRows(context))
      .filter((row) => row.creator_id === creatorId);
    if (!rows.length) { sendJson(response, 404, { detail: "Expert not found." }); return; }
    sendJson(response, 200, {
      creator: { id: creatorId, name: rows[0]!.creator_name, avatar_url: rows[0]!.creator_avatar_url ?? null },
      products: rows.map(publicProductRow)
    });
    return;
  }

  const connectionMatch = url.pathname.match(/^\/v1\/control-plane\/connections\/([^/]+)$/);
  if (connectionMatch && request.method === "PUT") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const tenantId = request.headers["x-hatch-tenant-id"]?.toString() ?? "";
    const body = await readJson(request);
    try {
      const connection = await context.store.upsertCreatorToolConnection({
        tenantId,
        connectionId: decodeURIComponent(connectionMatch[1]!),
        kind: body.kind === "mcp" ? "mcp" : "http",
        secretRef: body.secret_ref === null || body.secret_ref === undefined ? null : String(body.secret_ref),
        secret: body.secret === null || body.secret === undefined ? null : String(body.secret),
        config: body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config as Record<string, unknown> : {},
        status: body.status === "disabled" ? "disabled" : "active"
      });
      sendJson(response, 200, { id: connection.id, creator_id: connection.tenant_id, kind: connection.kind, secret_ref: connection.secret_ref, secret: connection.secret, config: connection.config, status: connection.status });
    } catch (error) {
      sendJson(response, 422, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const bindingMatch = url.pathname.match(/^\/v1\/creators\/([^/]+)\/products\/([^/]+)\/tools\/([^/]+)$/);
  if (bindingMatch && request.method === "PUT") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const creatorId = decodeURIComponent(bindingMatch[1]!);
    if (request.headers["x-hatch-creator-id"]?.toString() !== creatorId) {
      sendJson(response, 403, { detail: "creator path does not match authenticated creator" });
      return;
    }
    const body = await readJson(request);
    try {
      await context.store.bindCreatorTool({
        tenantId: creatorId,
        agentId: decodeURIComponent(bindingMatch[2]!),
        toolId: decodeURIComponent(bindingMatch[3]!),
        connectionId: String(body.connection_id ?? "")
      });
      response.writeHead(204, corsHeaders());
      response.end();
    } catch (error) {
      sendJson(response, 422, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const runtimeToolMatch = url.pathname.match(/^\/v1\/runtime\/(?:tenants|creators)\/([^/]+)\/products\/([^/]+)\/tools\/([^/]+)$/);
  if (runtimeToolMatch && request.method === "GET") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const tenantId = decodeURIComponent(runtimeToolMatch[1]!);
    if (request.headers["x-hatch-tenant-id"]?.toString() !== tenantId) {
      sendJson(response, 403, { detail: "runtime tenant header does not match route" });
      return;
    }
    try {
      const productId = decodeURIComponent(runtimeToolMatch[2]!);
      const toolId = decodeURIComponent(runtimeToolMatch[3]!);
      const release = await context.releaseStore.getLive(productId);
      const connection = release
        ? await resolvePublishedCreatorToolConnection(context, release, tenantId, productId, toolId)
        : await context.store.resolveCreatorToolConnection({ tenantId, agentId: productId, toolId });
      sendJson(response, 200, { id: connection.id, tenant_id: connection.tenant_id, kind: connection.kind, secret_ref: connection.secret_ref, secret: connection.secret, config: connection.config, status: connection.status });
    } catch (error) {
      sendJson(response, 404, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  sendJson(response, 404, { detail: "Route not found." });
}

async function resolvePublishedCreatorToolConnection(
  context: RegistryContext,
  release: CreatorRegistryRelease,
  tenantId: string,
  productId: string,
  toolId: string
) {
  if (release.creator_id !== tenantId || release.product_id !== productId) {
    throw new Error("published Expert release does not match the requested product");
  }
  if (!context.nodeObjectStore) throw new Error("Expert Registry object storage is unavailable");
  const corpus = corpusOutputSchema.parse(
    JSON.parse((await context.nodeObjectStore.get(release.corpus_ref)).toString("utf8"))
  );
  const declared = corpus.tools.find((tool) => tool.id === toolId);
  if (!declared || (declared.kind !== "http_function" && declared.kind !== "mcp_tool") || !declared.connection_ref) {
    throw new Error(`published Expert tool does not exist or has no connection reference: ${toolId}`);
  }
  return context.store.resolveCreatorToolConnectionByReference({
    tenantId,
    connectionId: declared.connection_ref,
    expectedKind: declared.kind === "http_function" ? "http" : "mcp"
  });
}

/** What was said in a recording, for the text box: the voice-message pipeline's transcription, with the same size and length caps. */
async function transcribe(request: http.IncomingMessage, response: http.ServerResponse, context: RegistryContext): Promise<void> {
  const account = await authenticate(request, response, context);
  if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
  await answerTranscription(request, response, context.dictation, account.id);
}

export async function answerTranscription(request: http.IncomingMessage, response: http.ServerResponse, dictation: Dictation, accountId: string): Promise<void> {
  const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
  const audio = Buffer.from(typeof body.base64 === "string" ? body.base64 : "", "base64");
  if (!audio.length) { sendJson(response, 400, { error: { code: "invalid_audio", message: "A recording is required." } }); return; }
  try { sendJson(response, 200, { text: await dictation.text(audio) }); }
  catch (error) {
    if (!(error instanceof AssetError)) throw error;
    if (error.code === "unavailable") { sendJson(response, 502, { error: failures.translate(UpstreamError.of(error), { account: accountId, route: "transcriptions" }) }); return; }
    sendJson(response, error.code === "too_large" ? 413 : 400, { error: { code: error.code === "too_large" ? "audio_too_large" : "invalid_audio", message: error.message } });
  }
}

async function authenticate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): Promise<Account | undefined> {
  const session = await context.accounts.resolveSession(bearer(request));
  if (session) { bindContext({ account_id: session.account.id, ...(session.session.client_type === "api_key" ? { api_key_id: session.session.id } : {}) }); return session.account; }
  const claims = verifyAuthToken(bearer(request), context.authSecret);
  if (!claims) return undefined;
  bindContext({ account_id: claims.sub });
  return context.accounts.getById(claims.sub);
}

async function authenticateLegacy(token: string | undefined, accounts: AccountStoreTs, secret: string): Promise<Account | undefined> {
  const claims = verifyAuthToken(token, secret);
  if (!claims) return undefined;
  return accounts.getById(claims.sub);
}

function sessionResponse(account: Account, issued: { token: string; session: { absolute_expires_at: string } }): Record<string, unknown> {
  return {
    // Keep the top-level token for older Desktop builds during migration. New
    // clients read session.token and use the opaque, revocable value.
    token: issued.token,
    session: {
      token: issued.token,
      expires_at: issued.session.absolute_expires_at
    },
    account: accountPublic(account)
  };
}

function bearer(request: http.IncomingMessage): string | undefined {
  const value = request.headers.authorization ?? "";
  const [scheme, token] = value.split(" ", 2);
  return scheme?.toLowerCase() === "bearer" ? token : undefined;
}

function requireRuntimeServiceAuth(request: http.IncomingMessage, configuredToken: string): void {
  if (!configuredToken || bearer(request) !== configuredToken) {
    const error = new Error("A valid Registry runtime service token is required.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

function requireDeploymentServiceAuth(request: http.IncomingMessage, configuredToken: string): void {
  if (!configuredToken || bearer(request) !== configuredToken) {
    const error = new Error("A valid Registry deployment service token is required.");
    (error as Error & { status?: number }).status = 401;
    throw error;
  }
}

function requiredDeploymentField(body: Record<string, unknown>, field: string): string {
  const value = typeof body[field] === "string" ? body[field].trim() : "";
  if (!value || value.length > 256) {
    const error = new Error(`${field} is required and must not exceed 256 characters.`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return value;
}

/** Public catalog authority is the live Registry release projection. */
async function publicCatalogRows(context: RegistryContext): Promise<Record<string, unknown>[]> {
  const releases = await context.releaseStore.listPublic({ limit: 20_001, offset: 0 });
  const rows = new Map<string, Record<string, unknown>>(
    releases
      .filter((release) => (
        typeof release.release_ref === "string"
        && release.release_ref.startsWith(`registry/${release.product_id}/releases/`)
        && typeof release.runtime_manifest_ref === "string"
        && release.runtime_manifest_ref.endsWith("/runtime/manifest.json")
      ))
      .map((release) => [release.product_id, release as unknown as Record<string, unknown>]),
  );
  const ordered = [...rows.values()].sort((left, right) => {
    const time = Date.parse(String(right.published_at ?? "")) - Date.parse(String(left.published_at ?? ""));
    return time || String(left.product_id ?? "").localeCompare(String(right.product_id ?? ""));
  });
  return attachCreatorAvatars(ordered, (creatorId) => context.accounts.getById(creatorId));
}

export async function attachCreatorAvatars<T extends Record<string, unknown>>(
  rows: T[],
  readAccount: (creatorId: string) => Promise<{ display_name: string; avatar_url: string | null } | undefined>
): Promise<Array<T & { creator_name: string; creator_avatar_url: string | null }>> {
  const creatorIds = [...new Set(rows.map(row => String(row.creator_id ?? "")).filter(Boolean))];
  const accounts = await Promise.all(creatorIds.map(readAccount));
  const creators = new Map(creatorIds.map((creatorId, index) => [creatorId, accounts[index]]));
  return rows.flatMap(row => {
    const account = creators.get(String(row.creator_id ?? ""));
    return account ? [{ ...row, creator_name: account.display_name, creator_avatar_url: account.avatar_url }] : [];
  });
}

function publicProductRow(row: Record<string, unknown>): Record<string, unknown> {
  const { agent_id: _internalProductAlias, creator_slug: _creatorSlug, product_slug: _productSlug, ...publicRow } = row;
  const promise = publicRow.product_promise ?? publicRow.product_description ?? "";
  const productId = String(publicRow.product_id ?? "");
  return {
    ...publicRow,
    creator: { id: publicRow.creator_id, name: publicRow.creator_name, avatar_url: publicRow.creator_avatar_url ?? null },
    creator_avatar_url: publicRow.creator_avatar_url ?? null,
    product: { id: publicRow.product_id, name: publicRow.product_name },
    promise,
    description: publicRow.product_description ?? promise,
    product_boundaries: publicRow.product_boundaries ?? [],
    boundaries: publicRow.product_boundaries ?? [],
    availability: "published",
    available: true,
    release_id: publicRow.release_digest,
    public_url: `/products/${encodeURIComponent(productId)}`
  };
}

type CreatorProductBoundary = {
  productId: string;
  name: string;
  promise: string;
  status: string;
  brief_spec?: import("./brief.js").BriefSpec;
  pricing?: ProductPricing;
  createdAt?: string;
  updatedAt?: string;
  /** The new Registry release projection, when this Product is live. */
  release?: CreatorRegistryRelease;
  /** Internal repository row key; never serialized in a public response. */
  repositoryId?: string;
};

type PublishedProductListingRow = {
  product_id?: string;
  agent_id?: string;
  product_name?: string;
  name?: string;
  product_description?: string;
  product_promise?: string;
  status?: string;
  corpus_digest?: string;
  published_at?: string;
  brief_spec?: unknown;
};

/**
 * Build the Creator product list from both authorities without allowing the
 * published corpus snapshot to overwrite current authoring fields. Published
 * rows contribute release projection only; Product records own identity,
 * name, promise, and brief_spec.
 */
export function mergeCreatorProductListings(
  publishedRows: readonly PublishedProductListingRow[],
  authoringProducts: readonly CreatorProductRecord[],
  creatorId: string
): Record<string, unknown>[] {
  const products = new Map<string, Record<string, unknown>>();
  for (const row of publishedRows) {
    const productId = String(row.product_id ?? row.agent_id ?? "");
    if (!productId) continue;
    products.set(productId, {
      product_id: productId,
      creator_id: creatorId,
      name: row.product_name ?? row.name ?? productId,
      promise: row.product_promise ?? row.product_description ?? "",
      description: row.product_description ?? row.product_promise ?? "",
      status: row.status ?? "published",
      corpus_digest: row.corpus_digest ?? null,
      published_at: row.published_at ?? null,
      ...(row.brief_spec ? { brief_spec: row.brief_spec } : {})
    });
  }
  for (const product of authoringProducts) {
    const productId = publicProductId(product);
    if (!productId) continue;
    const authoringProduct: Record<string, unknown> = {
      product_id: productId,
      creator_id: creatorId,
      name: product.name,
      promise: publicProductPromise(product),
      description: publicProductPromise(product),
      status: product.runId ? "working" : "draft",
      created_at: product.createdAt,
      updated_at: product.updatedAt
    };
    if (product.briefSpec) authoringProduct.brief_spec = product.briefSpec;
    if (product.pricing) authoringProduct.pricing = product.pricing;
    const publishedProduct = products.get(productId);
    if (!publishedProduct) {
      products.set(productId, authoringProduct);
      continue;
    }
    const mergedProduct: Record<string, unknown> = {
      ...publishedProduct,
      ...authoringProduct,
      // Keep the published status/digest/timestamps as release projection.
      status: publishedProduct.status ?? authoringProduct.status
    };
    // An absent authoring BriefSpec must clear a stale published projection.
    if (!product.briefSpec) delete mergedProduct.brief_spec;
    products.set(productId, mergedProduct);
  }
  return [...products.values()];
}

async function productForCreator(
  context: RegistryContext,
  creatorId: string,
  productId: string
): Promise<CreatorProductBoundary | undefined> {
  const products = await context.factoryService.listProducts(creatorId);
  const product = products.find((entry) => publicProductId(entry) === productId);
  if (product) {
    const release = await context.releaseStore.getLive(productId);
    return {
      productId,
      name: product.name,
      promise: publicProductPromise(product),
      status: release ? "published" : product.runId ? "working" : "draft",
      ...(product.briefSpec ? { brief_spec: product.briefSpec } : {}),
      ...(product.pricing ? { pricing: product.pricing } : {}),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      ...(release ? { release } : {}),
      repositoryId: product.id
    };
  }
  return undefined;
}

function publicCreatorProduct(product: {
  id: string;
  productId?: string;
  name: string;
  brief?: string;
  promise?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  briefSpec?: import("./brief.js").BriefSpec;
  pricing?: ProductPricing;
}): Record<string, unknown> {
  return {
    product_id: publicProductId(product),
    name: product.name,
    promise: publicProductPromise(product),
    status: product.status === "active" ? "draft" : product.status ?? "draft",
    ...(product.briefSpec ? { brief_spec: product.briefSpec } : {}),
    ...(product.pricing ? { pricing: product.pricing } : {}),
    ...(product.createdAt ? { created_at: product.createdAt } : {}),
    ...(product.updatedAt ? { updated_at: product.updatedAt } : {})
  };
}

function publicProductId(product: { id: string }): string {
  return product.id;
}

function publicProductPromise(product: { brief?: string; promise?: string }): string {
  return product.promise ?? product.brief ?? "";
}

function publicFactoryNodeRun(run: FactoryNodeRunView): Record<string, unknown> {
  return {
    node: run.node,
    product_id: run.productId,
    execution_id: run.executionId,
    input: run.input,
    output: run.output,
    output_ref: run.outputRef,
    ...(run.candidateRef ? { candidate_ref: run.candidateRef } : {}),
    ...(run.feedbackRef ? { feedback_ref: run.feedbackRef } : {}),
    actor_session_ids: run.actorSessionIds,
    critic_session_ids: run.criticSessionIds
  };
}

function publicFactoryNodeExecution(execution: FactoryNodeExecutionView): Record<string, unknown> {
  return {
    node: execution.node,
    product_id: execution.productId,
    execution_id: execution.executionId,
    status: execution.status,
    round: execution.round,
    ...(execution.phase ? { phase: execution.phase } : {}),
    ...(execution.inputRef ? { input_ref: execution.inputRef } : {}),
    ...(execution.candidateRef ? { candidate_ref: execution.candidateRef } : {}),
    ...(execution.feedbackRef ? { feedback_ref: execution.feedbackRef } : {}),
    ...(execution.outputRef ? { output_ref: execution.outputRef } : {}),
    ...(execution.handoffRef ? { handoff_ref: execution.handoffRef } : {}),
    ...(execution.decision ? { decision: execution.decision } : {}),
    ...(execution.lastError ? { last_error: execution.lastError } : {}),
    ...(execution.output === undefined ? {} : { output: execution.output }),
    ...(execution.details === undefined ? {} : { details: execution.details })
  };
}

function parseAboutYouAnswers(value: unknown): AboutYouAnswerPair[] {
  if (!Array.isArray(value)) throw new Error("answers must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Each answer must be an object");
    const row = item as Record<string, unknown>;
    return {
      question: requiredNodeBodyText(row.question, "answers.question"),
      answer: requiredNodeBodyText(row.answer, "answers.answer")
    };
  });
}

function stringArrayField(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Node file input must be an array");
  return value.map((item) => requiredNodeBodyText(item, "files"));
}

function requiredNodeBodyText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${field} is required`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return value.trim();
}

function requiredProductText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  if (normalized.length > max) throw new Error(`${field} is too long`);
  return normalized;
}

function boundedQueryInteger(
  url: URL,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    const error = new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
  return value;
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if (error instanceof SyntaxError) return 400;
  if (error instanceof Error && error.message === "Request body is too large") return 413;
  if (error instanceof BriefValidationError) return 422;
  if (error instanceof ProductPricingError) return 422;
  if (error instanceof ProductFilesError) {
    if (error.code === "idempotency_conflict") return 409;
    return error.code === "product_file_not_found" || error.code === "product_snapshot_not_found" || error.code === "product_mismatch" ? 404 : 422;
  }
  if (error instanceof FactoryNodeServiceError) return error.status;
  if (error instanceof CreatorFactoryRepositoryError) {
    if (["idempotency_conflict", "run_id_conflict", "version_conflict"].includes(error.code)) return 409;
    if (error.code === "run_not_found") return 404;
    return 422;
  }
  return 500;
}

async function readBytes(request: http.IncomingMessage, max = 64 * 1024 * 1024): Promise<Uint8Array> {
  const declaredLength = request.headers["content-length"];
  if (typeof declaredLength === "string") {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new SyntaxError("Content-Length is invalid");
    if (parsedLength > max) throw new Error("Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > max) throw new Error("Request body is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks, size);
}

async function readRawBody(request: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return readJsonBytes(await readBytes(request, maxBytes));
}

function readJsonBytes(bytes: Uint8Array): Record<string, unknown> {
  const payload = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON body must be an object");
  return payload as Record<string, unknown>;
}

/** Wraps a handler so it runs only for a live interactive (non API-key) session. */
function requireInteractive(context: RegistryContext, handler: (session: AuthenticatedSession) => Promise<void>) {
  return async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const current = await context.accounts.resolveSession(bearer(request));
    if (!current) { sendAuthJson(response, 401, { detail: "A valid account session is required." }); return; }
    if (current.session.client_type === "api_key") { sendAuthJson(response, 403, { detail: "An API key cannot manage API keys or mint sessions." }); return; }
    await handler(current);
  };
}

async function optionalJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, 64 * 1024);
  return bytes.length ? readJsonBytes(bytes) : {};
}

function platformLoginOf(context: RegistryContext): PlatformLogin {
  if (!context.platformLogin) throw new LoginError("login_unavailable", "Sign-in is not available.", 503);
  return context.platformLogin;
}

function sendAuthBusy(response: http.ServerResponse): void {
  sendAuthJson(response, 503, { detail: "Authentication is temporarily busy. Try again shortly." }, {
    "retry-after": "1"
  });
}

function sendAuthInputError(response: http.ServerResponse, error: unknown): void {
  const details: Record<string, string> = {
    email_invalid: "Enter a valid email address no longer than 254 characters.",
    password_required: "Enter a password.",
    password_too_short: "Password must contain at least 8 characters.",
    password_too_long: "Password must not exceed 1024 UTF-8 bytes.",
    display_name_required: "Display name is required.",
    display_name_too_long: "Display name must not exceed 128 characters.",
    early_access_invalid: "early_access must be true or false."
  };
  const code = error instanceof Error ? error.message : "auth_input_invalid";
  sendAuthJson(response, 400, { detail: details[code] ?? "Authentication input is invalid." });
}

function sendAuthJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  sendJson(response, status, payload, { "cache-control": "no-store", ...headers });
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { ...corsHeaders(), "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(status >= 400 ? withStandardError(status, payload) : payload));
}
const ERROR_CODES: Record<number, string> = { 400: "invalid_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 422: "invalid_request", 503: "unavailable" };
/** A Registry failure has one shape, `{error: {code, message}}`; the older `{detail}` (and a top-level `code`) is folded into it, and other fields stay. */
function withStandardError(status: number, payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const { detail, code, error, ...rest } = payload as Record<string, unknown>;
  if (typeof detail !== "string") return payload;
  return { error: error ?? { code: typeof code === "string" ? code : ERROR_CODES[status] ?? (status >= 500 ? "internal_error" : "request_failed"), message: detail }, ...rest };
}
function sendError(response: http.ServerResponse, error: unknown, known: Record<string, [number, string]> = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  const expected = known[message];
  if (expected) {
    sendJson(response, expected[0], { detail: expected[1] });
    return;
  }
  if (error instanceof Error && error.name === "AgentCorpusVerificationError") {
    sendJson(response, 422, { detail: message });
    return;
  }
  throw error;
}
function corsHeaders(): Record<string, string> { return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS", "access-control-allow-headers": "authorization,content-type,idempotency-key,x-hatch-creator-id,x-csrf-token", "access-control-expose-headers": "retry-after,x-hatch-page-limit,x-hatch-page-offset,x-hatch-next-offset" }; }

if (import.meta.url === `file://${process.argv[1]}`) {
  startObservability("registry");
  createRegistryServerFromEnvironment().then(({ server, shutdown }) => {
    exitOnSignal(() => shutdown(drainMsFromEnvironment(process.env)));
    console.log(`Hatch TypeScript Registry listening on ${JSON.stringify(server.address())}`);
  }).catch((error) => { log.error("registry_startup_failed", { error }); process.exitCode = 1; });
}


/** The Expert's Agents as seen by the Assistant: the same authority and rules as the Studio product routes. */
function registryAgentCatalog(context: RegistryContext): AgentCatalog {
  const tokens = new Map<string, { token: string; expiresAt: number }>();
  const view = (product: CreatorProductBoundary): CatalogAgent => ({
    productId: product.productId, name: product.name, promise: product.promise,
    status: product.status === "published" ? "published" : product.status === "working" ? "working" : "draft",
    ...(product.pricing ? { pricing: product.pricing } : {}),
    ...(product.brief_spec ? { briefSpec: product.brief_spec } : {}),
  });
  const get = async (accountId: string, productId: string) => {
    const product = await productForCreator(context, accountId, productId);
    return product ? view(product) : undefined;
  };
  return {
    list: async accountId => {
      const products = await context.factoryService.listProducts(accountId);
      const views = await Promise.all(products.map(product => get(accountId, publicProductId(product))));
      return views.filter((agent): agent is CatalogAgent => Boolean(agent));
    },
    get,
    create: async (accountId, name, promise) => {
      const product = await context.factoryService.createProduct(accountId, { name: requiredProductText(name, "name", 240), brief: requiredProductText(promise, "promise", 100_000) });
      return (await get(accountId, publicProductId(product)))!;
    },
    apply: async (accountId, productId, change: AgentChange) => {
      const product = await productForCreator(context, accountId, productId);
      if (!product?.repositoryId) throw new Error("这个 Agent 现在不能修改");
      if (change.name !== undefined || change.promise !== undefined) {
        await context.factoryService.updateProductPromise(accountId, product.repositoryId, {
          ...(change.name !== undefined ? { name: requiredProductText(change.name, "name", 240) } : {}),
          promise: requiredProductText(change.promise ?? product.promise, "promise", 100_000),
        });
      }
      if (change.pricing !== undefined) await context.factoryService.saveProductPricing(accountId, product.repositoryId, change.pricing);
      if (change.briefSpec !== undefined) await context.factoryService.saveProductBriefSpec(accountId, product.repositoryId, normalizeBriefSpec(change.briefSpec as BriefSpec));
      if (change.release === "withdraw") await context.releaseStore.withdraw(accountId, productId);
      if (change.release === "publish") {
        if (!context.productLive) throw new Error("发布服务暂时不可用");
        const latest = (await productForCreator(context, accountId, productId))!;
        await context.productLive.publish(new ExpertProduct(accountId, productId, latest.name, latest.promise, latest.brief_spec));
      }
    },
    live: async (accountId, productId) => {
      const product = await productForCreator(context, accountId, productId);
      if (!product || !context.productLive) return null;
      const status = (await context.productLive.status(new ExpertProduct(accountId, productId, product.name, product.promise, product.brief_spec))).toJSON();
      const bot = status.is_live ? await context.ownApps?.username(accountId, "telegram", productId) : undefined;
      return { ...status, ...(bot ? { telegram_url: `https://t.me/${bot}` } : {}) };
    },
    token: async accountId => {
      const cached = tokens.get(accountId);
      if (cached && cached.expiresAt - Date.now() > 3_600_000) return cached.token;
      const account = await context.accounts.getById(accountId);
      if (!account) throw new Error("Account was not found");
      const issued = await context.accounts.createSession(account);
      tokens.set(accountId, { token: issued.token, expiresAt: Math.min(Date.parse(issued.session.absolute_expires_at), Date.parse(issued.session.idle_expires_at)) });
      return issued.token;
    },
  };
}

/** Runs fn only in the process that holds the named Postgres advisory lock. */
function postgresExclusive(pool: NonNullable<ReturnType<RegistryStoreTs["databasePool"]>>) {
  return async (name: string, fn: () => Promise<void>) => {
    const client = await pool.connect();
    try {
      const locked = (await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [name])).rows[0]?.locked;
      if (!locked) return;
      try { await fn(); } finally { await client.query("SELECT pg_advisory_unlock(hashtext($1))", [name]); }
    } finally { client.release(); }
  };
}

function studioDeps(context: RegistryContext): StudioDeps {
  return {
    product: async (accountId, productId) => productForCreator(context, accountId, productId),
    workspace: (scope, token) => context.factoryAgents.workspace(scope, token),
    assistant: () => context.assistantChat,
    panel: () => context.assistant && context.channels && context.reach ? studioPanel(context, context.assistant, context.channels, context.reach) : undefined,
    ...context.conversationPorts,
    assets: context.studioAssets,
  };
}

function studioPanel(context: RegistryContext, assistant: AssistantService, channels: ChannelService, reach: AccountReach): StudioPanel {
  return new StudioPanel({ tasks: { open: accountId => assistant.openTasks(accountId) }, channels: accountId => channelsOf(context, channels, accountId), timezones: { valid: validTimezone, set: (accountId, timezone) => reach.setTimezone(accountId, timezone) } });
}

function conversationDeps(response: http.ServerResponse, context: RegistryContext): ConversationRouteDeps {
  return {
    ...studioDeps(context),
    authenticate: request => authenticate(request, response, context),
    token: bearer,
    json: sendJson,
    readJson: request => readJson(request),
    readBytes: readRawBody,
  };
}

/** The account a token belongs to, for the Studio WebSocket's first-message sign-in. */
async function identifyToken(context: RegistryContext, token: string): Promise<{ accountId: string; token: string } | undefined> {
  const claims = verifyAuthToken(token, context.authSecret);
  const account = (await context.accounts.resolveSession(token))?.account ?? (claims ? await context.accounts.getById(claims.sub) : undefined);
  return account ? { accountId: account.id, token } : undefined;
}

/** A platform where a Product has a bot of its own: its Product page holds a bot, not a link to ours. */
const botKind = (kind: ChannelKind, target: AgentTarget) => target.kind === "product" && isPerProduct(CREDENTIAL_FORMS[kind]);

/** The chat platforms an account's Assistant, or one of its Products, can be reached on, as Studio lists them. */
async function channelsOf(context: RegistryContext, channels: ChannelService, accountId: string, target: AgentTarget = STUDIO_TARGET) {
  return (await channels.view(accountId, target)).map(status => botKind(status.kind, target)
    ? { kind: status.kind, bot: true, available: Boolean(context.ownApps), configured: status.configured, ...(status.handle ? { handle: status.handle } : {}), ...(status.state ? { state: status.state } : {}) }
    : {
      kind: status.kind, available: status.available, linked: status.linked,
      ...(status.senderId ? { sender_id: status.senderId } : {}),
      ...(status.state ? { state: status.state } : {}),
      ...(status.handle ? { handle: status.handle } : {}),
      ...(CREDENTIAL_FORMS[status.kind] && !isTenantForm(CREDENTIAL_FORMS[status.kind]!) && !isPerProduct(CREDENTIAL_FORMS[status.kind]) && context.credentialSeal ? { own_app: true, webhook_url: `${context.publicOrigin}/v1/channels/${status.kind}/${accountId}/webhook` } : {}),
      ...(status.lastEventAt ? { last_event_at: status.lastEventAt } : {}),
    });
}

async function assistantRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, context: RegistryContext): Promise<void> {
  const assistant = context.assistant;
  const channels = context.channels;
  if (!assistant || !context.reach || !channels) { sendJson(response, 503, { error: { code: "assistant_unavailable", message: "The Assistant requires the Registry database." } }); return; }
  const webhook = url.pathname.match(/^\/v1\/channels\/([a-z]+)(?:\/([0-9a-f-]{36}))?\/webhook$/);
  // A platform sends the person who installed the app back here with a code; the `state` they carry is the link code Studio issued.
  const install = url.pathname.match(/^\/v1\/channels\/([a-z]+)\/oauth\/callback$/);
  if (install && request.method === "GET") {
    const kind = install[1]!;
    const adapter = isChannelKind(kind) ? await channels.hub.get(kind) : undefined;
    const [code, state] = [url.searchParams.get("code"), url.searchParams.get("state")];
    const owner = isChannelKind(kind) && state ? await channels.connections.ownerOfCode(kind, state) : undefined;
    if (!adapter?.install || !context.credentialSeal || !code || !owner) { sendJson(response, 400, { error: { code: "install_failed", message: "The install link is invalid or has expired." } }); return; }
    const { scope, credentials } = await adapter.install(code);
    await channels.connections.saveCredentials(owner, adapter.kind, context.credentialSeal.seal(credentials), scope);
    response.writeHead(302, { location: context.studioUrl ?? context.publicOrigin ?? "/" });
    response.end();
    return;
  }
  if (webhook && request.method === "GET") {
    const kind = webhook[1]!;
    const adapter = isChannelKind(kind) ? await channels.hub.get(kind, webhook[2]) : undefined;
    const echo = adapter?.challenge?.(url.searchParams);
    if (echo === undefined) { sendJson(response, 401, { ok: false }); return; }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(echo);
    return;
  }
  if (webhook && request.method === "POST") {
    const kind = webhook[1]!;
    if (context.productChannelsUnavailable && webhook[2] && isChannelKind(kind) && isPerProduct(CREDENTIAL_FORMS[kind])) {
      log.error("product_webhook_unhandled", { channel: kind, reason: context.productChannelsUnavailable });
      sendJson(response, 503, { error: { code: "product_channels_unavailable", message: context.productChannelsUnavailable } });
      return;
    }
    const adapter = isChannelKind(kind) ? await channels.hub.get(kind, webhook[2]) : undefined;
    if (!adapter?.parse) { sendJson(response, 404, { ok: false }); return; }
    const raw = await readRawBody(request, 2 * 1024 * 1024);
    if (!adapter.verify?.(raw, request.headers, url.searchParams)) { sendJson(response, 401, { ok: false }); return; }
    const { events, respond, pull } = await adapter.parse(raw);
    // Stored before we answer, so a platform retry finds the event already here and nothing is lost if we crash.
    await channels.accept(adapter, events);
    sendJson(response, 200, respond ?? { ok: true });
    // After the answer: the platform's deadline is short and the pull may be long.
    if (pull) void channels.pull(adapter, pull).catch(error => log.error("channels_pull_failed", { error: error instanceof Error ? error.message : error }));
    return;
  }
  const account = await authenticate(request, response, context);
  if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
  /** Where the account's chats are bound: to the Assistant (Studio), or to one Product when the request names it. */
  const bindingTarget = (productId: string | null | undefined): AgentTarget => productId ? { kind: "product", productId } : STUDIO_TARGET;
  const channelsView = (target: AgentTarget = STUDIO_TARGET) => channelsOf(context, channels, account.id, target);
  const taskAction = url.pathname.match(/^\/v1\/creator\/assistant\/tasks\/([0-9a-f-]{36})\/(approve|decline|answer)$/);
  if (taskAction && request.method === "POST") {
    const [, taskId, action] = taskAction;
    const body = await readJson(request);
    // A click retried, or clicked twice, is one decision: the page's key names it, and the Assistant hears it once.
    let key: string;
    try { key = keyOrNew(request.headers["idempotency-key"]); }
    catch (error) { if (!(error instanceof ChatError)) throw error; sendJson(response, error.status, { error: { code: error.code, message: error.message } }); return; }
    const task = action === "answer"
      ? await assistant.answer(account.id, taskId!, String(body.answer ?? "").trim() || (() => { throw Object.assign(new Error("answer is required"), { status: 400 }); })(), key)
      : (await assistant.decide(account.id, taskId!, action as "approve" | "decline", key)).task;
    await assistant.news(account.id, task.id, `专家在 Studio 里${action === "approve" ? "确认了" : action === "decline" ? "取消了" : "回答了"}这件事。`, action === "answer" ? `answered:${key}` : "decided");
    sendJson(response, 200, { task });
    return;
  }
  const credentialsRoute = url.pathname.match(/^\/v1\/creator\/connections\/([a-z]+)\/credentials$/);
  const kindOfForm = credentialsRoute && isChannelKind(credentialsRoute[1]!) ? credentialsRoute[1] : undefined;
  const form = kindOfForm && CREDENTIAL_FORMS[kindOfForm];
  if (kindOfForm && request.method === "POST" && isPerProduct(form)) {
    const body = await readJson(request);
    const productId = String(body.product_id ?? "");
    if (!context.ownApps || !productId) { sendJson(response, 503, { error: { code: "channel_unavailable", message: `${CHANNEL_LABELS[kindOfForm]} is not available.` } }); return; }
    await context.ownApps.save(account.id, kindOfForm, productId, body);
    sendJson(response, 200, { channels: await channelsView({ kind: "product", productId }) });
    return;
  }
  if (kindOfForm && form && request.method === "POST") {
    if (!context.credentialSeal) { sendJson(response, 503, { error: { code: "channel_unavailable", message: `${CHANNEL_LABELS[kindOfForm]} is not available.` } }); return; }
    const credentials = readCredentials(form, await readJson(request));
    // A tenant of the shared app is served by the shared adapter; an Expert's own app is built from what they typed.
    const adapter = credentials && (isTenantForm(form) ? await channels.hub.get(kindOfForm) : form.build(credentials, account.id));
    if (!credentials || !adapter?.available()) { sendJson(response, 400, { error: { code: "invalid_credentials", message: `${CHANNEL_LABELS[kindOfForm]} credentials are missing or malformed.` } }); return; }
    try { Object.assign(credentials, await form.probe?.(adapter, credentials)); }
    catch (cause) { sendJson(response, 422, { error: { code: `${kindOfForm}_probe_failed`, message: cause instanceof Error ? cause.message : String(cause) } }); return; }
    await channels.connections.saveCredentials(account.id, kindOfForm, context.credentialSeal.seal(credentials), isTenantForm(form) ? String(credentials[form.tenant]) : undefined);
    sendJson(response, 200, { channels: await channelsView() });
    return;
  }
  // Every account binds its chats: the Assistant for Studio, or a Product's Chat when `product_id` names one.
  if (url.pathname === "/v1/creator/connections" && request.method === "GET") {
    sendJson(response, 200, { channels: await channelsView(bindingTarget(url.searchParams.get("product_id"))) }, { "cache-control": "no-store" });
    return;
  }
  const connection = url.pathname.match(/^\/v1\/creator\/connections\/([a-z]+)(\/connect)?$/);
  if (connection && isChannelKind(connection[1]!)) {
    const kind = connection[1];
    if (connection[2] && request.method === "POST") {
      const target = bindingTarget((await readJson(request)).product_id as string | undefined);
      sendJson(response, 200, await channels.connect(account.id, kind, target));
      return;
    }
    if (!connection[2] && request.method === "DELETE") {
      const target = bindingTarget(url.searchParams.get("product_id"));
      if (target.kind === "product" && botKind(kind, target)) await context.ownApps?.remove(account.id, kind, target.productId);
      else await channels.disconnect(account.id, kind, target);
      sendJson(response, 200, { channels: await channelsView(target) });
      return;
    }
  }
  sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
}

/** The API key that made the request in flight, if one did: it makes the Expert's Studio work API usage rather than web usage. */
function apiKeyOfRequest(): { apiKeyId?: string } {
  const id = currentContext()?.api_key_id;
  return id ? { apiKeyId: id } : {};
}
