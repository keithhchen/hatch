import "dotenv/config";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { URL } from "node:url";
import {
  AuthRateLimiter,
  TrustedProxyPolicy,
  authRateLimitOptionsFromEnvironment,
  authRequestSourceIp,
  authTrustedProxyPolicyFromEnvironment
} from "./authRateLimit.js";
import {
  AccountStoreTs,
  PasswordHasher,
  PasswordWorkCapacityError,
  accountPublic,
  normalizeAccountIdentity,
  passwordWorkOptionsFromEnvironment,
  validateSigninCredentials,
  validateSignupCredentials,
  verifyAuthToken,
  type Account,
  type AccountRole
} from "./registryAuth.js";
import { RegistryStoreTs } from "./registryStore.js";
import { RegistryDeploymentConflictError } from "./registryStore.js";
import { BriefValidationError, normalizeBriefSpec, type BriefSpec } from "./brief.js";
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
import { CreatorRegistryReleaseStore, type CreatorRegistryRelease } from "./creatorLearning/creatorRegistryRelease.js";
import { QdrantKnowledgeIndexer } from "./qdrantIndexer.js";
import {
  HttpRequestGate,
  PublishWorkGate,
  SessionQueryGate,
  httpRequestLimitOptionsFromEnvironment,
  publishWorkLimitOptionsFromEnvironment,
  sessionQueryLimitOptionsFromEnvironment,
  type GateLease,
} from "./registryRequestLimits.js";

export type RegistryServer = { server: http.Server; close: () => Promise<void> };
export const CREATOR_FACTORY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;
type RegistryContext = {
  store: RegistryStoreTs;
  accounts: AccountStoreTs;
  authRateLimiter: AuthRateLimiter;
  sessionQueryGate: SessionQueryGate;
  publishWorkGate: PublishWorkGate;
  trustedProxies: TrustedProxyPolicy;
  publishToken: string;
  runtimeServiceToken: string;
  deploymentServiceToken: string;
  factoryService: CreatorFactoryService;
  productFileStore: ProductFileStore;
  factoryNodeService?: FactoryNodeService;
  corpusPublisher?: CorpusPublisher;
  nodeObjectStore?: ReturnType<typeof objectStoreFromEnvironment>;
  releaseStore: CreatorRegistryReleaseStore;
  authSecret: string;
};

