import { FactoryAgentsService } from "./factoryAgents/service.js";
import { PostgresAgentDefinitionRepository } from "./factoryAgents/definitions.js";
import { PostgresWorkbenchBackend } from "./factoryAgents/store.js";
import { AssistantService } from "./assistant/assistant.js";
import { ConversationRoutes, type ConversationRouteDeps } from "./conversations/routes.js";
import { openConversationPorts, type ConversationPorts } from "./conversations/ports.js";
import { Studio, type StudioDeps } from "./conversations/studio.js";
import { StudioSockets, STUDIO_SOCKET_PATH } from "./conversations/socket.js";
import { createIngestService } from "./ingest/boot.js";
import { IngestError, IngestService } from "./ingest/service.js";
import { publicJob } from "./ingest/job.js";
import { AccountReach, CHANNEL_KINDS, ChannelHub, PostgresChannelLinks, type ChannelKind, type ChannelLinks } from "./assistant/channels.js";
import { safeError } from "./factoryAgents/runtime.js";
import { CredentialSeal } from "./assistant/channelCredentials.js";
import { IMessageChannel } from "./assistant/imessageChannel.js";
import { LarkChannel, type LarkCredentials } from "./assistant/larkChannel.js";
import { LineChannel } from "./assistant/lineChannel.js";
import { TelegramChannel } from "./assistant/telegramChannel.js";
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
import { factoryModelForEnvironment, runFactoryPromptWithPi } from "./creatorLearning/piGateway.js";
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
import { QdrantKnowledgeIndexer } from "./qdrantIndexer.js";
import { flushLangfuseObservability, initializeLangfuseObservability } from "./langfuse.js";
import { accountAvatarApplicationServiceFromEnvironment, MAX_ACCOUNT_AVATAR_BYTES } from "./accountAvatar.js";
import {
  httpRequestLimitOptionsFromEnvironment,
} from "./registryRequestLimits.js";