export async function createRegistryServerFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<RegistryServer> {
  const authRateLimitOptions = authRateLimitOptionsFromEnvironment(environment);
  const passwordWorkOptions = passwordWorkOptionsFromEnvironment(environment);
  const trustedProxies = authTrustedProxyPolicyFromEnvironment(environment);
  const store = await RegistryStoreTs.open({ environment });
  const accounts = new AccountStoreTs(store.databasePool(), new PasswordHasher(passwordWorkOptions));
  await accounts.ensureSchema();
  const factoryRepository = creatorFactoryRepositoryForRegistry(environment, store.databasePool());
  await factoryRepository.initialize();
  const factoryRoot = path.resolve(environment.HATCH_CREATOR_FACTORY_ROOT ?? "creator-factory-runs");
  const objectStore = objectStoreFromEnvironment(environment);
  const productObjectStore = objectStoreFromEnvironment(environment, path.join(factoryRoot, "product-files"));
  if (!productObjectStore) throw new Error("Product File object storage is not configured");
  const productFileStore = new ProductFileStore(
    productObjectStore,
    environment.HATCH_CREATOR_PRODUCT_FILES_PREFIX?.trim() || "creator-products"
  );
  const nodeObjectStore = objectStore ?? productObjectStore;
  const knowledgeIndexer = QdrantKnowledgeIndexer.fromEnvironment(environment);
  const nodePool = store.databasePool();
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
  const corpusPublisher = factoryNodeService && nodeObjectStore
    ? new CorpusPublisher(factoryNodeService, nodeObjectStore, store, releaseStore, environment.HATCH_RUNTIME_CORPUS_ROOT?.trim() || "runtime-corpora", knowledgeIndexer)
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
  const authRateLimiter = new AuthRateLimiter(authRateLimitOptions);
  const sessionQueryGate = new SessionQueryGate(sessionQueryLimitOptionsFromEnvironment(environment));
  const publishWorkGate = new PublishWorkGate(publishWorkLimitOptionsFromEnvironment(environment));
  const httpLimits = httpRequestLimitOptionsFromEnvironment(environment);
  const httpRequestGate = new HttpRequestGate(httpLimits);
  const server = http.createServer((request, response) => {
    const suppliedBearer = bearer(request);
    const internalRuntime = Boolean(
      (runtimeServiceToken && request.headers["x-hatch-runtime-service-token"] === runtimeServiceToken)
      || (runtimeServiceToken && suppliedBearer === runtimeServiceToken)
      || (publishToken && suppliedBearer === publishToken)
    );
    const admission = httpRequestGate.begin(
      authRequestSourceIp(request, trustedProxies),
      !internalRuntime,
    );
    if (!admission.allowed) {
      request.resume();
      response.once("finish", () => request.destroy());
      sendJson(response, admission.reason === "source_capacity" ? 429 : 503, {
        detail: "Registry is temporarily busy. Try again shortly.",
      }, { "retry-after": String(admission.retryAfterSeconds), connection: "close" });
      return;
    }
    const routePromise = route(request, response, { store, accounts, authRateLimiter, sessionQueryGate, publishWorkGate, trustedProxies, publishToken, runtimeServiceToken, deploymentServiceToken, factoryService, productFileStore, factoryNodeService, corpusPublisher, nodeObjectStore, releaseStore, authSecret })
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
        sendJson(response, status, {
          detail: status >= 500
            ? "Registry request failed."
            : error instanceof SyntaxError
              ? "Request body must be valid JSON."
              : error instanceof Error ? error.message : String(error)
        });
      });
    holdAdmissionUntilRequestAndRouteSettle(request, response, routePromise, admission);
  });
  server.maxConnections = httpLimits.maxConnections;
  server.headersTimeout = httpLimits.headersTimeoutMs;
  server.requestTimeout = httpLimits.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  const port = Number(environment.REGISTRY_PORT ?? 8100);
  const host = environment.REGISTRY_HOST ?? "127.0.0.1";
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return { server, close: async () => {
    immediateFactoryStop.abort();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await factoryRepository.close();
    await store.close();
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

  const registryPublishMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/registry$/);
  if (registryPublishMatch && request.method === "POST") {
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
    if (!context.corpusPublisher || !context.factoryNodeService) {
      sendJson(response, 503, { error: { code: "publish_unavailable", message: "Corpus Publisher is unavailable." } });
      return;
    }
    const productId = decodeURIComponent(registryPublishMatch[1]!);
    const product = await productForCreator(context, account.id, productId);
    if (!product) { sendJson(response, 404, { error: { code: "product_not_found", message: "Product was not found." } }); return; }
    const body = await readJson(request);
    let result: Awaited<ReturnType<CorpusPublisher["publishLatest"]>>;
    try {
      result = await context.corpusPublisher.publishLatest({
        creatorId: account.id,
        productId,
        productName: product.name,
        productPromise: product.promise,
        briefSpec: body.brief_spec ?? product.brief_spec
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
      execution_id: result.execution_id,
      corpus_ref: result.output_ref,
      corpus_digest: result.corpus_digest,
      release_digest: result.release.release_digest,
      status: "published",
      published_at: result.published.published_at
    });
    return;
  }

  const runtimeReleaseMatch = url.pathname.match(/^\/v1\/runtime\/products\/([^/]+)\/release$/);
  if (runtimeReleaseMatch && request.method === "GET") {
    requireRuntimeServiceAuth(request, context.runtimeServiceToken);
    const productId = decodeURIComponent(runtimeReleaseMatch[1]!);
    const release = await context.releaseStore.getLive(productId);
    if (!release) { sendJson(response, 404, { detail: "No live release exists for this Product." }); return; }
    sendJson(response, 200, {
      release,
      runtime_manifest_ref: release.runtime_manifest_ref
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
    if (!beginAuthSourceAttempt(request, response, context)) return;
    const body = await readJson(request);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    const role = body.role as AccountRole;
    const displayName = String(body.display_name ?? "");
    let identity = normalizeAccountIdentity(email);
    const attempt = context.authRateLimiter.checkIdentity("signup", identity);
    try {
      identity = validateSignupCredentials(email, password, role, displayName).email;
    } catch (error) {
      const failure = context.authRateLimiter.recordFailure("signup", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendAuthInputError(response, error);
      return;
    }
    let account: Account;
    try {
      account = await context.accounts.create(email, password, role, displayName);
    } catch (error) {
      if (error instanceof PasswordWorkCapacityError) {
        sendAuthBusy(response);
        return;
      }
      const failure = context.authRateLimiter.recordFailure("signup", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendError(response, error, { email_already_registered: [409, "Email is already registered."] });
      return;
    }
    context.authRateLimiter.recordSuccess("signup", identity);
    sendAuthJson(response, 201, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/signin" && request.method === "POST") {
    if (!beginAuthSourceAttempt(request, response, context)) return;
    const body = await readJson(request);
    const email = String(body.email ?? "");
    const password = String(body.password ?? "");
    let identity = normalizeAccountIdentity(email);
    const attempt = context.authRateLimiter.checkIdentity("signin", identity);
    try {
      identity = validateSigninCredentials(email, password);
    } catch (error) {
      const failure = context.authRateLimiter.recordFailure("signin", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendAuthInputError(response, error);
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
      const failure = context.authRateLimiter.recordFailure("signin", identity);
      if (attempt.identityLimited) sendRateLimited(response, attempt.retryAfterSeconds);
      else if (failure.limited) sendRateLimited(response, failure.retryAfterSeconds);
      else sendAuthJson(response, 401, { detail: "Email or password is incorrect." });
      return;
    }
    context.authRateLimiter.recordSuccess("signin", identity);
    sendAuthJson(response, 200, sessionResponse(account, await context.accounts.createSession(account)));
    return;
  }
  if (url.pathname === "/v1/auth/me" && request.method === "GET") {
    const lease = beginSessionQuery(request, response, context);
    if (!lease) return;
    try {
      const token = bearer(request);
      const session = await context.accounts.resolveSession(token);
      if (session) {
        sendAuthJson(response, 200, { ...accountPublic(session.account), session_expires_at: session.session.absolute_expires_at });
        return;
      }
      const account = await authenticateLegacy(token, context.accounts, context.authSecret);
      if (!account) { sendAuthJson(response, 401, { detail: "A valid account token is required." }); return; }
      sendAuthJson(response, 200, accountPublic(account));
    } finally {
      lease.release();
    }
    return;
  }
  if (url.pathname === "/v1/auth/logout" && request.method === "POST") {
    const lease = beginSessionQuery(request, response, context);
    if (!lease) return;
    try {
      await context.accounts.revokeSession(bearer(request));
      response.writeHead(204, { ...corsHeaders(), "cache-control": "no-store" });
      response.end();
    } finally {
      lease.release();
    }
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
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
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
        sendJson(response, 404, { error: { code: "execution_not_found", message: "Creator answers belong to an About You execution." } });
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
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
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
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
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
      sendJson(response, 200, { products });
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
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
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
      const deleteProduct = (context.factoryService as unknown as {
        deleteProduct?: (creatorId: string, productId: string) => Promise<unknown>;
      }).deleteProduct;
      if (!deleteProduct) throw new Error("Product deletion is not configured");
      await deleteProduct(account.id, product.repositoryId);
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
        ...(product.release ? { release: product.release } : {}),
        ...(product.createdAt ? { created_at: product.createdAt } : {}),
        ...(product.updatedAt ? { updated_at: product.updatedAt } : {})
      }
    });
    return;
  }

  const productBriefSpecMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/brief-spec$/);
  if (productBriefSpecMatch && request.method === "PUT") {
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
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

  const productFilesMatch = url.pathname.match(/^\/v1\/creator\/products\/([^/]+)\/files(?:\/([^/]+))?$/);
  if (productFilesMatch) {
    const account = await authenticate(request, response, context, "creator");
    if (account === SESSION_QUERY_REJECTED) return;
    if (!account) { sendJson(response, 401, { detail: "A valid Creator account token is required." }); return; }
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
    const rows = await context.releaseStore.listPublic({ limit: limit + 1, offset });
    const page = rows.slice(0, limit);
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
    const rows = await context.releaseStore.listPublic({ limit: Math.min(20_001, offset + limit + 1), offset: 0 });
    const creators = new Map<string, { id: string; name: string; product_count: number }>();
    for (const row of rows) {
      const current = creators.get(row.creator_id) ?? { id: row.creator_id, name: row.creator_name, product_count: 0 };
      current.product_count += 1;
      creators.set(row.creator_id, current);
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
    const row = await context.releaseStore.getPublic(productId);
    if (!row) { sendJson(response, 404, { detail: "Product not found." }); return; }
    sendJson(response, 200, publicProductRow(row));
    return;
  }

  const publicCreatorMatch = url.pathname.match(/^\/v1\/public\/creators\/([^/]+)$/);
  if (publicCreatorMatch && request.method === "GET") {
    const creatorId = decodeURIComponent(publicCreatorMatch[1]!);
    if (!isUuidV4(creatorId)) { sendJson(response, 404, { detail: "Creator not found." }); return; }
    const rows = (await context.releaseStore.listPublic({ limit: 20_001, offset: 0 }))
      .filter((row) => row.creator_id === creatorId);
    if (!rows.length) { sendJson(response, 404, { detail: "Creator not found." }); return; }
    sendJson(response, 200, { creator: { id: creatorId, name: rows[0]!.creator_name }, products: rows.map(publicProductRow) });
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
      const connection = await context.store.resolveCreatorToolConnection({
        tenantId,
        agentId: decodeURIComponent(runtimeToolMatch[2]!),
        toolId: decodeURIComponent(runtimeToolMatch[3]!)
      });
      sendJson(response, 200, { id: connection.id, tenant_id: connection.tenant_id, kind: connection.kind, secret_ref: connection.secret_ref, secret: connection.secret, config: connection.config, status: connection.status });
    } catch (error) {
      sendJson(response, 404, { detail: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  sendJson(response, 404, { detail: "Route not found." });
}

const SESSION_QUERY_REJECTED = Symbol("session-query-rejected");

async function authenticate(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
  role?: AccountRole,
): Promise<Account | undefined | typeof SESSION_QUERY_REJECTED> {
  const lease = beginSessionQuery(request, response, context);
  if (!lease) return SESSION_QUERY_REJECTED;
  try {
    const session = await context.accounts.resolveSession(bearer(request));
    if (session && (!role || session.account.role === role)) return session.account;
    const claims = verifyAuthToken(bearer(request), context.authSecret);
    if (!claims || (role && claims.role !== role)) return undefined;
    return context.accounts.getById(claims.sub);
  } finally {
    lease.release();
  }
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

function publicProductRow(row: Record<string, unknown>): Record<string, unknown> {
  const { agent_id: _internalProductAlias, creator_slug: _creatorSlug, product_slug: _productSlug, ...publicRow } = row;
  const promise = publicRow.product_promise ?? publicRow.product_description ?? "";
  const productId = String(publicRow.product_id ?? "");
  return {
    ...publicRow,
    creator: { id: publicRow.creator_id, name: publicRow.creator_name },
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
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      ...(release ? { release } : {}),
      repositoryId: product.id
    };
  }
  const published = (await context.store.listAgentCorpora(creatorId)).find((entry) => String(entry.product_id ?? entry.agent_id ?? "") === productId);
  if (!published) return undefined;
  return {
    productId,
    name: String(published.product_name ?? (published as Record<string, unknown>).name ?? productId),
    promise: String(published.product_promise ?? published.product_description ?? ""),
    status: String(published.status ?? "published"),
    ...(published.brief_spec ? { brief_spec: published.brief_spec } : {}),
    ...(published.published_at ? { createdAt: String(published.published_at) } : {})
  };
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
}): Record<string, unknown> {
  return {
    product_id: publicProductId(product),
    name: product.name,
    promise: publicProductPromise(product),
    status: product.status === "active" ? "draft" : product.status ?? "draft",
    ...(product.briefSpec ? { brief_spec: product.briefSpec } : {}),
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

function holdAdmissionUntilRequestAndRouteSettle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  routePromise: Promise<void>,
  lease: GateLease,
): void {
  let routeSettled = false;
  let requestSettled = request.complete || request.readableEnded || request.destroyed;
  let released = false;
  const releaseIfDone = () => {
    if (released || !routeSettled || !requestSettled) return;
    released = true;
    lease.release();
  };
  const settleRequest = () => {
    requestSettled = true;
    releaseIfDone();
  };
  request.once("end", settleRequest);
  request.once("aborted", settleRequest);
  request.once("close", settleRequest);
  response.once("finish", () => {
    // If a route rejected before consuming a POST body, close that connection
    // after the response instead of letting an untracked slow upload linger.
    if (!request.complete && !request.destroyed) request.destroy();
  });
  const settleRoute = () => {
    routeSettled = true;
    releaseIfDone();
  };
  void routePromise.then(settleRoute, settleRoute);
}

function beginSessionQuery(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): GateLease | undefined {
  const internalRuntime = context.runtimeServiceToken
    && request.headers["x-hatch-runtime-service-token"] === context.runtimeServiceToken;
  const decision = context.sessionQueryGate.begin(
    authRequestSourceIp(request, context.trustedProxies),
    !internalRuntime,
  );
  if (decision.allowed) return decision;
  if (decision.reason === "global_capacity") {
    sendAuthJson(response, 503, { detail: "Authentication is temporarily busy. Try again shortly." }, {
      "retry-after": String(decision.retryAfterSeconds),
    });
  } else {
    sendAuthJson(response, 429, { detail: "Too many session checks. Try again later." }, {
      "retry-after": String(decision.retryAfterSeconds),
    });
  }
  return undefined;
}

function beginPublishWork(
  response: http.ServerResponse,
  context: RegistryContext,
  publisher: string,
  enforceRate = true,
): GateLease | undefined {
  const decision = context.publishWorkGate.begin(publisher, enforceRate);
  if (decision.allowed) return decision;
  const publisherLimited = decision.reason === "publisher_capacity" || decision.reason === "publisher_rate";
  sendJson(
    response,
    publisherLimited ? 429 : 503,
    { detail: "Agent Corpus publishing is temporarily busy. Try again shortly." },
    { "retry-after": String(decision.retryAfterSeconds) },
  );
  return undefined;
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return (error as { status: number }).status;
  }
  if (error instanceof SyntaxError) return 400;
  if (error instanceof Error && error.message === "Request body is too large") return 413;
  if (error instanceof BriefValidationError) return 422;
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

async function readJson(request: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const payload = JSON.parse(Buffer.from(await readBytes(request, maxBytes)).toString("utf8")) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON body must be an object");
  return payload as Record<string, unknown>;
}

function beginAuthSourceAttempt(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  context: RegistryContext,
): boolean {
  const decision = context.authRateLimiter.beginSourceAttempt(
    authRequestSourceIp(request, context.trustedProxies),
  );
  if (decision.allowed) return true;
  sendRateLimited(response, decision.retryAfterSeconds);
  return false;
}

function sendRateLimited(response: http.ServerResponse, retryAfterSeconds: number): void {
  sendAuthJson(response, 429, { detail: "Too many authentication attempts. Try again later." }, {
    "retry-after": String(retryAfterSeconds)
  });
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
    role_invalid: "Account role must be user or creator.",
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