export type RegistryServer = { server: http.Server; close: () => Promise<void> };
export const CREATOR_FACTORY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;
type RegistryContext = {
  conversationPorts: ConversationPorts;
  assistant?: AssistantService;
  ingest?: IngestService;
  channels?: ChannelHub;
  credentialSeal?: CredentialSeal;
  publicOrigin?: string;
  links?: ChannelLinks;
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
  const factoryAgents = new FactoryAgentsService(path.join(factoryRoot, "agent-chats"), environment, factoryAgentDefinitions);
  const objectStore = objectStoreFromEnvironment(environment);
  const productObjectStore = objectStoreFromEnvironment(environment, path.join(factoryRoot, "product-files"));
  if (!productObjectStore) throw new Error("Product File object storage is not configured");
  const productFileStore = new ProductFileStore(
    productObjectStore,
    environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products"
  );
  const nodeObjectStore = objectStore ?? productObjectStore;
  const knowledgeIndexer = QdrantKnowledgeIndexer.fromEnvironment(environment);
  const nodePool = registryPool;
  const nodePersistence = nodePool ? new PostgresNodeStore({ pool: nodePool }) : undefined;
  const factoryNodeService = nodePersistence && nodeObjectStore
    ? new FactoryNodeService(
      new NodeRuntime({
        sessionStore: nodePersistence,
        executionStore: nodePersistence,
        storage: { objectStore: nodeObjectStore },
        maxRounds: integerEnvironment(environment.HATCH_FACTORY_NODE_MAX_ROUNDS, 10),
        maxAgentTurns: integerEnvironment(environment.HATCH_FACTORY_NODE_MAX_AGENT_TURNS, 16)
      }),
      nodePersistence,
      { objectStore: nodeObjectStore },
      productFileStore,
      environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products"
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
    ? new CorpusPublisher(factoryNodeService, nodeObjectStore, store, releaseStore, environment.HATCH_RUNTIME_CORPUS_ROOT?.trim() || "runtime-corpora", knowledgeIndexer)
    : undefined;
  const productLive = corpusPublisher && nodeObjectStore
    ? createProductLive({ factoryRoot, publisher: corpusPublisher, releases: releaseStore, objectStore: nodeObjectStore })
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
      runFactoryPromptWithPi,
      createHatchCliCandidateExecutor({
        timeoutMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_HATCH_TIMEOUT_MS, 15 * 60_000),
        environment
      }),
      { model: factoryModelForEnvironment(environment), objectStore, graphStore }
    ),
    {
      workerId: `factory-http-${process.pid}-${randomUUID()}`,
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
    (runId) => immediateFactoryWorker.startRun(runId, immediateFactoryStop.signal)
  );
  const publishToken = environment.HATCH_REGISTRY_PUBLISH_SERVICE_TOKEN?.trim() || "";
  const runtimeServiceToken = environment.HATCH_REGISTRY_RUNTIME_SERVICE_TOKEN?.trim() || "";
  const deploymentServiceToken = environment.HATCH_REGISTRY_DEPLOYMENT_SERVICE_TOKEN?.trim() || "";
  const legacyHmacEnabled = environment.HATCH_ENABLE_LEGACY_HMAC_AUTH?.trim().toLowerCase() === "true";
  const authSecret = legacyHmacEnabled ? environment.HATCH_AUTH_SIGNING_SECRET?.trim() || "" : "";
  const httpLimits = httpRequestLimitOptionsFromEnvironment(environment);
  const registryContext: RegistryContext = { store, accounts, accountAvatars, trustedProxies, publishToken, runtimeServiceToken, deploymentServiceToken, factoryService, factoryAgents, factoryAgentDefinitions, productFileStore, factoryNodeService, corpusPublisher, productLive, nodeObjectStore, releaseStore, authSecret, conversationPorts: await openConversationPorts(registryPool) };
  const studioSockets = new StudioSockets({ studio: new Studio(studioDeps(registryContext)), identify: token => identifyToken(registryContext, token) });
  let assistantTick: NodeJS.Timeout | undefined;
  const channelListeners = new AbortController();
  if (registryPool) {
    const reach = new AccountReach(registryPool);
    await reach.ensureSchema();
    await PostgresWorkbenchBackend.ensureSchema(registryPool);
    const tasks = await PostgresTaskRepository.open(registryPool);
    const links = await PostgresChannelLinks.open(registryPool, (accountId, kind) => kind === "lark" ? accountId : "");
    const studioUrl = environment.HATCH_STUDIO_ASSISTANT_URL?.trim() || "https://gethatchapp.com/studio/assistant";
    const telegram = new TelegramChannel({
      token: environment.HATCH_TELEGRAM_BOT_TOKEN?.trim() || undefined,
      username: environment.HATCH_TELEGRAM_BOT_USERNAME?.trim() || undefined,
      webhookSecret: environment.HATCH_TELEGRAM_WEBHOOK_SECRET?.trim() || undefined,
      studioUrl,
    });
    const line = new LineChannel({
      channelSecret: environment.HATCH_LINE_CHANNEL_SECRET?.trim() || undefined,
      accessToken: environment.HATCH_LINE_CHANNEL_ACCESS_TOKEN?.trim() || undefined,
      basicId: environment.HATCH_LINE_BASIC_ID?.trim() || undefined,
      studioUrl,
    });
    const imessage = new IMessageChannel({
      projectId: environment.HATCH_PHOTON_PROJECT_ID?.trim() || undefined,
      projectSecret: environment.HATCH_PHOTON_PROJECT_SECRET?.trim() || undefined,
      address: environment.HATCH_IMESSAGE_ADDRESS?.trim() || undefined,
    });
    // Lark has no shared bot: a custom app works in one enterprise, so each Expert brings theirs.
    const sealKey = environment.HATCH_CREDENTIALS_KEY?.trim();
    const seal = sealKey ? new CredentialSeal(sealKey) : undefined;
    const larkApps = new Map<string, { sealed: string; adapter: LarkChannel }>();
    const channels = new ChannelHub([telegram, line, imessage], async (kind, accountId) => {
      if (kind !== "lark" || !seal) return undefined;
      const sealed = await links.credentials(accountId, "lark");
      if (!sealed) return undefined;
      const cached = larkApps.get(accountId);
      if (cached?.sealed === sealed) return cached.adapter;
      const adapter = new LarkChannel(seal.open<LarkCredentials>(sealed), accountId);
      larkApps.set(accountId, { sealed, adapter });
      return adapter;
    });
    const catalog = registryAgentCatalog(registryContext);
    const assistant = new AssistantService({
      tasks, reach, channels, links,
      products: factoryAgents,
      catalog,
      backend: accountId => new PostgresWorkbenchBackend(registryPool, `assistant:${accountId}`),
      exclusive: postgresExclusive(registryPool),
      env: environment,
    });
    const productsPrefix = environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products";
    const ingest = await createIngestService({
      environment, pool: registryPool, seal, objects: productObjectStore,
      manual: async (accountId, productId) => {
        const { backend } = (await factoryAgents.workspace({ creatorId: accountId, productId }, await catalog.token(accountId))).store;
        return { list: async () => (await backend.listManual()).map(file => file.path), read: name => backend.readManual(name), write: (name, bytes) => backend.writeManual(name, bytes) };
      },
      productPrefix: (accountId, productId) => `${productsPrefix}/${accountId}/${productId}`,
    });
    Object.assign(registryContext, { assistant, ingest, channels, links, reach, credentialSeal: seal, publicOrigin: new URL(studioUrl).origin });
    // A platform that pushes over its own connection runs here, in one process at a time. A dropped connection comes back.
    for (const adapter of channels.listeners()) void (async () => {
      while (!channelListeners.signal.aborted) {
        await postgresExclusive(registryPool)(`assistant-channel:${adapter.kind}`, () => adapter.listen!(events => assistant.channelEvents(adapter, events), channelListeners.signal))
          .catch(error => console.error(`[channel ${adapter.kind}]`, safeError(error)));
        await new Promise(resolve => setTimeout(resolve, 30_000).unref());
      }
    })();
    assistantTick = setInterval(() => void assistant.tick().catch(error => console.error("[assistant tick]", error)), 60_000);
    assistantTick.unref();
  }
  const server = http.createServer((request, response) => {
    void route(request, response, registryContext)
      .catch((error) => {
        const status = errorStatus(error);
        if (status >= 500) console.error("Registry request failed", error);
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
        if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
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
  });
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
      const match = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/factory-agents\/sessions\/([0-9a-f-]{36})\/voice\/live$/);
      if (!match) throw Object.assign(new Error("Unknown WebSocket route"), { status: 404 });
      const token = bearer(request);
      const session = await accounts.resolveSession(token);
      let account = session?.account;
      if (!account) {
        const claims = verifyAuthToken(token, authSecret);
        account = claims ? await accounts.getById(claims.sub) : undefined;
      }
      if (!account) throw Object.assign(new Error("A valid account token is required."), { status: 401 });
      const productId = decodeURIComponent(match[1]!);
      const product = await productForCreator(registryContext, account.id, productId);
      if (!product) throw Object.assign(new Error("Product was not found."), { status: 404 });
      await factoryAgents.handleUpgrade({ creatorId: account.id, productId, briefSpec: product.brief_spec }, token!, request, socket, head);
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
  return { server, close: async () => {
    if (assistantTick) clearInterval(assistantTick);
    channelListeners.abort();
    await registryContext.assistant?.close();
    immediateFactoryStop.abort();
    await factoryAgents.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await factoryRepository.close();
    await store.close();
    await flushLangfuseObservability();
    if (ownsReleasePool) await releasePool?.end();
  } };
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

  if (url.pathname.startsWith("/v1/channels/") || url.pathname.startsWith("/v1/creator/assistant")) {
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
        throw new CorpusPublishError("corpus_required", "Agent Generation must submit its System, Skills and Knowledge as corpus.", 422);
      }
      // Only this authenticated Product's real uploaded files can be Knowledge.
      // Publication never runs a Factory Node or selects an older generated candidate.
      const files = await context.productFileStore.listFiles(account.id, productId);
      result = await context.corpusPublisher.publishUploaded({
        ...publishInput,
        corpus: body.corpus,
        sourceFiles: files.map(file => file.projection.contentRef),
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
  // Agent Builder workspace. Only SYSTEM.md is required; Knowledge stays empty.
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
      await context.store.checkReady();
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
    let updated: Account;
    try {
      updated = await context.accounts.setDisplayName(account.id, String(body.display_name ?? ""));
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
      sendAuthJson(response, 200, { ...accountPublic(session.account), session_expires_at: session.session.absolute_expires_at });
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
      const execution = await context.factoryNodeService.getExecution(productId, node, executionId);
      if (!execution) { sendJson(response, 404, { error: { code: "execution_not_found", message: "Node execution was not found." } }); return; }
      sendJson(response, 200, publicFactoryNodeExecution(execution));
      return;
    }
    if (request.method === "GET" && !executionId && !isAnswers) {
      const execution = await context.factoryNodeService.getLatestExecution(productId, node);
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
        product: nodeProduct,
        ...(fileIds === undefined ? {} : { fileIds }),
        ...(filePaths === undefined ? {} : { filePaths }),
        ...(requestedExecutionId === undefined ? {} : { executionId: requestedExecutionId })
      })
      : await context.factoryNodeService.startCorpus({
        creatorId: account.id,
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
      creator: account
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
      const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
      await context.ingest.submit(account.id, productId, body.items, body.context).then(
        job => sendJson(response, 202, { job: publicJob(job) }),
        error => {
          if (!(error instanceof IngestError)) throw error;
          sendJson(response, error.status, { error: { code: error.code, message: error.message }, detail: error.message });
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

  const productFilesMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/files(?:\/([^/]+))?$/);
  if (productFilesMatch) {
    const account = await authenticate(request, response, context);
    if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
    const productId = decodeURIComponent(productFilesMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }

    if (productFilesMatch) {
      const fileId = productFilesMatch[2] ? decodeURIComponent(productFilesMatch[2]) : undefined;
      if (request.method === "GET" && !fileId) {
        const files = await context.productFileStore.listFiles(account.id, productId);
        sendJson(response, 200, { product_id: productId, files: files.map((file) => publicProductFile(file)) });
        return;
      }
      if (request.method === "GET" && fileId) {
        const file = await context.productFileStore.getFile(account.id, productId, fileId);
        sendJson(response, 200, publicProductFile(file, url.searchParams.get("include_content") === "true"));
        return;
      }
      if (request.method === "POST" && !fileId) {
        const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
        const encoded = typeof body.content_base64 === "string" ? body.content_base64 : "";
        if (!encoded) throw new ProductFilesError("invalid_product_file", "content_base64 is required");
        const bytes = decodeProductBase64(encoded);
        const suppliedDigest = typeof body.sha256 === "string" ? body.sha256.trim().toLowerCase() : undefined;
        const actualDigest = sha256Bytes(bytes);
        if (suppliedDigest && suppliedDigest.replace(/^sha256:/, "") !== actualDigest) {
          sendJson(response, 422, { error: { code: "digest_mismatch", message: "Uploaded content does not match sha256." } });
          return;
        }
        const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
          ? body.metadata as Record<string, unknown>
          : {};
        const file = await context.productFileStore.createFromUpload({
          creatorId: account.id,
          productId,
          displayName: String(body.display_name ?? body.file_name ?? ""),
          mediaType: typeof body.media_type === "string" ? body.media_type : undefined,
          bytes,
          idempotencyKey: request.headers["idempotency-key"]?.toString(),
          metadata: {
            ...metadata,
            ...(body.source_kind !== undefined ? { source_kind: body.source_kind } : {}),
            ...(body.source_ref !== undefined ? { source_ref: body.source_ref } : {}),
            ...(body.source_url !== undefined ? { source_url: body.source_url } : {}),
            ...(body.provenance !== undefined ? { provenance: body.provenance } : {}),
            ...(body.selection_reason !== undefined ? { selection_reason: body.selection_reason } : {}),
            ...(body.creator_approved !== undefined ? { creator_approved: body.creator_approved } : {})
          }
        });
        sendJson(response, 201, publicProductFile(file), {
          "idempotency-key": request.headers["idempotency-key"]?.toString() ?? ""
        });
        return;
      }
    }

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

async function authenticate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): Promise<Account | undefined> {
  const session = await context.accounts.resolveSession(bearer(request));
  if (session) return session.account;
  const claims = verifyAuthToken(bearer(request), context.authSecret);
  if (!claims) return undefined;
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

function publicProductFile(file: ProductFileView, includeContent = false): Record<string, unknown> {
  const projection = {
    kind: file.projection.kind,
    media_type: file.projection.mediaType,
    sha256: file.projection.sha256,
    bytes: file.projection.bytes,
    ...(includeContent && file.projectionContent !== undefined ? { content: file.projectionContent } : {}),
    ...(includeContent && file.projectionBase64 !== undefined ? { base64: file.projectionBase64 } : {})
  };
  return {
    id: file.id,
    artifact_id: file.artifactId,
    product_id: file.productId,
    // This is the canonical input path for Node manifests. Callers must use
    // it as returned; they must not reconstruct an OSS key from file.id.
    path: file.projection.contentRef,
    display_name: file.displayName,
    media_type: file.mediaType,
    sha256: file.originalSha256,
    bytes: file.originalBytes,
    projection,
    metadata: file.metadata,
    created_at: file.createdAt,
    updated_at: file.updatedAt
  };
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

function decodeProductBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new ProductFilesError("invalid_product_file", "content_base64 is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > 20 * 1024 * 1024) {
    throw new ProductFilesError("invalid_product_file", "Uploaded file is empty or too large");
  }
  return bytes;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    display_name_too_long: "Display name must not exceed 128 characters."
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
  response.end(JSON.stringify(payload));
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
  createRegistryServerFromEnvironment().then(({ server }) => {
    console.log(`Hatch TypeScript Registry listening on ${JSON.stringify(server.address())}`);
  }).catch((error) => { console.error(error); process.exitCode = 1; });
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
      return context.productLive.status(new ExpertProduct(accountId, productId, product.name, product.promise, product.brief_spec));
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
    assistant: () => context.assistant,
    ...context.conversationPorts,
  };
}

function conversationDeps(response: http.ServerResponse, context: RegistryContext): ConversationRouteDeps {
  return {
    ...studioDeps(context),
    authenticate: request => authenticate(request, response, context),
    token: bearer,
    json: sendJson,
    readJson: request => readJson(request),
  };
}

/** The account a token belongs to, for the Studio WebSocket's first-message sign-in. */
async function identifyToken(context: RegistryContext, token: string): Promise<{ accountId: string; token: string } | undefined> {
  const claims = verifyAuthToken(token, context.authSecret);
  const account = (await context.accounts.resolveSession(token))?.account ?? (claims ? await context.accounts.getById(claims.sub) : undefined);
  return account ? { accountId: account.id, token } : undefined;
}

async function assistantRoute(request: http.IncomingMessage, response: http.ServerResponse, url: URL, context: RegistryContext): Promise<void> {
  const assistant = context.assistant;
  if (!assistant || !context.reach) { sendJson(response, 503, { error: { code: "assistant_unavailable", message: "The Assistant requires the Registry database." } }); return; }
  const webhook = url.pathname.match(/^\/v1\/channels\/([a-z]+)(?:\/([0-9a-f-]{36}))?\/webhook$/);
  if (webhook && request.method === "POST") {
    const kind = webhook[1] as ChannelKind;
    const adapter = (CHANNEL_KINDS as readonly string[]).includes(kind) ? await context.channels!.get(kind, webhook[2]) : undefined;
    if (!adapter?.parse) { sendJson(response, 404, { ok: false }); return; }
    const raw = await readRawBody(request, 2 * 1024 * 1024);
    if (!adapter.verify?.(raw, request.headers)) { sendJson(response, 401, { ok: false }); return; }
    const { events, respond } = adapter.parse(raw);
    // Platforms retry a slow webhook. Quick work is durable before we answer; a slow download finishes after.
    const work = assistant.channelEvents(adapter, events);
    await Promise.race([work, new Promise(resolve => setTimeout(resolve, 1500))]);
    sendJson(response, 200, respond ?? { ok: true });
    return;
  }
  const account = await authenticate(request, response, context);
  if (!account) { sendJson(response, 401, { detail: "A valid account token is required." }); return; }
  const channelsView = async () => {
    const links = await context.links!.list(account.id);
    return Promise.all(CHANNEL_KINDS.map(async kind => {
      const link = links.find(candidate => candidate.kind === kind);
      const ownApp = kind === "lark" && Boolean(context.credentialSeal);
      return {
        kind, available: Boolean(await context.channels!.get(kind, account.id)), linked: Boolean(link?.peerId),
        ...(ownApp ? { own_app: true, webhook_url: `${context.publicOrigin}/v1/channels/lark/${account.id}/webhook` } : {}),
        ...(link?.lastEventAt ? { last_event_at: link.lastEventAt } : {}),
      };
    }));
  };
  if (url.pathname === "/v1/creator/assistant" && request.method === "GET") {
    const timezone = url.searchParams.get("tz");
    if (timezone) await context.reach.setTimezone(account.id, timezone);
    sendJson(response, 200, { ...await assistant.view(account.id), channels: await channelsView() }, { "cache-control": "no-store" });
    return;
  }
  if (url.pathname === "/v1/creator/assistant/messages" && request.method === "POST") {
    const body = await readJson(request);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 20_000) { sendJson(response, 400, { error: { code: "invalid_message", message: "Message must contain 1–20000 characters." } }); return; }
    await assistant.ingest(account.id, { source: "web", text: content });
    sendJson(response, 202, { accepted: true });
    return;
  }
  if (url.pathname === "/v1/creator/assistant/files" && request.method === "POST") {
    const body = await readJson(request, CREATOR_FACTORY_JSON_BODY_MAX_BYTES);
    const name = typeof body.name === "string" ? body.name : ""; const bytes = Buffer.from(typeof body.base64 === "string" ? body.base64 : "", "base64");
    if (!name || !bytes.length || bytes.length > 20 * 1024 * 1024) { sendJson(response, 400, { error: { code: "invalid_file", message: "A file of 1 byte to 20 MiB is required." } }); return; }
    sendJson(response, 201, await assistant.receiveFile(account.id, name, bytes, "web"));
    return;
  }
  const imageMatch = url.pathname.match(/^\/v1\/creator\/assistant\/images\/([0-9a-f-]{36}\.(?:jpg|jpeg|png|webp|gif))$/);
  if (imageMatch && request.method === "GET") {
    const bytes = await assistant.image(account.id, imageMatch[1]!).catch(() => undefined);
    if (!bytes) { sendJson(response, 404, { error: { code: "image_not_found", message: "Image was not found." } }); return; }
    response.writeHead(200, { "content-type": imageMime(imageMatch[1]!)!, "content-length": bytes.length, "cache-control": "private, max-age=86400" });
    response.end(bytes);
    return;
  }
  if (url.pathname === "/v1/creator/assistant/events" && request.method === "GET") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    response.write(": connected\n\n");
    const listener = (event: { accountId?: string }) => { if (event.accountId === account.id && !response.writableEnded) response.write(`data: ${JSON.stringify({ ...event, accountId: undefined })}\n\n`); };
    assistant.events.on("event", listener);
    const heartbeat = setInterval(() => { if (!response.writableEnded) response.write(": heartbeat\n\n"); }, 15_000);
    await new Promise<void>(resolve => response.once("close", () => resolve()));
    clearInterval(heartbeat);
    assistant.events.off("event", listener);
    return;
  }
  const taskAction = url.pathname.match(/^\/v1\/creator\/assistant\/tasks\/([0-9a-f-]{36})\/(approve|decline|answer)$/);
  if (taskAction && request.method === "POST") {
    const [, taskId, action] = taskAction;
    const body = await readJson(request);
    const task = action === "approve" ? await assistant.approve(account.id, taskId!)
      : action === "decline" ? await assistant.decline(account.id, taskId!)
        : await assistant.answer(account.id, taskId!, String(body.answer ?? "").trim() || (() => { throw Object.assign(new Error("answer is required"), { status: 400 }); })());
    await assistant.ingest(account.id, { source: "task", taskId: task.id, text: `专家在 Studio 里${action === "approve" ? "确认了" : action === "decline" ? "取消了" : "回答了"}这件事。` });
    sendJson(response, 200, { task });
    return;
  }
  if (url.pathname === "/v1/creator/assistant/channels/lark/credentials" && request.method === "POST") {
    if (!context.credentialSeal) { sendJson(response, 503, { error: { code: "channel_unavailable", message: "Lark is not available." } }); return; }
    const body = await readJson(request);
    const text = (name: string) => typeof body[name] === "string" ? (body[name] as string).trim() : "";
    const credentials: LarkCredentials = { domain: body.domain === "feishu" ? "feishu" : "lark", appId: text("app_id"), appSecret: text("app_secret"), verificationToken: text("verification_token"), ...(text("encrypt_key") ? { encryptKey: text("encrypt_key") } : {}) };
    if (!credentials.appId || !credentials.appSecret || !credentials.verificationToken) { sendJson(response, 400, { error: { code: "invalid_credentials", message: "App ID, App Secret and Verification Token are required." } }); return; }
    try { await new LarkChannel(credentials, account.id).probe(); }
    catch (cause) { sendJson(response, 422, { error: { code: "lark_probe_failed", message: cause instanceof Error ? cause.message : String(cause) } }); return; }
    await context.links!.saveCredentials(account.id, "lark", context.credentialSeal.seal(credentials));
    sendJson(response, 200, { channels: await channelsView() });
    return;
  }
  const channelRoute = url.pathname.match(/^\/v1\/creator\/assistant\/channels\/([a-z]+)(\/connect)?$/);
  if (channelRoute && (CHANNEL_KINDS as readonly string[]).includes(channelRoute[1]!)) {
    const kind = channelRoute[1] as ChannelKind;
    if (channelRoute[2] && request.method === "POST") { sendJson(response, 200, await assistant.connectChannel(account.id, kind)); return; }
    if (!channelRoute[2] && request.method === "DELETE") { await context.links!.unlink(account.id, kind); sendJson(response, 200, { channels: await channelsView() }); return; }
  }
  sendJson(response, 404, { error: { code: "not_found", message: "Route not found." } });
}
